package acp

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

type stubForwarder struct {
	result  json.RawMessage
	outcome PermissionForwardOutcome
	asked   chan json.RawMessage
}

func (f *stubForwarder) ForwardPermission(params json.RawMessage) (json.RawMessage, PermissionForwardOutcome) {
	if f.asked != nil {
		f.asked <- params
	}
	return f.result, f.outcome
}

const permAsk = `{"jsonrpc":"2.0","id":900,"method":"session/request_permission","params":{` +
	`"sessionId":"s1","toolCall":{"title":"edit pom.xml"},` +
	`"options":[{"optionId":"opt-aa","kind":"allow_always"},` +
	`{"optionId":"opt-ao","kind":"allow_once"},` +
	`{"optionId":"opt-ro","kind":"reject_once"},` +
	`{"optionId":"opt-ra","kind":"reject_always"}]}}`

// runPermissionScenario drives one prompt during which goose asks for
// permission, and returns the harness's reply to that ask.
func runPermissionScenario(t *testing.T, fwd PermissionForwarder) map[string]any {
	t.Helper()
	s := newDemuxServer(t)
	c := s.dial(t)
	sc := NewSessionClient(c)
	if fwd != nil {
		sc.SetPermissionForwarder(fwd)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	promptDone := make(chan error, 1)
	go func() {
		_, err := sc.SendPrompt(ctx, "s1", []ContentBlock{{Type: "text", Text: "go"}}, 0)
		promptDone <- err
	}()

	promptReq := s.next()
	promptID := int64(promptReq["id"].(float64))

	s.push(permAsk)
	reply := s.next()

	s.push(`{"jsonrpc":"2.0","id":` + jsonInt(promptID) + `,"result":{"stopReason":"end_turn"}}`)
	if err := <-promptDone; err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if got := reply["id"].(float64); int64(got) != 900 {
		t.Fatalf("reply to id %v, want 900", got)
	}
	return reply
}

func jsonInt(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func selectedOption(t *testing.T, reply map[string]any) (string, string) {
	t.Helper()
	result, ok := reply["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result in reply %v", reply)
	}
	outcome, ok := result["outcome"].(map[string]any)
	if !ok {
		t.Fatalf("no outcome in result %v", result)
	}
	kind, _ := outcome["outcome"].(string)
	opt, _ := outcome["optionId"].(string)
	return kind, opt
}

// A viewer's answer is relayed verbatim.
func TestPermissionForwardAnswered(t *testing.T) {
	fwd := &stubForwarder{
		result:  json.RawMessage(`{"outcome":{"outcome":"selected","optionId":"opt-aa"}}`),
		outcome: ForwardAnswered,
		asked:   make(chan json.RawMessage, 1),
	}
	reply := runPermissionScenario(t, fwd)

	kind, opt := selectedOption(t, reply)
	if kind != "selected" || opt != "opt-aa" {
		t.Fatalf("viewer answer not relayed verbatim: %s/%s", kind, opt)
	}

	params := <-fwd.asked
	var p struct {
		ToolCall struct {
			Title string `json:"title"`
		} `json:"toolCall"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.ToolCall.Title != "edit pom.xml" {
		t.Fatalf("forwarder saw wrong params: %s (%v)", params, err)
	}
}

// A viewer that walks away mid-ask resolves allow_once — never a decline,
// which goose retries into a MaxTurns burn.
func TestPermissionForwardTimeoutAllowsOnce(t *testing.T) {
	reply := runPermissionScenario(t, &stubForwarder{outcome: ForwardTimeout})
	kind, opt := selectedOption(t, reply)
	if kind != "selected" || opt != "opt-ao" {
		t.Fatalf("timeout should allow once, got %s/%s", kind, opt)
	}
}

// Nobody attached keeps the headless fail-closed deny.
func TestPermissionForwardNoViewersDenies(t *testing.T) {
	reply := runPermissionScenario(t, &stubForwarder{outcome: ForwardNoViewers})
	kind, opt := selectedOption(t, reply)
	if kind != "selected" || opt != "opt-ro" {
		t.Fatalf("no-viewers should deny, got %s/%s", kind, opt)
	}
}

// No forwarder at all (tee off) behaves identically.
func TestPermissionNoForwarderDenies(t *testing.T) {
	reply := runPermissionScenario(t, nil)
	kind, opt := selectedOption(t, reply)
	if kind != "selected" || opt != "opt-ro" {
		t.Fatalf("headless deny expected, got %s/%s", kind, opt)
	}
}
