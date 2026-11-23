package link

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
	"github.com/Arttron/aigentron/apps/local-agent/internal/proto"
)

func readFrame(t *testing.T, ctx context.Context, c *websocket.Conn) proto.Frame {
	t.Helper()
	_, b, err := c.Read(ctx)
	if err != nil {
		if ctx.Err() == nil {
			t.Errorf("server read: %v", err)
		}
		panic(http.ErrAbortHandler)
	}
	f, err := proto.Decode(b)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func writeFrame(t *testing.T, ctx context.Context, c *websocket.Conn, f proto.Frame) {
	t.Helper()
	b, _ := proto.Encode(f)
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		if ctx.Err() == nil {
			t.Errorf("server write: %v", err)
		}
		panic(http.ErrAbortHandler)
	}
}

func client(srv *httptest.Server) *Client {
	return &Client{
		Cfg:        config.Config{Server: srv.URL, Token: "lag_x_y"},
		Info:       Info{Version: "test", OS: "darwin", Arch: "arm64", Host: "h"},
		Logf:       func(string, ...any) {},
		MinBackoff: 10 * time.Millisecond,
		MaxBackoff: 20 * time.Millisecond,
	}
}

func TestHelloCommandResult(t *testing.T) {
	var gotAuth atomic.Value
	var once atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		if once.Swap(true) { // the client reconnects after the script ends; only the first connection is scripted
			c.CloseNow()
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		hello := readFrame(t, ctx, c)
		if hello.Type != proto.TypeHello || hello.Proto != proto.Version || hello.OS != "darwin" {
			t.Errorf("bad hello: %+v", hello)
		}
		writeFrame(t, ctx, c, proto.Frame{Type: proto.TypeWelcome, Proto: 1, ServerVersion: "s", PingSec: 25})
		writeFrame(t, ctx, c, proto.Frame{Type: proto.TypeCommand, ID: "c1", Op: "status", Args: json.RawMessage(`{}`)})
		res := readFrame(t, ctx, c)
		if res.Type != proto.TypeResult || res.ID != "c1" || res.OK == nil || !*res.OK || !strings.Contains(string(res.Data), `"hi"`) {
			t.Errorf("bad result: %+v", res)
		}
		writeFrame(t, ctx, c, proto.Frame{Type: proto.TypeCommand, ID: "c2", Op: "nope"})
		bad := readFrame(t, ctx, c)
		if bad.ID != "c2" || bad.OK == nil || *bad.OK || bad.Error == "" {
			t.Errorf("unknown op not reported: %+v", bad)
		}
		writeFrame(t, ctx, c, proto.Frame{Type: proto.TypePing, ID: "p"})
		if pong := readFrame(t, ctx, c); pong.Type != proto.TypePong || pong.ID != "p" {
			t.Errorf("no pong: %+v", pong)
		}
		c.Close(websocket.StatusNormalClosure, "")
	}))
	defer srv.Close()

	online := make(chan struct{}, 1)
	cl := client(srv)
	cl.OnState = func(s string) {
		if s == "online" {
			select {
			case online <- struct{}{}:
			default:
			}
		}
	}
	cl.Handle = func(_ context.Context, op string, _ json.RawMessage) (any, error) {
		if op == "status" {
			return map[string]string{"say": "hi"}, nil
		}
		return nil, errors.New("unknown op")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- cl.Run(ctx) }()
	select {
	case <-online:
	case <-time.After(2 * time.Second):
		t.Fatal("never came online")
	}
	time.Sleep(300 * time.Millisecond) // the server script runs and closes
	cancel()
	<-done
	if gotAuth.Load() != "Bearer lag_x_y" {
		t.Fatalf("auth header: %v", gotAuth.Load())
	}
}

func TestReconnectsAfterADrop(t *testing.T) {
	var conns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conns.Add(1)
		readFrame(t, r.Context(), c)
		writeFrame(t, r.Context(), c, proto.Frame{Type: proto.TypeWelcome, Proto: 1, PingSec: 25})
		c.CloseNow() // drop at once
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = client(srv).Run(ctx)
	if n := conns.Load(); n < 3 {
		t.Fatalf("expected several reconnects, got %d connections", n)
	}
}

func TestRefuseIsFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := websocket.Accept(w, r, nil)
		readFrame(t, r.Context(), c)
		writeFrame(t, r.Context(), c, proto.Frame{Type: proto.TypeRefuse, Code: "proto_too_old", Message: "update"})
		c.CloseNow()
	}))
	defer srv.Close()
	err := client(srv).Run(context.Background())
	if !errors.Is(err, ErrFatal) || !strings.Contains(err.Error(), "proto_too_old") {
		t.Fatalf("want fatal refuse, got %v", err)
	}
}

func TestRevokedTokenIsFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized) }))
	defer srv.Close()
	if err := client(srv).Run(context.Background()); !errors.Is(err, ErrFatal) {
		t.Fatalf("want fatal, got %v", err)
	}
}

func TestPair(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]string
		_ = json.NewDecoder(r.Body).Decode(&b)
		if r.URL.Path != "/api/local-agent/token" || b["code"] != "good" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"The pairing code is not valid any more"}`))
			return
		}
		_, _ = w.Write([]byte(`{"token":"lag_1_s"}`))
	}))
	defer srv.Close()
	cfg, err := Pair(context.Background(), nil, srv.URL+"/some/path", " good ", "laptop", Info{OS: "darwin"})
	if err != nil || cfg.Token != "lag_1_s" || cfg.Server != srv.URL || cfg.Device != "laptop" {
		t.Fatalf("got %+v, %v", cfg, err)
	}
	if _, err := Pair(context.Background(), nil, srv.URL, "bad", "laptop", Info{}); err == nil || !strings.Contains(err.Error(), "not valid any more") {
		t.Fatalf("bad code not reported: %v", err)
	}
}

func TestNormalizeAndWsURL(t *testing.T) {
	for in, want := range map[string]string{
		"localhost:3001":         "ws://localhost:3001/api/local-agent/ws",
		"http://localhost:3001/": "ws://localhost:3001/api/local-agent/ws",
		"example.com":            "wss://example.com/api/local-agent/ws",
	} {
		got, err := wsURL(in)
		if in == "localhost:3001" {
			// no scheme → https is assumed; a local server must be written with http://
			want = "wss://localhost:3001/api/local-agent/ws"
		}
		if err != nil || got != want {
			t.Errorf("%s: got %s, %v; want %s", in, got, err, want)
		}
	}
	if _, err := wsURL(""); err == nil {
		t.Error("empty accepted")
	}
}

func TestLoginDeviceFlow(t *testing.T) {
	var polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/local-agent/device/start":
			_, _ = w.Write([]byte(`{"deviceCode":"dc","userCode":"ABCD-2345","verificationUrl":"http://x/addons?tab=local-agent&code=ABCD-2345","expiresInSec":30,"intervalSec":1}`))
		case "/api/local-agent/device/poll":
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			if b["deviceCode"] != "dc" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if polls.Add(1) < 2 {
				_, _ = w.Write([]byte(`{"status":"pending"}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"approved","token":"lag_1_s"}`))
		}
	}))
	defer srv.Close()
	var shown LoginPrompt
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cfg, err := Login(ctx, nil, srv.URL, "laptop", Info{OS: "darwin"}, func(p LoginPrompt) { shown = p })
	if err != nil || cfg.Token != "lag_1_s" || cfg.Device != "laptop" {
		t.Fatalf("got %+v, %v", cfg, err)
	}
	if shown.UserCode != "ABCD-2345" || !strings.Contains(shown.VerificationURL, "code=ABCD-2345") {
		t.Fatalf("prompt wrong: %+v", shown)
	}
}

func TestLoginDeniedAndExpired(t *testing.T) {
	for status, want := range map[string]string{"denied": "denied", "expired": "expired"} {
		status := status
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/start") {
				_, _ = w.Write([]byte(`{"deviceCode":"dc","userCode":"ABCD-2345","expiresInSec":30,"intervalSec":1}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"` + status + `"}`))
		}))
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, err := Login(ctx, nil, srv.URL, "laptop", Info{}, nil)
		cancel()
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s: got %v", status, err)
		}
	}
}
