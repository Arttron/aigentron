// Package llm lets the server use a model that runs on THIS computer (Ollama, LM Studio, llama.cpp's llama-server — anything that speaks the
// OpenAI-style /v1 API): the server sends a chat request over the line the agent already holds open, the agent forwards it to the local backend and streams
// the answer back. Nothing listens for the server and no port is opened.
//
// The setup is the person's, made on this computer (`aigentron llm …`, a file next to the pairing) and never pushed from the server: the server cannot
// add a backend address (that would let it make this machine call any URL) or widen the list of models it may use. By default nothing is shared.
package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
)

const (
	MaxRequestBytes  = 4 << 20  // what the server may send as one chat request
	MaxResponseBytes = 16 << 20 // what one answer may stream back
	maxLine          = 1 << 20
	DefaultParallel  = 1
	chatTimeout      = 15 * time.Minute
)

// Backend is a model server on this machine.
type Backend struct {
	Name string `json:"name"`
	URL  string `json:"url"` // base, without /v1
	Key  string `json:"key,omitempty"`
}

// Config is llm.json next to the pairing.
type Config struct {
	Backends []Backend `json:"backends"`
	// Allow are the model names (or patterns: `qwen*`, `*`) the server may use. Empty = nothing is shared.
	Allow    []string `json:"allow"`
	Parallel int      `json:"parallel,omitempty"`
}

func file() (string, error) {
	d, err := config.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "llm.json"), nil
}

func Load() (Config, error) {
	p, err := file()
	if err != nil {
		return Config{}, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, fmt.Errorf("%s is not valid: %w", p, err)
	}
	return c, nil
}

func Save(c Config) error {
	p, err := file()
	if err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// CheckURL: http(s), no credentials in it, and a loopback host unless the person said otherwise (a model on another machine of theirs).
func CheckURL(raw string, allowRemote bool) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return "", errors.New("the address must look like http://localhost:11434")
	}
	if !allowRemote {
		h := u.Hostname()
		ip := net.ParseIP(h)
		if !(h == "localhost" || (ip != nil && ip.IsLoopback())) {
			return "", fmt.Errorf("%s is not this computer; add --allow-remote if the model really runs elsewhere", h)
		}
	}
	return strings.TrimRight(strings.TrimSuffix(strings.TrimRight(u.String(), "/"), "/v1"), "/"), nil
}

func (c *Config) AddBackend(name, raw string, allowRemote bool) error {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 40 || strings.ContainsAny(name, " /\\\x00") {
		return errors.New("the name must be a short word without spaces")
	}
	u, err := CheckURL(raw, allowRemote)
	if err != nil {
		return err
	}
	for i := range c.Backends {
		if c.Backends[i].Name == name {
			c.Backends[i].URL = u
			return nil
		}
	}
	c.Backends = append(c.Backends, Backend{Name: name, URL: u})
	return nil
}

func (c *Config) RemoveBackend(name string) bool {
	for i := range c.Backends {
		if c.Backends[i].Name == name {
			c.Backends = append(c.Backends[:i], c.Backends[i+1:]...)
			return true
		}
	}
	return false
}

// Allowed: does a model name match the allow list?
func (c Config) Allowed(model string) bool {
	for _, p := range c.Allow {
		if ok, _ := path.Match(p, model); ok || p == model {
			return true
		}
	}
	return false
}

func (c Config) backend(name string) (Backend, error) {
	if len(c.Backends) == 0 {
		return Backend{}, errors.New("no model server is set up on that computer (aigentron llm add <name> <url>)")
	}
	if name == "" {
		return c.Backends[0], nil
	}
	for _, b := range c.Backends {
		if b.Name == name {
			return b, nil
		}
	}
	return Backend{}, fmt.Errorf("no model server named %q on that computer", name)
}

var client = &http.Client{Timeout: 0}

func (b Backend) req(ctx context.Context, method, p string, body []byte) (*http.Request, error) {
	r, err := http.NewRequestWithContext(ctx, method, b.URL+p, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if b.Key != "" {
		r.Header.Set("Authorization", "Bearer "+b.Key)
	}
	return r, nil
}

// Model is one entry of `llm.models`.
type Model struct {
	Backend string `json:"backend"`
	ID      string `json:"id"`
}

// BackendModels lists every model a backend has (what the person can use here, whatever is shared with the server).
func BackendModels(ctx context.Context, b Backend) ([]string, error) {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	r, err := b.req(cctx, http.MethodGet, "/v1/models", nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(r)
	if err != nil {
		return nil, fmt.Errorf("the model server %q does not answer: %v", b.Name, err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("the model server answered %d", res.StatusCode)
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&out); err != nil {
		return nil, err
	}
	ids := []string{}
	for _, m := range out.Data {
		ids = append(ids, m.ID)
	}
	return ids, nil
}

// ListModels asks every backend which models it has and keeps those the person allowed. A backend that does not answer is reported, not fatal.
func ListModels(ctx context.Context, c Config) (models []Model, problems []string) {
	models = []Model{}
	for _, b := range c.Backends {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		r, err := b.req(cctx, http.MethodGet, "/v1/models", nil)
		if err == nil {
			var res *http.Response
			if res, err = client.Do(r); err == nil {
				var out struct {
					Data []struct {
						ID string `json:"id"`
					} `json:"data"`
				}
				if res.StatusCode != 200 {
					err = fmt.Errorf("answered %d", res.StatusCode)
				} else {
					err = json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&out)
				}
				res.Body.Close()
				for _, m := range out.Data {
					if c.Allowed(m.ID) {
						models = append(models, Model{Backend: b.Name, ID: m.ID})
					}
				}
			}
		}
		cancel()
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", b.Name, err))
		}
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Backend+models[i].ID < models[j].Backend+models[j].ID })
	return models, problems
}

