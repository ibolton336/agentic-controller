// Package tee makes the harness the pod's ACP endpoint on the platform
// port (:4000) and makes the run observable while it executes.
//
// Topology:
//
//	before:  viewer ──(hub WS pipe)──▶ pod:4000 = goose  ◀── harness (ACP client)
//	after:   viewer ──(hub WS pipe)──▶ pod:4000 = harness ──▶ 127.0.0.1:4001 = goose
//
// goose gives every WebSocket connection a private agent with no
// cross-connection fan-out, so a viewer dialing goose directly can never
// see the run's session. The tee fixes that without inventing protocol:
//
//   - each attached client gets a dumb per-connection pipe to goose on
//     loopback — frames pass verbatim in both directions, so interactive
//     chat (the client driving its own session) works exactly as before
//   - the run connection's session/update notifications are teed into
//     every attached client unmodified; they are notifications (no id),
//     so they cannot collide with the client's own request/response pairs
//   - a session/request_permission ask on the run connection is offered
//     to attached viewers under a harness-allocated "kperm-<n>" string id
//     (disjoint from the pipe's verbatim numeric ids); the viewer's
//     answer is intercepted and relayed to goose
//
// The tee must never affect the run: per-connection goroutines recover
// panics, per-client buffers are bounded and a slow client is dropped (it
// can reconnect), and a listener failure downgrades to a warning.
package tee

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/konveyor/migration-harness/internal/acp"
	"github.com/konveyor/migration-harness/internal/logging"
)

const (
	// DefaultHITLTimeout is how long a permission ask waits for an
	// attached viewer before the harness falls back to its headless
	// policy. goose parks the turn on the reply with no timeout of its
	// own, so this is the only clock on the ask.
	DefaultHITLTimeout = 3 * time.Minute

	// DefaultQueueCap bounds each viewer's outbound frame queue. A viewer
	// that cannot drain this many frames is dropped rather than ever
	// back-pressuring the run.
	DefaultQueueCap = 256

	// rawSubscriberBuffer sizes the tee's intake from the run
	// connection's notification stream.
	rawSubscriberBuffer = 1024
)

// Config for the tee server. SecretKey and UpstreamAddr are required.
type Config struct {
	// SecretKey authenticates viewers (X-Secret-Key header or ?token=
	// query — the same carriers goose accepts) and is presented upstream
	// when dialing goose.
	SecretKey string
	// UpstreamAddr is goose serve's loopback host:port.
	UpstreamAddr string
	// HITLTimeout overrides DefaultHITLTimeout when > 0.
	HITLTimeout time.Duration
	// QueueCap overrides DefaultQueueCap when > 0.
	QueueCap int
}

// Server is the pod-facing ACP endpoint: auth, pipe, tee, HITL relay.
type Server struct {
	cfg      Config
	ln       net.Listener
	httpSrv  *http.Server
	upstream string // ws URL to goose

	mu      sync.Mutex
	viewers map[*viewer]struct{}
	perms   map[string]chan json.RawMessage
	stopped bool

	// responsive tracks whether attached viewers show signs of a human:
	// set on attach and on any kperm answer, cleared when an ask times
	// out. While false, permission asks resolve NoViewers immediately —
	// one slow timeout, then fast fail-closed denies instead of parking
	// every retried ask for the full window.
	responsive atomic.Bool

	permSeq     atomic.Int64
	unsubscribe func()
}

// New creates a tee server. Call Start to listen and AttachRun to begin
// teeing the run connection's stream.
func New(cfg Config) *Server {
	if cfg.HITLTimeout <= 0 {
		cfg.HITLTimeout = DefaultHITLTimeout
	}
	if cfg.QueueCap <= 0 {
		cfg.QueueCap = DefaultQueueCap
	}
	return &Server{
		cfg:      cfg,
		upstream: fmt.Sprintf("ws://%s/acp?token=%s", cfg.UpstreamAddr, url.QueryEscape(cfg.SecretKey)),
		viewers:  make(map[*viewer]struct{}),
		perms:    make(map[string]chan json.RawMessage),
	}
}

// Start listens on the given port (0 picks an ephemeral port, for tests).
// Failure is returned, not fatal — the caller downgrades it to a warning;
// the run proceeds without live viewers.
func (s *Server) Start(port int) error {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Errorf("tee listen :%d: %w", port, err)
	}
	s.ln = ln

	mux := http.NewServeMux()
	// Unauthenticated liveness endpoint (ADR 0004 contract).
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/acp", s.handleACP)

	s.httpSrv = &http.Server{Handler: mux}
	go func() {
		defer recoverWarn("tee http server")
		if err := s.httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
			logging.Warn("tee server: %v", err)
		}
	}()
	return nil
}

