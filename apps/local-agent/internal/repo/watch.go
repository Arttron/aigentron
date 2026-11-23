package repo

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
)

// Watcher polls every allowed repository and reports the whole picture (event `repos`) whenever anything in it changed, and again when the line comes back.
// Polling `git status` (without taking locks) every few seconds is cheap and catches what file-system events miss on large trees; finer-grained watching comes with the rules engine.
type Watcher struct {
	Interval time.Duration
	Roots    func() ([]policy.Root, error)
	// Emit sends an event; false = the line is down (the picture is then sent again at the next change or Flush).
	Emit func(name string, data any) bool

	last  string
	flush chan struct{}
}

// NewWatcher makes a watcher; Interval defaults to 5 s.
func NewWatcher(roots func() ([]policy.Root, error), emit func(string, any) bool) *Watcher {
	return &Watcher{Interval: 5 * time.Second, Roots: roots, Emit: emit, flush: make(chan struct{}, 1)}
}

// Flush asks for the picture to be sent again at once (the line just came online).
func (w *Watcher) Flush() {
	select {
	case w.flush <- struct{}{}:
	default:
	}
}

// Snapshot reads every repository now.
func Snapshot(ctx context.Context, roots []policy.Root) []Status {
	out := make([]Status, 0, len(roots))
	for _, r := range roots {
		out = append(out, ReadStatus(ctx, r))
	}
	return out
}

func (w *Watcher) poll(ctx context.Context, force bool) {
	roots, err := w.Roots()
	if err != nil {
		return
	}
	snap := Snapshot(ctx, roots)
	b, _ := json.Marshal(snap)
	if !force && string(b) == w.last {
		return
	}
	if w.Emit("repos", map[string]any{"repos": snap}) {
		w.last = string(b)
	}
}

// Run polls until ctx ends.
func (w *Watcher) Run(ctx context.Context) {
	iv := w.Interval
	if iv <= 0 {
		iv = 5 * time.Second
	}
	w.poll(ctx, true)
	t := time.NewTicker(iv)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.flush:
			w.poll(ctx, true)
		case <-t.C:
			w.poll(ctx, false)
		}
	}
}
