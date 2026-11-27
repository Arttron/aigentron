// Package autopilot is the rules engine (L2): on a timer it looks at every allowed repository and does what the effective rules allow — keep a snapshot of
// unsaved work, fetch, fast-forward a clean branch. It never acts while the person is working (a file touched in the last few seconds, a merge or
// rebase in progress, git's own lock held). The actions themselves are in package repo and are safe by construction (see there).
package autopilot

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
	"github.com/Arttron/aigentron/apps/local-agent/internal/repo"
	"github.com/Arttron/aigentron/apps/local-agent/internal/rules"
)

// Engine holds what it needs from outside, so tests can drive it with a fake clock and fake folders.
type Engine struct {
	Roots func() ([]policy.Root, error)
	// Rules returns the effective rules of one repository (global + its own file) and any warnings.
	Rules func(root policy.Root) (rules.Effective, []string)
	Now   func() time.Time
	Tick  time.Duration
	// Emit sends an event to the server (false = the line is down: the event is sent again at the next pass). Nil = no server (tests, offline).
	Emit func(name string, data any) bool
	// Log is told about every action (and every failure); the journal hangs here.
	Log func(op string, root policy.Root, detail string, err error)

	mu    sync.Mutex
	state map[string]*repoState
}

type repoState struct {
	dirtySince, behindSince time.Time // when the condition was first seen (zero = not now)
	dirtyNoticed            bool      // the notice of this episode went out
	behindNoticed           bool
	proposed                bool // a commit proposal for this dirty episode went out
	lastFetch               time.Time
	lastFFError             string // the last refusal that was logged, so the same one is not logged every tick
}

// New makes an engine with the real rules and clock.
func New(roots func() ([]policy.Root, error), emit func(string, any) bool, log func(string, policy.Root, string, error)) *Engine {
	return &Engine{
		Roots: roots,
		Rules: func(root policy.Root) (rules.Effective, []string) {
			_, global, err := rules.LoadGlobal()
			var gp *rules.Layer
			if err == nil {
				gp = &global
			}
			project, _, _ := rules.LoadProject(root.Path)
			return rules.Merge(gp, project)
		},
		Now:   time.Now,
		Tick:  30 * time.Second,
		Emit:  emit,
		Log:   log,
		state: map[string]*repoState{},
	}
}

// Run steps until ctx ends.
func (e *Engine) Run(ctx context.Context) {
	t := time.NewTicker(e.Tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e.Step(ctx)
		}
	}
}

func (e *Engine) st(id string) *repoState {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.state == nil {
		e.state = map[string]*repoState{}
	}
	s := e.state[id]
	if s == nil {
		s = &repoState{}
		e.state[id] = s
	}
	return s
}

func (e *Engine) log(op string, root policy.Root, detail string, err error) {
	if e.Log != nil {
		e.Log(op, root, detail, err)
	}
}

// Step is one pass over every repository.
func (e *Engine) Step(ctx context.Context) {
	roots, err := e.Roots()
	if err != nil {
		return
	}
	for _, root := range roots {
		if ctx.Err() != nil {
			return
		}
		e.stepRepo(ctx, root)
	}
}