// Addr returns the bound listener address (useful with port 0).
func (s *Server) Addr() string {
	if s.ln == nil {
		return ""
	}
	return s.ln.Addr().String()
}

// Stop closes the listener and disconnects all viewers. Pending
// permission asks resolve through their timeout fallback.
func (s *Server) Stop() {
	s.mu.Lock()
	s.stopped = true
	views := make([]*viewer, 0, len(s.viewers))
	for v := range s.viewers {
		views = append(views, v)
	}
	s.mu.Unlock()

	if s.unsubscribe != nil {
		s.unsubscribe()
	}
	if s.httpSrv != nil {
		s.httpSrv.Close()
	}
	for _, v := range views {
		v.shutdown(websocket.CloseGoingAway, "harness shutting down")
	}
}

// AttachRun subscribes to the run connection's notification stream and
// tees session/update frames to every attached viewer.
func (s *Server) AttachRun(ws *acp.WSClient) {
	ch, cancel := ws.SubscribeRawNotifications(rawSubscriberBuffer)
	s.unsubscribe = cancel
	go func() {
		defer recoverWarn("tee broadcast")
		for n := range ch {
			if n.Method != "session/update" {
				continue
			}
			s.broadcast(n.Frame)
		}
	}()
}

// ForwardPermission implements acp.PermissionForwarder: broadcast the ask
// to every attached viewer under a kperm-<n> id, first answer wins.
func (s *Server) ForwardPermission(params json.RawMessage) (json.RawMessage, acp.PermissionForwardOutcome) {
	id := fmt.Sprintf("kperm-%d", s.permSeq.Add(1))
	frame, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  "session/request_permission",
		"params":  params,
	})
	if err != nil {
		logging.Warn("tee: marshal permission forward: %v", err)
		return nil, acp.ForwardNoViewers
	}

	ch := make(chan json.RawMessage, 1)
	s.mu.Lock()
	if s.stopped || len(s.viewers) == 0 {
		s.mu.Unlock()
		return nil, acp.ForwardNoViewers
	}
	if !s.responsive.Load() {
		// Viewers are attached but a previous ask already timed out and
		// nothing human has happened since — don't park this ask for
		// another full window.
		s.mu.Unlock()
		logging.Info("tee: permission ask %s — viewers unresponsive, fast fail-closed", id)
		return nil, acp.ForwardNoViewers
	}
	s.perms[id] = ch
	for v := range s.viewers {
		v.enqueue(outFrame{websocket.TextMessage, frame})
	}
	n := len(s.viewers)
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.perms, id)
		s.mu.Unlock()
	}()

	logging.Info("tee: permission ask %s offered to %d viewer(s)", id, n)
	select {
	case result := <-ch:
		return result, acp.ForwardAnswered
	case <-time.After(s.cfg.HITLTimeout):
		s.responsive.Store(false)
		return nil, acp.ForwardTimeout
	}
}

// ---------------------------------------------------------------- viewers

type outFrame struct {
	messageType int
	data        []byte
}

type viewer struct {
	conn     *websocket.Conn
	out      chan outFrame
	closed   chan struct{}
	stopOnce sync.Once
}

// enqueue queues a frame for the viewer's writer goroutine. On a full
// queue the viewer is dropped — never block, never affect the run.
func (v *viewer) enqueue(f outFrame) {
	select {
	case v.out <- f:
	case <-v.closed:
	default:
		logging.Warn("tee: viewer send queue full — dropping viewer")
		v.shutdown(websocket.ClosePolicyViolation, "too slow — reconnect to resume")
	}
}

func (v *viewer) shutdown(code int, reason string) {
	v.stopOnce.Do(func() {
		close(v.closed)
		if v.conn == nil {
			return
		}
		deadline := time.Now().Add(2 * time.Second)
		msg := websocket.FormatCloseMessage(code, reason)
		_ = v.conn.WriteControl(websocket.CloseMessage, msg, deadline)
		_ = v.conn.Close()
	})
}

var upgrader = websocket.Upgrader{
	// Auth is the shared secret; the shim (not a browser origin) is the
	// expected peer, so origin checks carry no signal here.
	CheckOrigin: func(*http.Request) bool { return true },
}

func (s *Server) authorized(r *http.Request) bool {
	key := []byte(s.cfg.SecretKey)
	if h := r.Header.Get("X-Secret-Key"); h != "" {
		return subtle.ConstantTimeCompare([]byte(h), key) == 1
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return subtle.ConstantTimeCompare([]byte(t), key) == 1
	}
	return false
}

