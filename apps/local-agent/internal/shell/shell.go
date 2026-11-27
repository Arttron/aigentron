// Package shell runs one command the server asked for, in an allowed folder: with a cleaned environment (no tokens the person's shell happens to hold),
// a time limit, a cap on what comes back, and a way to cut it off (the person's Stop, or a task that ended). It is NOT a sandbox: the command can reach
// whatever the person's own account can reach, which is why the server asks the person before it sends one (the same classification as a command on a
// server agent) and why the owner must have turned writes on here.
package shell

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	MaxCommand     = 8000
	DefaultTimeout = 120 * time.Second
	MaxTimeout     = 10 * time.Minute
	headBytes      = 8 * 1024
	tailBytes      = 16 * 1024
)

// Result is how a command ended.
type Result struct {
	Exit      int    `json:"exit"`
	Output    string `json:"output"`
	Truncated bool   `json:"truncated,omitempty"`
	TimedOut  bool   `json:"timedOut,omitempty"`
	Cancelled bool   `json:"cancelled,omitempty"`
	Ms        int64  `json:"ms"`
}

// Opts says what to run.
type Opts struct {
	Dir     string
	Command string
	Timeout time.Duration
	// Task names who asked, so that Cancel(task) can cut it off. Empty = not cancellable by name.
	Task string
}

var (
	mu      sync.Mutex
	next    int
	running = map[string]map[int]context.CancelFunc{}
)

// Cancel cuts off every command a task has running; it returns how many.
func Cancel(task string) int {
	if task == "" {
		return 0
	}
	mu.Lock()
	m := running[task]
	delete(running, task)
	mu.Unlock()
	for _, c := range m {
		c()
	}
	return len(m)
}

// CancelAll cuts off everything that is running.
func CancelAll() int {
	mu.Lock()
	all := running
	running = map[string]map[int]context.CancelFunc{}
	mu.Unlock()
	n := 0
	for _, m := range all {
		for _, c := range m {
			c()
			n++
		}
	}
	return n
}

// Env is the environment a command gets: the basics, nothing else (no GITHUB_TOKEN, AWS_*, API keys, SSH agent).
func Env(environ []string) []string {
	keep := map[string]bool{"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "LANG": true, "LC_ALL": true, "TMPDIR": true, "SHELL": true}
	var out []string
	for _, kv := range environ {
		if k, _, ok := strings.Cut(kv, "="); ok && keep[k] {
			out = append(out, kv)
		}
	}
	return append(out, "TERM=dumb", "GIT_TERMINAL_PROMPT=0", "GIT_PAGER=cat", "PAGER=cat", "GIT_EDITOR=true", "NO_COLOR=1")
}

// capture keeps the beginning and the end of what a command prints, however long it runs.
type capture struct {
	head, tail []byte
	total      int
}

func (c *capture) Write(p []byte) (int, error) {
	n := len(p)
	c.total += n
	if len(c.head) < headBytes {
		take := min(headBytes-len(c.head), len(p))
		c.head = append(c.head, p[:take]...)
		p = p[take:]
	}
	c.tail = append(c.tail, p...)
	if len(c.tail) > 2*tailBytes {
		c.tail = append([]byte(nil), c.tail[len(c.tail)-tailBytes:]...)
	}
	return n, nil
}

func (c *capture) text() (string, bool) {
	tail := c.tail
	if len(tail) > tailBytes {
		tail = tail[len(tail)-tailBytes:]
	}
	if c.total <= len(c.head)+len(tail) {
		return strings.ToValidUTF8(string(c.head)+string(tail), "�"), false
	}
	skipped := c.total - len(c.head) - len(tail)
	return strings.ToValidUTF8(string(c.head)+fmt.Sprintf("\n[… %d bytes not shown …]\n", skipped)+string(tail), "�"), true
}

// Run runs the command with `sh -c` in o.Dir.
func Run(ctx context.Context, o Opts) (Result, error) {
	if runtime.GOOS == "windows" {
		return Result{}, errors.New("running commands is not available on Windows yet")
	}
	cmd := strings.TrimSpace(o.Command)
	if cmd == "" || len(o.Command) > MaxCommand || strings.ContainsRune(o.Command, 0) {
		return Result{}, fmt.Errorf("a command of 1–%d characters is required", MaxCommand)
	}
	if st, err := os.Stat(o.Dir); err != nil || !st.IsDir() {
		return Result{}, errors.New("the folder does not exist")
	}
	to := o.Timeout
	if to <= 0 {
		to = DefaultTimeout
	}
	if to > MaxTimeout {
		to = MaxTimeout
	}
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if o.Task != "" {
		mu.Lock()
		next++
		id := next
		if running[o.Task] == nil {
			running[o.Task] = map[int]context.CancelFunc{}
		}
		running[o.Task][id] = cancel
		mu.Unlock()
		defer func() {
			mu.Lock()
			delete(running[o.Task], id)
			if len(running[o.Task]) == 0 {
				delete(running, o.Task)
			}
			mu.Unlock()
		}()
	}
	var timedOut atomic.Bool
	timer := time.AfterFunc(to, func() {
		timedOut.Store(true)
		cancel()
	})
	defer timer.Stop()

	c := exec.Command("/bin/sh", "-c", o.Command)
	c.Dir = o.Dir
	c.Env = Env(os.Environ())
	c.Stdin = nil
	out := &capture{}
	c.Stdout, c.Stderr = out, out
	own(c)
	start := time.Now()
	if err := c.Start(); err != nil {
		return Result{}, err
	}
	done := make(chan error, 1)
	go func() { done <- c.Wait() }()
	var err error
	cancelled := false
	select {
	case err = <-done:
	case <-cctx.Done():
		cancelled = true
		killGroup(c)
		select {
		case err = <-done:
		case <-time.After(3 * time.Second):
		}
	}
	text, trunc := out.text()
	res := Result{Output: text, Truncated: trunc, Ms: time.Since(start).Milliseconds()}
	if cancelled {
		if timedOut.Load() {
			res.TimedOut = true
		} else {
			res.Cancelled = true
		}
		res.Exit = -1
		return res, nil
	}
	var ee *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee):
		res.Exit = ee.ExitCode()
	default:
		return Result{}, err
	}
	return res, nil
}
