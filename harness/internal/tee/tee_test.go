package tee

import (
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

	"github.com/konveyor/migration-harness/internal/acp"
)

// fakeGoose accepts ACP WebSocket connections, answers every request with
// a canned result, and records frames per connection. The test can push
// frames on any accepted connection (conn 1 plays the run connection).
type fakeGoose struct {
	t   *testing.T
	srv *httptest.Server

	mu    sync.Mutex
	conns []*websocket.Conn
	seen  map[int][]string // 1-based conn index -> frames received
}

func newFakeGoose(t *testing.T) *fakeGoose {
	g := &fakeGoose{t: t, seen: make(map[int][]string)}
	upgrader := websocket.Upgrader{}
	g.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		g.mu.Lock()
		g.conns = append(g.conns, conn)
		idx := len(g.conns)
		g.mu.Unlock()
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			g.mu.Lock()
			g.seen[idx] = append(g.seen[idx], string(data))
			g.mu.Unlock()

			var req struct {
				ID     *int64 `json:"id"`
				Method string `json:"method"`
			}
			if json.Unmarshal(data, &req) == nil && req.ID != nil && req.Method != "" {
				resp := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{"echo":%q}}`, *req.ID, req.Method)
				g.mu.Lock()
				conn.WriteMessage(websocket.TextMessage, []byte(resp))
				g.mu.Unlock()
			}
		}
	}))
	t.Cleanup(g.srv.Close)
	return g
}

func (g *fakeGoose) addr() string {
	u, _ := url.Parse(g.srv.URL)
	return u.Host
}

// pushTo writes a frame on the nth accepted connection (1-based).
func (g *fakeGoose) pushTo(n int, frame string) {
	deadline := time.Now().Add(5 * time.Second)
	for {
		g.mu.Lock()
		if len(g.conns) >= n {
			err := g.conns[n-1].WriteMessage(websocket.TextMessage, []byte(frame))
			g.mu.Unlock()
			if err != nil {
				g.t.Errorf("push to conn %d: %v", n, err)
			}
			return
		}
		g.mu.Unlock()
		if time.Now().After(deadline) {
			g.t.Fatalf("conn %d never appeared", n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (g *fakeGoose) framesOn(n int) []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.seen[n]...)
}

const testKey = "tee-test-key"

// startTee stands up fakeGoose, the run connection, and a tee server on an
// ephemeral port.
func startTee(t *testing.T, cfg Config) (*fakeGoose, *acp.WSClient, *Server) {
	t.Helper()
	g := newFakeGoose(t)

	host, portStr, _ := strings.Cut(g.addr(), ":")
	port, _ := strconv.Atoi(portStr)
	runConn, err := acp.NewWSClient(host, port, testKey)
	if err != nil {
		t.Fatalf("run conn: %v", err)
	}
	t.Cleanup(func() { runConn.Close() })

	cfg.SecretKey = testKey
	cfg.UpstreamAddr = g.addr()
	s := New(cfg)
	if err := s.Start(0); err != nil {
		t.Fatalf("start tee: %v", err)
	}
	t.Cleanup(s.Stop)
	s.AttachRun(runConn)

	// The run connection must be fakeGoose's conn 1 before any viewer
	// dials, so pushTo(1, ...) deterministically targets the run.
	deadline := time.Now().Add(5 * time.Second)
	for {
		g.mu.Lock()
		n := len(g.conns)
		g.mu.Unlock()
		if n >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("run connection never reached fake goose")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return g, runConn, s
}

// viewerCount reports registered viewers, for attach synchronization.
func viewerCount(s *Server) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.viewers)
}

type viewerConn struct {
	t    *testing.T
	conn *websocket.Conn
	recv chan string
}

func dialViewer(t *testing.T, s *Server, token string) (*viewerConn, error) {
	before := viewerCount(s)
	u := fmt.Sprintf("ws://%s/acp?token=%s", s.Addr(), url.QueryEscape(token))
	conn, resp, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("dial: %w (status %d)", err, resp.StatusCode)
		}
		return nil, err
	}
	v := &viewerConn{t: t, conn: conn, recv: make(chan string, 64)}
	t.Cleanup(func() { conn.Close() })
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				close(v.recv)
				return
			}
			v.recv <- string(data)
		}
	}()

	// Handshake success precedes registration (serveViewer runs on its
	// own goroutine) — wait for the attach to be observable so tests can
	// broadcast immediately after dialing.
	deadline := time.Now().Add(5 * time.Second)
	for viewerCount(s) <= before {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("viewer never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return v, nil
}

// expect returns the next frame satisfying pred within the deadline.
func (v *viewerConn) expect(what string, pred func(string) bool) string {
	deadline := time.After(5 * time.Second)
	for {
		select {
		case f, ok := <-v.recv:
			if !ok {
				v.t.Fatalf("connection closed while waiting for %s", what)
			}
			if pred(f) {
				return f
			}
		case <-deadline:
			v.t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func TestViewerPipeAndTee(t *testing.T) {
	g, _, s := startTee(t, Config{})

	v, err := dialViewer(t, s, testKey)
	if err != nil {
		t.Fatalf("viewer dial: %v", err)
	}

	// The viewer's own traffic pipes verbatim to its private goose conn.
	if err := v.conn.WriteMessage(websocket.TextMessage, []byte(`{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}`)); err != nil {
		t.Fatalf("viewer write: %v", err)
	}
	v.expect("initialize echo", func(f string) bool {
		return strings.Contains(f, `"echo":"initialize"`) && strings.Contains(f, `"id":7`)
	})

	// A run-connection update is teed to the viewer unmodified.
	teed := `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"run-s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"live"}}}}`
	g.pushTo(1, teed)
	got := v.expect("teed run update", func(f string) bool {
		return strings.Contains(f, "run-s1")
	})
	if got != teed {
		t.Fatalf("teed frame altered:\n got %s\nwant %s", got, teed)
	}

	// Non-update notifications on the run connection are not teed.
	g.pushTo(1, `{"jsonrpc":"2.0","method":"other/notification","params":{"sessionId":"run-s1"}}`)
	select {
	case f := <-v.recv:
		if strings.Contains(f, "other/notification") {
			t.Fatalf("non-update notification teed: %s", f)
		}
	case <-time.After(200 * time.Millisecond):
	}
}