func (s *Server) handleACP(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		logging.Warn("tee: upgrade: %v", err)
		return
	}
	go s.serveViewer(conn)
}

func (s *Server) serveViewer(client *websocket.Conn) {
	defer recoverWarn("tee viewer")

	v := &viewer{
		conn:   client,
		out:    make(chan outFrame, s.cfg.QueueCap),
		closed: make(chan struct{}),
	}

	// Register before dialing goose: teed frames and permission asks
	// must reach a viewer from the moment its socket is accepted — they
	// queue in v.out while the upstream pipe comes up.
	if !s.addViewer(v) {
		v.shutdown(websocket.CloseGoingAway, "harness shutting down")
		return
	}
	logging.Info("tee: viewer attached")
	defer func() {
		s.removeViewer(v)
		v.shutdown(websocket.CloseNormalClosure, "")
		logging.Info("tee: viewer detached")
	}()

	// Writer: the sole writer to the client socket — pipe frames and
	// teed frames are serialized through v.out.
	go func() {
		defer recoverWarn("tee viewer writer")
		for {
			select {
			case <-v.closed:
				return
			case f := <-v.out:
				if err := client.WriteMessage(f.messageType, f.data); err != nil {
					v.shutdown(websocket.CloseInternalServerErr, "write failed")
					return
				}
			}
		}
	}()

	// Every client gets its own upstream goose connection — goose's
	// per-connection agent keeps interactive chat isolated, exactly as
	// when goose owned the port.
	upstream, _, err := websocket.DefaultDialer.Dial(s.upstream, nil)
	if err != nil {
		logging.Warn("tee: upstream dial: %v", err)
		v.shutdown(websocket.CloseInternalServerErr, "agent unavailable")
		return
	}
	defer upstream.Close()

	// Upstream reader: goose → client, verbatim.
	go func() {
		defer recoverWarn("tee upstream reader")
		for {
			mt, data, err := upstream.ReadMessage()
			if err != nil {
				v.shutdown(websocket.CloseNormalClosure, "agent connection closed")
				return
			}
			v.enqueue(outFrame{mt, data})
		}
	}()

	// Client reader: client → goose, verbatim — except answers to
	// kperm-* asks, which belong to the run connection, not this pipe.
	for {
		mt, data, err := client.ReadMessage()
		if err != nil {
			return
		}
		if id, result, ok := kpermAnswer(data); ok {
			s.resolvePermission(id, result)
			continue
		}
		if err := upstream.WriteMessage(mt, data); err != nil {
			return
		}
	}
}

func (s *Server) addViewer(v *viewer) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return false
	}
	s.viewers[v] = struct{}{}
	// A fresh attach is a sign of a human; resume forwarding asks.
	s.responsive.Store(true)
	return true
}

func (s *Server) removeViewer(v *viewer) {
	s.mu.Lock()
	delete(s.viewers, v)
	s.mu.Unlock()
}

func (s *Server) broadcast(frame []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for v := range s.viewers {
		v.enqueue(outFrame{websocket.TextMessage, frame})
	}
}

// kpermAnswer reports whether the frame is a JSON-RPC *response* to a
// harness-allocated kperm-* permission ask, and extracts its result.
// Error responses are not answers — the ask stays pending for another
// viewer or the timeout.
func kpermAnswer(frame []byte) (string, json.RawMessage, bool) {
	var probe struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(frame, &probe); err != nil {
		return "", nil, false
	}
	if probe.Method != "" || len(probe.ID) == 0 {
		return "", nil, false
	}
	var id string
	if err := json.Unmarshal(probe.ID, &id); err != nil {
		return "", nil, false
	}
	if !strings.HasPrefix(id, "kperm-") {
		return "", nil, false
	}
	if len(probe.Result) == 0 {
		logging.Warn("tee: viewer errored permission ask %s — leaving it pending", id)
		return id, nil, true // consumed (never forwarded upstream), but not resolved
	}
	return id, probe.Result, true
}

func (s *Server) resolvePermission(id string, result json.RawMessage) {
	// Any kperm frame — even a late or error answer — proves a human is
	// at the controls; resume forwarding asks.
	s.responsive.Store(true)
	if result == nil {
		return
	}
	s.mu.Lock()
	ch, ok := s.perms[id]
	if ok {
		delete(s.perms, id)
	}
	s.mu.Unlock()
	if !ok {
		logging.Info("tee: late/duplicate answer for %s — ignoring", id)
		return
	}
	ch <- result // cap 1; sole sender after map removal
}

func recoverWarn(what string) {
	if r := recover(); r != nil {
		logging.Warn("tee: %s panic: %v", what, r)
	}
}