func (e *Engine) stepRepo(ctx context.Context, root policy.Root) {
	eff, _ := e.Rules(root)
	if !eff.Snapshot.Enabled && !eff.Fetch.Enabled && !eff.FastForward.Enabled && !eff.Notify.Enabled && !eff.ProposeCommit.Enabled {
		return
	}
	now := e.Now()
	status := repo.ReadStatus(ctx, root)
	e.watchTimers(root, eff, status, now)
	if repo.Busy(status) != "" {
		return // the person (or git) is in the middle of something: do nothing, try again next time
	}
	typing := time.Duration(eff.Quiet.TypingSeconds) * time.Second
	touched := repo.LastTouched(status)
	quiet := func(d time.Duration) bool { return touched.IsZero() || now.Sub(touched) >= d }

	// 1. keep unsaved work: only when something is changed and nobody has touched it for idleMinutes
	if eff.Snapshot.Enabled && repo.Dirty(status) > 0 && quiet(time.Duration(eff.Snapshot.IdleMinutes)*time.Minute) {
		sha, err := repo.SaveWIP(ctx, root, status.Branch, eff.Ignore, eff.Snapshot.Keep)
		switch {
		case err != nil:
			e.log("auto.snapshot", root, "", err)
		case sha != "":
			e.log("auto.snapshot", root, sha[:7], nil)
		}
	}

	// 2. fetch on a timer (never pull)
	s := e.st(root.ID)
	fetched := false
	if eff.Fetch.Enabled && quiet(typing) && now.Sub(s.lastFetch) >= time.Duration(eff.Fetch.EveryMinutes)*time.Minute {
		s.lastFetch = now // also after a failure: an offline laptop must not retry every tick
		if status.Origin != "" || status.Upstream != "" {
			if err := repo.Fetch(ctx, root); err != nil {
				e.log("auto.fetch", root, "", err)
			} else {
				fetched = true
				status = repo.ReadStatus(ctx, root) // what the fetch just showed (behind / ahead) counts from now
				e.watchTimers(root, eff, status, now)
			}
		}
	}

	// 3. a long-idle dirty tree: ask the server to open a task that suggests a commit (it never commits by itself)
	e.proposeCommit(root, eff, status, quiet(time.Duration(eff.ProposeCommit.IdleMinutes)*time.Minute))

	// 4. fast-forward a clean branch (off by default): only just after a fetch or when already behind, and while the person is not typing
	if eff.FastForward.Enabled && quiet(typing) && (fetched || status.Behind > 0) {
		moved, err := repo.FastForward(ctx, root)
		switch {
		case err != nil:
			// "has local commits", "uncommitted changes" and the like are normal states, not failures worth a line each tick
			if s.lastFFError != err.Error() {
				s.lastFFError = err.Error()
				e.log("auto.fast-forward", root, "", err)
			}
		case moved:
			s.lastFFError = ""
			e.log("auto.fast-forward", root, fmt.Sprintf("%d commit(s)", status.Behind), nil)
		}
	}
}

// watchTimers keeps "since when" for the two conditions the notify rule watches and sends one notice per episode (an episode ends when the condition clears).
// A notice carries counts and names, never file contents.
func (e *Engine) watchTimers(root policy.Root, eff rules.Effective, st repo.Status, now time.Time) {
	s := e.st(root.ID)
	if repo.Dirty(st) == 0 {
		s.dirtySince, s.dirtyNoticed, s.proposed = time.Time{}, false, false
	} else if s.dirtySince.IsZero() {
		s.dirtySince = now
	}
	if st.Behind == 0 {
		s.behindSince, s.behindNoticed = time.Time{}, false
	} else if s.behindSince.IsZero() {
		s.behindSince = now
	}
	if !eff.Notify.Enabled || e.Emit == nil {
		return
	}
	if !s.dirtyNoticed && !s.dirtySince.IsZero() && now.Sub(s.dirtySince) >= time.Duration(eff.Notify.DirtyAfterMinutes)*time.Minute {
		if e.Emit("notice", map[string]any{"repo": root.ID, "kind": "dirty", "branch": st.Branch, "minutes": int(now.Sub(s.dirtySince).Minutes()), "count": repo.Dirty(st)}) {
			s.dirtyNoticed = true
			e.log("auto.notice", root, "dirty", nil)
		}
	}
	if !s.behindNoticed && !s.behindSince.IsZero() && now.Sub(s.behindSince) >= time.Duration(eff.Notify.BehindAfterMinutes)*time.Minute {
		if e.Emit("notice", map[string]any{"repo": root.ID, "kind": "behind", "branch": st.Branch, "minutes": int(now.Sub(s.behindSince).Minutes()), "count": st.Behind, "upstream": st.Upstream}) {
			s.behindNoticed = true
			e.log("auto.notice", root, "behind", nil)
		}
	}
}

// proposeCommit asks for a commit suggestion once per dirty episode. Only the names of changed files go out (never the never-list's, never contents).
func (e *Engine) proposeCommit(root policy.Root, eff rules.Effective, st repo.Status, idle bool) {
	s := e.st(root.ID)
	if !eff.ProposeCommit.Enabled || e.Emit == nil || s.proposed || !idle || st.Staged+st.Unstaged+st.Untracked == 0 || st.Detached {
		return
	}
	files := make([]map[string]string, 0, 50)
	for _, f := range st.Files {
		if policy.NeverReason(f.Path) != "" || len(files) >= 50 {
			continue
		}
		files = append(files, map[string]string{"path": f.Path, "xy": f.XY})
	}
	if len(files) == 0 {
		return
	}
	if e.Emit("propose-commit", map[string]any{"repo": root.ID, "branch": st.Branch, "files": files, "idleMinutes": eff.ProposeCommit.IdleMinutes}) {
		s.proposed = true
		e.log("auto.propose-commit", root, fmt.Sprintf("%d file(s)", len(files)), nil)
	}
}