func TestViewerAuth(t *testing.T) {
	_, _, s := startTee(t, Config{})

	if _, err := dialViewer(t, s, "wrong-key"); err == nil {
		t.Fatal("bad token accepted")
	}

	// X-Secret-Key header carrier (what the hub proxy sends) works too.
	h := http.Header{}
	h.Set("X-Secret-Key", testKey)
	conn, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("ws://%s/acp", s.Addr()), h)
	if err != nil {
		t.Fatalf("header auth: %v", err)
	}
	conn.Close()

	// healthz needs no auth.
	resp, err := http.Get(fmt.Sprintf("http://%s/healthz", s.Addr()))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz: %v %v", err, resp)
	}
	resp.Body.Close()
}

func TestGarbageAndDisconnectDoNotAffectRun(t *testing.T) {
	g, runConn, s := startTee(t, Config{})

	v, err := dialViewer(t, s, testKey)
	if err != nil {
		t.Fatalf("viewer dial: %v", err)
	}

	// Garbage from a viewer pipes to its own goose conn (conn 2) and is
	// otherwise inert.
	if err := v.conn.WriteMessage(websocket.TextMessage, []byte("not json at all {{{")); err != nil {
		t.Fatalf("garbage write: %v", err)
	}

	// The tee still works after garbage.
	g.pushTo(1, `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"after-garbage","update":{}}}`)
	v.expect("teed frame after garbage", func(f string) bool { return strings.Contains(f, "after-garbage") })

	// Abrupt viewer disconnect: broadcasting continues harmlessly and the
	// run connection stays up.
	v.conn.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		n := len(s.viewers)
		s.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("viewer never removed after disconnect")
		}
		time.Sleep(10 * time.Millisecond)
	}
	g.pushTo(1, `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"nobody-watching","update":{}}}`)

	select {
	case <-runConn.Done():
		t.Fatal("run connection died")
	case <-time.After(200 * time.Millisecond):
	}

	if frames := g.framesOn(2); len(frames) == 0 || !strings.Contains(frames[0], "not json") {
		t.Fatalf("garbage should have piped to the viewer's goose conn, saw %v", frames)
	}
}

