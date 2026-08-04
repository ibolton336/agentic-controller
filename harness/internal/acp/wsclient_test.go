package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// demuxServer is a scripted fake goose: it reads frames, records them,
// and lets the test push frames to the client at will.
type demuxServer struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	conn     *websocket.Conn
	inbound  chan map[string]any
	upgraded chan struct{}
}

func newDemuxServer(t *testing.T) *demuxServer {
	s := &demuxServer{t: t, inbound: make(chan map[string]any, 32), upgraded: make(chan struct{})}
	upgrader := websocket.Upgrader{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		s.mu.Lock()
		s.conn = conn
		s.mu.Unlock()
		close(s.upgraded)
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]any
			if err := json.Unmarshal(data, &m); err != nil {
				t.Errorf("server unmarshal: %v", err)
				continue
			}
			s.inbound <- m
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *demuxServer) push(frame string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.conn.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
		s.t.Errorf("server write: %v", err)
	}
}

// next returns the next client frame, failing the test on timeout.
func (s *demuxServer) next() map[string]any {
	select {
	case m := <-s.inbound:
		return m
	case <-time.After(5 * time.Second):
		s.t.Fatalf("timed out waiting for a client frame")
		return nil
	}
}

func (s *demuxServer) dial(t *testing.T) *WSClient {
	u, err := url.Parse(s.srv.URL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	host := u.Hostname()
	port, _ := strconv.Atoi(u.Port())
	c, err := NewWSClient(host, port, "test-key")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	<-s.upgraded
	return c
}

// TestCallDuringPrompt proves the demux lets a Call run concurrently with
// an in-flight SendPrompt: the response routes by id to the right waiter
// and notifications reach the prompt loop. Run with -race.
func TestCallDuringPrompt(t *testing.T) {
	s := newDemuxServer(t)
	c := s.dial(t)
	sc := NewSessionClient(c)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	type promptOut struct {
		res *PromptResult
		err error
	}
	promptDone := make(chan promptOut, 1)
	go func() {
		res, err := sc.SendPrompt(ctx, "s1", []ContentBlock{{Type: "text", Text: "go"}}, 0)
		promptDone <- promptOut{res, err}
	}()

	promptReq := s.next()
	if promptReq["method"] != "session/prompt" {
		t.Fatalf("expected session/prompt first, got %v", promptReq["method"])
	}
	promptID := int64(promptReq["id"].(float64))

	// Stream a chunk while the prompt is parked.
	s.push(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello "}}}}`)

	// Concurrent client call while the prompt is still in flight.
	callDone := make(chan error, 1)
	go func() {
		result, _, err := c.Call(ctx, "session/list", nil)
		if err == nil && !strings.Contains(string(result), "sessions") {
			err = fmt.Errorf("unexpected call result %s", result)
		}
		callDone <- err
	}()

	listReq := s.next()
	if listReq["method"] != "session/list" {
		t.Fatalf("expected session/list, got %v", listReq["method"])
	}
	listID := int64(listReq["id"].(float64))

	// Answer out of order: unmatched-id noise first (must be dropped
	// loudly, not misrouted), then the list response, another chunk,
	// then the prompt result.
	s.push(`{"jsonrpc":"2.0","id":99999,"result":{"stray":true}}`)
	s.push(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{"sessions":[]}}`, listID))
	s.push(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"world"}}}}`)
	s.push(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{"stopReason":"end_turn"}}`, promptID))

	if err := <-callDone; err != nil {
		t.Fatalf("concurrent call: %v", err)
	}
	out := <-promptDone
	if out.err != nil {
		t.Fatalf("prompt: %v", out.err)
	}
	if out.res.StopReason != "end_turn" {
		t.Fatalf("stop reason %q", out.res.StopReason)
	}
	joined := strings.Join(out.res.Chunks, "")
	if joined != "hello world" {
		t.Fatalf("prompt missed notifications: chunks %q", joined)
	}
}

// TestRawSubscriptionSeesWireBytes proves the tee's intake: notification
// frames arrive verbatim with method metadata, and responses/requests are
// not fanned out raw.
func TestRawSubscriptionSeesWireBytes(t *testing.T) {
	s := newDemuxServer(t)
	c := s.dial(t)

	raw, cancelSub := c.SubscribeRawNotifications(8)
	defer cancelSub()

	frame := `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_thought_chunk"}}}`
	s.push(frame)

	select {
	case n := <-raw:
		if n.Method != "session/update" {
			t.Fatalf("method %q", n.Method)
		}
		if string(n.Frame) != frame {
			t.Fatalf("frame altered:\n got %s\nwant %s", n.Frame, frame)
		}
		if n.Seq == 0 || n.Time.IsZero() {
			t.Fatalf("missing read-time metadata: %+v", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("raw subscriber saw nothing")
	}

	// A response frame must not reach raw subscribers.
	s.push(`{"jsonrpc":"2.0","id":424242,"result":{}}`)
	select {
	case n := <-raw:
		t.Fatalf("raw subscriber got a non-notification: %s", n.Frame)
	case <-time.After(200 * time.Millisecond):
	}
}

// TestPanickingHandlerStillReplies proves the recover branch upholds the
// always-answer invariant: goose parks the turn on the reply with no
// timeout, so a handler panic must still produce an error response.
func TestPanickingHandlerStillReplies(t *testing.T) {
	s := newDemuxServer(t)
	c := s.dial(t)
	c.SetAgentRequestHandler(func(*RPCResponse) { panic("handler boom") })

	s.push(`{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{}}`)

	reply := s.next()
	if got := reply["id"]; got != "perm-1" {
		t.Fatalf("reply id %v, want perm-1", got)
	}
	errObj, ok := reply["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected an error reply, got %v", reply)
	}
	if code := errObj["code"].(float64); code != -32603 {
		t.Fatalf("error code %v, want -32603", code)
	}
}
