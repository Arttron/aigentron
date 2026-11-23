package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fake(t *testing.T, onChat func(w http.ResponseWriter, body map[string]any)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			_, _ = io.WriteString(w, `{"data":[{"id":"qwen3-coder:30b"},{"id":"secret-model"}]}`)
		case "/v1/chat/completions":
			b, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(b, &body)
			onChat(w, body)
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestCheckURL(t *testing.T) {
	for _, u := range []string{"http://localhost:11434", "http://127.0.0.1:1234/v1", "http://[::1]:8080"} {
		if _, err := CheckURL(u, false); err != nil {
			t.Errorf("%s: %v", u, err)
		}
	}
	if got, _ := CheckURL("http://localhost:1234/v1/", false); got != "http://localhost:1234" {
		t.Errorf("normalized to %q", got)
	}
	for _, u := range []string{"http://192.168.1.5:11434", "https://api.example.com", "ftp://localhost", "http://user:pw@localhost:1", "localhost:1234", ""} {
		if _, err := CheckURL(u, false); err == nil {
			t.Errorf("%q must be refused", u)
		}
	}
	if _, err := CheckURL("http://192.168.1.5:11434", true); err != nil {
		t.Errorf("remote with the flag: %v", err)
	}
}

func TestAllowed(t *testing.T) {
	c := Config{Allow: []string{"qwen3-coder*", "llama3.2:3b"}}
	for m, want := range map[string]bool{"qwen3-coder:30b": true, "llama3.2:3b": true, "gpt-oss": false, "": false} {
		if c.Allowed(m) != want {
			t.Errorf("%q: want %v", m, want)
		}
	}
	if (Config{}).Allowed("anything") {
		t.Error("nothing is shared by default")
	}
	if !(Config{Allow: []string{"*"}}).Allowed("x") {
		t.Error("* shares everything")
	}
}

func TestListModelsOnlyAllowed(t *testing.T) {
	srv := fake(t, nil)
	defer srv.Close()
	c := Config{Backends: []Backend{{Name: "o", URL: srv.URL}, {Name: "dead", URL: "http://127.0.0.1:1"}}, Allow: []string{"qwen*"}}
	models, problems := ListModels(context.Background(), c)
	if len(models) != 1 || models[0].ID != "qwen3-coder:30b" {
		t.Fatalf("models = %+v", models)
	}
	if len(problems) != 1 || !strings.HasPrefix(problems[0], "dead:") {
		t.Fatalf("problems = %v", problems)
	}
	if m, _ := ListModels(context.Background(), Config{Backends: c.Backends}); len(m) != 0 {
		t.Fatal("no allow list → nothing is listed")
	}
}

func TestChatStreamsAndForcesStream(t *testing.T) {
	var sawStream atomic.Bool
	srv := fake(t, func(w http.ResponseWriter, body map[string]any) {
		sawStream.Store(body["stream"] == true)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, s := range []string{`{"choices":[{"delta":{"content":"Hel"}}]}`, `{"choices":[{"delta":{"content":"lo"}}]}`} {
			_, _ = io.WriteString(w, "data: "+s+"\n\n")
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	})
	defer srv.Close()
	c := Config{Backends: []Backend{{Name: "o", URL: srv.URL}}, Allow: []string{"qwen*"}}
	var got []string
	res, err := NewRunner().Chat(context.Background(), c, ChatArgs{ID: "1", Request: json.RawMessage(`{"model":"qwen3-coder:30b","stream":false,"messages":[]}`)}, func(p string) { got = append(got, p) })
	if err != nil {
		t.Fatal(err)
	}
	if !sawStream.Load() || len(got) != 2 || res["done"] != true || res["chunks"] != 2 {
		t.Fatalf("stream=%v got=%v res=%v", sawStream.Load(), got, res)
	}
}

func TestChatRefusals(t *testing.T) {
	srv := fake(t, func(w http.ResponseWriter, _ map[string]any) { t.Error("must not reach the model server") })
	defer srv.Close()
	r := NewRunner()
	c := Config{Backends: []Backend{{Name: "o", URL: srv.URL}}, Allow: []string{"qwen*"}}
	for name, a := range map[string]ChatArgs{
		"model not shared": {Request: json.RawMessage(`{"model":"secret-model"}`)},
		"no model":         {Request: json.RawMessage(`{"messages":[]}`)},
		"not json":         {Request: json.RawMessage(`[1]`)},
		"empty":            {},
		"unknown backend":  {Backend: "x", Request: json.RawMessage(`{"model":"qwen3"}`)},
	} {
		if _, err := r.Chat(context.Background(), c, a, func(string) {}); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
	if _, err := r.Chat(context.Background(), Config{Allow: []string{"*"}}, ChatArgs{Request: json.RawMessage(`{"model":"q"}`)}, func(string) {}); err == nil {
		t.Error("no backend: must be refused")
	}
}

func TestChatBackendErrorAndCancel(t *testing.T) {
	bad := fake(t, func(w http.ResponseWriter, _ map[string]any) { http.Error(w, "model not loaded", 500) })
	defer bad.Close()
	c := Config{Backends: []Backend{{Name: "o", URL: bad.URL}}, Allow: []string{"*"}}
	if _, err := NewRunner().Chat(context.Background(), c, ChatArgs{Request: json.RawMessage(`{"model":"q"}`)}, func(string) {}); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("err = %v", err)
	}

	started := make(chan struct{})
	stop := make(chan struct{})
	slow := fake(t, func(w http.ResponseWriter, _ map[string]any) {
		_, _ = io.WriteString(w, "data: {\"x\":1}\n\n")
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-time.After(10 * time.Second):
		case <-stop:
		}
	})
	defer slow.Close()
	defer close(stop)
	c.Backends[0].URL = slow.URL
	r := NewRunner()
	done := make(chan map[string]any, 1)
	go func() {
		res, _ := r.Chat(context.Background(), c, ChatArgs{ID: "job", Request: json.RawMessage(`{"model":"q"}`)}, func(string) {})
		done <- res
	}()
	<-started
	r.Cancel("job")
	select {
	case res := <-done:
		if res["cancelled"] != true {
			t.Fatalf("res = %v", res)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not stop the request")
	}
}

func TestParallelLimit(t *testing.T) {
	release := make(chan struct{})
	var running, peak atomic.Int32
	srv := fake(t, func(w http.ResponseWriter, _ map[string]any) {
		n := running.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		<-release
		running.Add(-1)
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	})
	defer srv.Close()
	c := Config{Backends: []Backend{{Name: "o", URL: srv.URL}}, Allow: []string{"*"}, Parallel: 1}
	r := NewRunner()
	for i := 0; i < 2; i++ {
		go func() {
			_, _ = r.Chat(context.Background(), c, ChatArgs{Request: json.RawMessage(`{"model":"q"}`)}, func(string) {})
		}()
	}
	time.Sleep(400 * time.Millisecond)
	if peak.Load() != 1 {
		t.Fatalf("with parallel 1, %d ran at once", peak.Load())
	}
	close(release)
}

func TestAddBackendNames(t *testing.T) {
	var c Config
	if err := c.AddBackend("ok", "http://localhost:1234", false); err != nil {
		t.Fatal(err)
	}
	if err := c.AddBackend("bad name", "http://localhost:1", false); err == nil {
		t.Error("spaces refused")
	}
	if err := c.AddBackend("ok", "http://localhost:9999", false); err != nil || len(c.Backends) != 1 || c.Backends[0].URL != "http://localhost:9999" {
		t.Errorf("re-adding replaces: %+v %v", c.Backends, err)
	}
}