func TestForwardPermission(t *testing.T) {
	_, _, s := startTee(t, Config{HITLTimeout: 300 * time.Millisecond})

	// Nobody attached.
	params := json.RawMessage(`{"toolCall":{"title":"x"},"options":[]}`)
	if _, outcome := s.ForwardPermission(params); outcome != acp.ForwardNoViewers {
		t.Fatalf("expected NoViewers, got %v", outcome)
	}

	v, err := dialViewer(t, s, testKey)
	if err != nil {
		t.Fatalf("viewer dial: %v", err)
	}

	// Viewer answers: result relayed, and the answer must NOT leak into
	// the viewer's own goose pipe.
	type fwdOut struct {
		result  json.RawMessage
		outcome acp.PermissionForwardOutcome
	}
	done := make(chan fwdOut, 1)
	go func() {
		r, o := s.ForwardPermission(params)
		done <- fwdOut{r, o}
	}()

	ask := v.expect("forwarded ask", func(f string) bool { return strings.Contains(f, "kperm-") })
	var askFrame struct {
		ID     string          `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal([]byte(ask), &askFrame); err != nil {
		t.Fatalf("ask frame: %v", err)
	}
	if askFrame.Method != "session/request_permission" || !strings.HasPrefix(askFrame.ID, "kperm-") {
		t.Fatalf("bad ask frame: %s", ask)
	}
	if string(askFrame.Params) != string(params) {
		t.Fatalf("params altered: %s", askFrame.Params)
	}

	answer := fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}`, askFrame.ID)
	if err := v.conn.WriteMessage(websocket.TextMessage, []byte(answer)); err != nil {
		t.Fatalf("answer write: %v", err)
	}

	out := <-done
	if out.outcome != acp.ForwardAnswered {
		t.Fatalf("expected Answered, got %v", out.outcome)
	}
	if !strings.Contains(string(out.result), `"optionId":"allow_once"`) {
		t.Fatalf("result not relayed: %s", out.result)
	}

	// Unanswered ask times out.
	if _, outcome := s.ForwardPermission(params); outcome != acp.ForwardTimeout {
		t.Fatalf("expected Timeout, got %v", outcome)
	}

	// A late answer to the timed-out ask is ignored, not crashed on.
	late := `{"jsonrpc":"2.0","id":"kperm-2","result":{"outcome":{"outcome":"cancelled"}}}`
	if err := v.conn.WriteMessage(websocket.TextMessage, []byte(late)); err != nil {
		t.Fatalf("late answer write: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
}

// The drop policy is a unit property of viewer.enqueue: a full queue
// closes the viewer instead of ever blocking the caller.
func TestSlowViewerDropped(t *testing.T) {
	v := &viewer{out: make(chan outFrame, 2), closed: make(chan struct{})}

	v.enqueue(outFrame{websocket.TextMessage, []byte("1")})
	v.enqueue(outFrame{websocket.TextMessage, []byte("2")})

	select {
	case <-v.closed:
		t.Fatal("viewer dropped before queue was full")
	default:
	}

	v.enqueue(outFrame{websocket.TextMessage, []byte("3")}) // overflow

	select {
	case <-v.closed:
	default:
		t.Fatal("overflowing viewer was not dropped")
	}

	// Further enqueues are no-ops, not panics.
	v.enqueue(outFrame{websocket.TextMessage, []byte("4")})
}