// Runner serves chat requests: at most `Parallel` at a time, each cancellable by id.
type Runner struct {
	mu      sync.Mutex
	running map[string]context.CancelFunc
	slots   chan struct{}
}

func NewRunner() *Runner { return &Runner{running: map[string]context.CancelFunc{}} }

func (r *Runner) slotsFor(n int) chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.slots == nil || cap(r.slots) != n {
		r.slots = make(chan struct{}, n)
	}
	return r.slots
}

// Cancel stops the request with this id (no-op when unknown).
func (r *Runner) Cancel(id string) {
	r.mu.Lock()
	cancel := r.running[id]
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// ChatArgs is the body of the `llm.chat` command: which model server, and the OpenAI-style chat request as the server built it.
type ChatArgs struct {
	ID      string          `json:"id"`
	Backend string          `json:"backend"`
	Request json.RawMessage `json:"request"`
}

// Chat forwards the request with `stream:true` and passes each server-sent line's payload to emit (the caller turns it into an event frame). The model must be on
// the person's allow list; the request is not otherwise inspected or changed beyond forcing streaming.
func (r *Runner) Chat(ctx context.Context, c Config, a ChatArgs, emit func(payload string)) (map[string]any, error) {
	if len(a.Request) == 0 || len(a.Request) > MaxRequestBytes {
		return nil, errors.New("the chat request is missing or too large")
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(a.Request, &body); err != nil {
		return nil, errors.New("the chat request is not a JSON object")
	}
	var model string
	if err := json.Unmarshal(body["model"], &model); err != nil || model == "" {
		return nil, errors.New("the chat request names no model")
	}
	if !c.Allowed(model) {
		return nil, fmt.Errorf("the model %q is not shared from that computer (aigentron llm allow <model>)", model)
	}
	b, err := c.backend(a.Backend)
	if err != nil {
		return nil, err
	}
	body["stream"] = json.RawMessage("true")
	out, _ := json.Marshal(body)

	n := c.Parallel
	if n < 1 {
		n = DefaultParallel
	}
	slots := r.slotsFor(n)
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(30 * time.Second):
		return nil, errors.New("the local model is busy with another request")
	}

	cctx, cancel := context.WithTimeout(ctx, chatTimeout)
	defer cancel()
	if a.ID != "" {
		r.mu.Lock()
		r.running[a.ID] = cancel
		r.mu.Unlock()
		defer func() {
			r.mu.Lock()
			delete(r.running, a.ID)
			r.mu.Unlock()
		}()
	}
	req, err := b.req(cctx, http.MethodPost, "/v1/chat/completions", out)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		if errors.Is(cctx.Err(), context.Canceled) {
			return map[string]any{"cancelled": true, "chunks": 0}, nil
		}
		return nil, fmt.Errorf("the model server %q does not answer: %v", b.Name, err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return nil, fmt.Errorf("the model server answered %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	total, chunks := 0, 0
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		total += len(payload)
		if total > MaxResponseBytes {
			return nil, errors.New("the answer is longer than the limit")
		}
		if payload == "[DONE]" {
			break
		}
		chunks++
		emit(payload)
	}
	if err := sc.Err(); err != nil {
		if errors.Is(cctx.Err(), context.Canceled) {
			return map[string]any{"cancelled": true, "chunks": chunks}, nil
		}
		return nil, fmt.Errorf("the answer broke off: %v", err)
	}
	if errors.Is(cctx.Err(), context.Canceled) {
		return map[string]any{"cancelled": true, "chunks": chunks}, nil
	}
	return map[string]any{"done": true, "chunks": chunks}, nil
}

// Complete sends one NON-streaming chat request to a backend and returns the raw OpenAI-style answer (the local chat uses it; the server path streams instead).
func Complete(ctx context.Context, b Backend, body []byte) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, chatTimeout)
	defer cancel()
	req, err := b.req(cctx, http.MethodPost, "/v1/chat/completions", body)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the model server %q does not answer: %v", b.Name, err)
	}
	defer res.Body.Close()
	out, err := io.ReadAll(io.LimitReader(res.Body, MaxResponseBytes))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("the model server answered %d: %s", res.StatusCode, strings.TrimSpace(string(out[:min(len(out), 400)])))
	}
	return out, nil
}

// Backend returns the named backend (or the first one).
func (c Config) Pick(name string) (Backend, error) { return c.backend(name) }
