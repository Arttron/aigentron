package link

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
	"github.com/Arttron/aigentron/apps/local-agent/internal/proto"
)

// Handler runs one command and returns its data, or an error that goes back as `ok:false`.
type Handler func(ctx context.Context, op string, args json.RawMessage) (any, error)

type emitKey struct{}

// EmitterFrom returns the function a command handler uses to send `event` frames while it runs (streamed output); a no-op when there is none.
func EmitterFrom(ctx context.Context) func(name string, data any) bool {
	if f, ok := ctx.Value(emitKey{}).(func(string, any) bool); ok {
		return f
	}
	return func(string, any) bool { return false }
}

// ErrFatal means reconnecting is pointless (the token was revoked, the protocols do not fit).
var ErrFatal = errors.New("the server will not accept this agent")

// Client keeps the connection up: dial, hello, serve, and on any break wait and dial again.
type Client struct {
	Cfg     config.Config
	Info    Info
	Handle  Handler
	HTTP    *http.Client
	Logf    func(format string, args ...any)
	OnState func(state string) // "connecting" · "online" · "offline"
	mu      sync.RWMutex
	out     func(proto.Frame) error // set while a session is up

	// Rev reports the revision of the global rules this agent holds (sent in `hello`; the server pushes `config.set` when it differs).
	Rev func() int

	// MinBackoff / MaxBackoff bound the wait between attempts (defaults 1 s / 30 s).
	MinBackoff, MaxBackoff time.Duration
	// HandshakeTimeout is how long the server may take to answer `hello` (default 10 s).
	HandshakeTimeout time.Duration
}

func (c *Client) logf(f string, a ...any) {
	if c.Logf != nil {
		c.Logf(f, a...)
		return
	}
	log.Printf(f, a...)
}

func (c *Client) state(s string) {
	if c.OnState != nil {
		c.OnState(s)
	}
}

// Emit sends an event to the server; false when the line is down (nothing is queued — the caller sends its picture again when the state turns "online").
func (c *Client) Emit(name string, data any) bool {
	c.mu.RLock()
	out := c.out
	c.mu.RUnlock()
	if out == nil {
		return false
	}
	b, err := json.Marshal(data)
	if err != nil {
		return false
	}
	return out(proto.Frame{Type: proto.TypeEvent, Name: name, Data: b}) == nil
}

func (c *Client) rev() int {
	if c.Rev != nil {
		return c.Rev()
	}
	return 0
}

// wsURL turns the server origin into its WebSocket address.
func wsURL(server string) (string, error) {
	u, err := normalizeServer(server)
	if err != nil {
		return "", err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	return u.String() + "/api/local-agent/ws", nil
}

// Run connects and keeps reconnecting until ctx ends (returns nil) or the server refuses for good (returns ErrFatal wrapped).
func (c *Client) Run(ctx context.Context) error {
	minB, maxB := c.MinBackoff, c.MaxBackoff
	if minB <= 0 {
		minB = time.Second
	}
	if maxB <= 0 {
		maxB = 30 * time.Second
	}
	wait := minB
	for ctx.Err() == nil {
		c.state("connecting")
		served, err := c.session(ctx)
		c.state("offline")
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, ErrFatal) {
			return err
		}
		if served {
			wait = minB // it was up: the next break starts the backoff over
		}
		c.logf("disconnected: %v — retrying in %s", err, wait)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
		if wait *= 2; wait > maxB {
			wait = maxB
		}
	}
	return nil
}

// session is one connection from dial to break. served = the server accepted us at least once.
func (c *Client) session(ctx context.Context) (served bool, err error) {
	addr, err := wsURL(c.Cfg.Server)
	if err != nil {
		return false, fmt.Errorf("%w: %v", ErrFatal, err)
	}
	conn, res, err := websocket.Dial(ctx, addr, &websocket.DialOptions{
		HTTPClient: c.HTTP,
		HTTPHeader: http.Header{"Authorization": {"Bearer " + c.Cfg.Token}},
	})
	if err != nil {
		if res != nil && (res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden) {
			return false, fmt.Errorf("%w: the token was refused (%d) — pair again", ErrFatal, res.StatusCode)
		}
		return false, err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4 << 20)

	send := func(f proto.Frame) error {
		b, err := proto.Encode(f)
		if err != nil {
			return err
		}
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return conn.Write(wctx, websocket.MessageText, b)
	}
	read := func(timeout time.Duration) (proto.Frame, error) {
		rctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		_, b, err := conn.Read(rctx)
		if err != nil {
			return proto.Frame{}, err
		}
		return proto.Decode(b)
	}

	if err := send(proto.Frame{Type: proto.TypeHello, ProtoMin: proto.Min, Proto: proto.Version, Version: c.Info.Version, OS: c.Info.OS, Arch: c.Info.Arch, Host: c.Info.Host, ConfigRev: c.rev()}); err != nil {
		return false, err
	}
	hs := c.HandshakeTimeout
	if hs <= 0 {
		hs = 10 * time.Second
	}
	first, err := read(hs)
	if err != nil {
		return false, err
	}
	switch first.Type {
	case proto.TypeRefuse:
		return false, fmt.Errorf("%w: %s (%s)", ErrFatal, first.Message, first.Code)
	case proto.TypeWelcome:
	default:
		return false, fmt.Errorf("expected welcome, got %q", first.Type)
	}
	if first.Proto < proto.Min {
		return false, fmt.Errorf("%w: the server speaks protocol %d, this agent needs at least %d — update the server", ErrFatal, first.Proto, proto.Min)
	}
	pingSec := first.PingSec
	if pingSec <= 0 {
		pingSec = 25
	}
	c.mu.Lock()
	c.out = send
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.out = nil
		c.mu.Unlock()
	}()
	c.state("online")
	c.logf("online (server %s, protocol %d)", first.ServerVersion, first.Proto)

	// keep-alive: we ping; a silent server (3 intervals) means a dead line
	every := time.Duration(pingSec) * time.Second
	pctx, stopPing := context.WithCancel(ctx)
	defer stopPing()
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for n := 1; ; n++ {
			select {
			case <-pctx.Done():
				return
			case <-t.C:
				if send(proto.Frame{Type: proto.TypePing, ID: "a" + strconv.Itoa(n)}) != nil {
					return
				}
			}
		}
	}()

	// commands still running when the line drops are cancelled (a streamed answer nobody can receive any more must not keep a model busy)
	sctx, endSession := context.WithCancel(context.WithValue(ctx, emitKey{}, c.Emit))
	var wg sync.WaitGroup
	defer wg.Wait()
	defer endSession()
	for {
		f, err := read(3 * every)
		if err != nil {
			stopPing()
			return true, err
		}
		switch f.Type {
		case proto.TypePing:
			_ = send(proto.Frame{Type: proto.TypePong, ID: f.ID})
		case proto.TypePong, proto.TypeWelcome:
		case proto.TypeRefuse:
			return true, fmt.Errorf("%w: %s (%s)", ErrFatal, f.Message, f.Code)
		case proto.TypeCommand:
			wg.Add(1)
			go func(f proto.Frame) {
				defer wg.Done()
				var data any
				var herr error
				if c.Handle == nil {
					herr = errors.New("no handler")
				} else {
					data, herr = c.Handle(sctx, f.Op, f.Args)
				}
				msg := ""
				if herr != nil {
					msg = herr.Error()
				}
				if err := send(proto.Result(f.ID, data, msg)); err != nil {
					c.logf("could not answer %s: %v", f.ID, err)
				}
			}(f)
		default:
			c.logf("ignoring %q frame", f.Type)
		}
	}
}
