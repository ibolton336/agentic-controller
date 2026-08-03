package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestExtractSessionIDFromNotifications(t *testing.T) {
	tests := []struct {
		name   string
		notifs []*RPCResponse
		want   string
	}{
		{
			name:   "nil notifications",
			notifs: nil,
			want:   "",
		},
		{
			name: "session/update with sessionId",
			notifs: []*RPCResponse{
				{Method: "session/update", Params: json.RawMessage(`{"sessionId":"abc-123"}`)},
			},
			want: "abc-123",
		},
		{
			name: "ignores non-session/update",
			notifs: []*RPCResponse{
				{Method: "other/method", Params: json.RawMessage(`{"sessionId":"should-skip"}`)},
			},
			want: "",
		},
		{
			name: "returns first match",
			notifs: []*RPCResponse{
				{Method: "session/update", Params: json.RawMessage(`{"sessionId":"first"}`)},
				{Method: "session/update", Params: json.RawMessage(`{"sessionId":"second"}`)},
			},
			want: "first",
		},
		{
			name: "skips empty sessionId",
			notifs: []*RPCResponse{
				{Method: "session/update", Params: json.RawMessage(`{"sessionId":""}`)},
				{Method: "session/update", Params: json.RawMessage(`{"sessionId":"real-id"}`)},
			},
			want: "real-id",
		},
		{
			name: "handles malformed JSON",
			notifs: []*RPCResponse{
				{Method: "session/update", Params: json.RawMessage(`not-json`)},
			},
			want: "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractSessionIDFromNotifications(tt.notifs)
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestIsToolCall(t *testing.T) {
	tests := []struct {
		name string
		msg  *RPCResponse
		want bool
	}{
		{
			name: "tool_call update",
			msg: &RPCResponse{
				Method: "session/update",
				Params: json.RawMessage(`{"update":{"sessionUpdate":"tool_call"}}`),
			},
			want: true,
		},
		{
			name: "agent_message_chunk is not a tool call",
			msg: &RPCResponse{
				Method: "session/update",
				Params: json.RawMessage(`{"update":{"sessionUpdate":"agent_message_chunk"}}`),
			},
			want: false,
		},
		{
			name: "wrong method",
			msg: &RPCResponse{
				Method: "other/method",
				Params: json.RawMessage(`{"update":{"sessionUpdate":"tool_call"}}`),
			},
			want: false,
		},
		{
			name: "malformed JSON",
			msg: &RPCResponse{
				Method: "session/update",
				Params: json.RawMessage(`garbage`),
			},
			want: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isToolCall(tt.msg)
			if got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

// TestSendPromptAnswersStringIDRequest proves agent-initiated requests
// with STRING ids are parsed, answered, and answered with the id echoed
// byte-exactly. Real goose allocates string ids (UUIDs) for its
// agent→client requests — session/request_permission arrives as
// {"id":"<uuid>", ...}. With ids parsed into *int64 the frame failed to
// unmarshal and was dropped; goose parks the turn on the missing reply
// with no timeout, hanging the stage until the pod deadline (observed
// live the first time a run entered approve mode).
func TestSendPromptAnswersStringIDRequest(t *testing.T) {
	replies := make(chan map[string]any, 1)

	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()

		// Read the client's session/prompt request.
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("read prompt: %v", err)
			return
		}
		var promptReq struct {
			ID int64 `json:"id"`
		}
		if err := json.Unmarshal(data, &promptReq); err != nil {
			t.Errorf("parse prompt: %v", err)
			return
		}

		// Agent-initiated permission request with a string id, as goose
		// actually sends it.
		perm := `{"jsonrpc":"2.0","id":"e0fcae7c-perm-1","method":"session/request_permission","params":{` +
			`"sessionId":"s1","toolCall":{"title":"shell · ls"},` +
			`"options":[{"optionId":"opt-ro","kind":"reject_once"}]}}`
		if err := conn.WriteMessage(websocket.TextMessage, []byte(perm)); err != nil {
			t.Errorf("send permission request: %v", err)
			return
		}
		_, data, err = conn.ReadMessage()
		if err != nil {
			t.Errorf("read permission reply: %v", err)
			return
		}
		var permReply map[string]any
		_ = json.Unmarshal(data, &permReply)
		replies <- permReply

		// Finish the turn.
		done := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{"stopReason":"end_turn"}}`, promptReq.ID)
		if err := conn.WriteMessage(websocket.TextMessage, []byte(done)); err != nil {
			t.Errorf("send prompt result: %v", err)
		}
	}))
	defer srv.Close()

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse test server url: %v", err)
	}
	port, _ := strconv.Atoi(u.Port())
	client, err := NewWSClient(u.Hostname(), port, "test-key")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	sc := NewSessionClient(client)
	if _, err := sc.SendPrompt(ctx, "s1", []ContentBlock{{Type: "text", Text: "go"}}, 0); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	reply := <-replies
	if got, _ := reply["id"].(string); got != "e0fcae7c-perm-1" {
		t.Fatalf("string id not echoed byte-exactly: %v", reply["id"])
	}
	result, _ := reply["result"].(map[string]any)
	outcome, _ := result["outcome"].(map[string]any)
	if outcome["outcome"] != "selected" || outcome["optionId"] != "opt-ro" {
		t.Fatalf("expected fail-closed reject_once, got %v", result)
	}
}
