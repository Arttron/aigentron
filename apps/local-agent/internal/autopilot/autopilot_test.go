package autopilot

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
	"github.com/Arttron/aigentron/apps/local-agent/internal/rules"
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func write(t *testing.T, dir, rel, s string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

type fixture struct {
	root  policy.Root
	bare  string
	clock time.Time
	eng   *Engine
	logs  []string
}

func setup(t *testing.T, mod func(*rules.Effective)) *fixture {
	t.Helper()
	bare, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, bare, "init", "-q", "--bare", "-b", "main")
	work, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, work, "init", "-q", "-b", "main")
	git(t, work, "remote", "add", "origin", bare)
	write(t, work, "a.txt", "one\n")
	git(t, work, "add", ".")
	git(t, work, "commit", "-qm", "first")
	git(t, work, "push", "-qu", "origin", "main")
	f := &fixture{root: policy.Root{ID: "r1", Path: work}, bare: bare, clock: time.Now()}
	eff := rules.Defaults()
	if mod != nil {
		mod(&eff)
	}
	f.eng = &Engine{
		Roots: func() ([]policy.Root, error) { return []policy.Root{f.root}, nil },
		Rules: func(policy.Root) (rules.Effective, []string) { return eff, nil },
		Now:   func() time.Time { return f.clock },
		Tick:  time.Minute,
		Log: func(op string, _ policy.Root, detail string, err error) {
			s := op + " " + detail
			if err != nil {
				s += " ERR " + err.Error()
			}
			f.logs = append(f.logs, s)
		},
	}
	return f
}

// touch sets a file's modification time (the engine reads "when was it last edited" from the files).
func (f *fixture) touch(t *testing.T, rel string, age time.Duration) {
	t.Helper()
	at := f.clock.Add(-age)
	if err := os.Chtimes(filepath.Join(f.root.Path, rel), at, at); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) count(prefix string) int {
	n := 0
	for _, l := range f.logs {
		if strings.HasPrefix(l, prefix) {
			n++
		}
	}
	return n
}

func TestSnapshotWaitsForTheEditorToGoQuiet(t *testing.T) {
	f := setup(t, func(e *rules.Effective) { e.Fetch.Enabled = false; e.Snapshot.IdleMinutes = 2 })
	write(t, f.root.Path, "a.txt", "work\n")
	f.touch(t, "a.txt", 30*time.Second) // edited half a minute ago
	f.eng.Step(context.Background())
	if f.count("auto.snapshot") != 0 {
		t.Fatalf("a file edited 30 s ago is still being worked on: %v", f.logs)
	}
	f.touch(t, "a.txt", 3*time.Minute)
	f.eng.Step(context.Background())
	if f.count("auto.snapshot") != 1 {
		t.Fatalf("after 3 quiet minutes the work is kept: %v", f.logs)
	}
	f.eng.Step(context.Background())
	if f.count("auto.snapshot") != 1 {
		t.Fatalf("the same state is not kept twice: %v", f.logs)
	}
	if got := git(t, f.root.Path, "for-each-ref", "refs/aigentron/wip/"); !strings.Contains(got, "refs/aigentron/wip/main/") {
		t.Fatalf("no snapshot ref: %q", got)
	}
}

func TestNothingHappensDuringAMergeOrALock(t *testing.T) {
	f := setup(t, func(e *rules.Effective) { e.Snapshot.IdleMinutes = 1; e.Fetch.EveryMinutes = 1 })
	write(t, f.root.Path, "a.txt", "work\n")
	f.touch(t, "a.txt", time.Hour)
	_ = os.WriteFile(filepath.Join(f.root.Path, ".git", "MERGE_HEAD"), []byte("x"), 0o644)
	f.eng.Step(context.Background())
	_ = os.Remove(filepath.Join(f.root.Path, ".git", "MERGE_HEAD"))
	_ = os.WriteFile(filepath.Join(f.root.Path, ".git", "index.lock"), nil, 0o644)
	f.eng.Step(context.Background())
	if len(f.logs) != 0 {
		t.Fatalf("the engine acted while the repository was busy: %v", f.logs)
	}
	_ = os.Remove(filepath.Join(f.root.Path, ".git", "index.lock"))
	f.eng.Step(context.Background())
	if f.count("auto.snapshot") != 1 {
		t.Fatalf("once free it works: %v", f.logs)
	}
}

func TestFetchEveryNMinutesAndFastForwardOnlyWhenAllowed(t *testing.T) {
	f := setup(t, func(e *rules.Effective) {
		e.Snapshot.Enabled = false
		e.Fetch.EveryMinutes = 5
		e.FastForward.Enabled = false
	})
	other, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, other, "clone", "-q", f.bare, ".")
	write(t, other, "b.txt", "x\n")
	git(t, other, "add", ".")
	git(t, other, "commit", "-qm", "remote")
	git(t, other, "push", "-q", "origin", "main")

	f.eng.Step(context.Background()) // first pass fetches at once
	if !strings.Contains(git(t, f.root.Path, "status", "-sb"), "behind 1") {
		t.Fatal("fetch did not run")
	}
	if _, err := os.Stat(filepath.Join(f.root.Path, "b.txt")); err == nil {
		t.Fatal("fast-forward is off: the tree must not change")
	}
	// a second pass 1 minute later does not fetch again (it would show as a new remote commit)
	write(t, other, "c.txt", "y\n")
	git(t, other, "add", ".")
	git(t, other, "commit", "-qm", "remote 2")
	git(t, other, "push", "-q", "origin", "main")
	f.clock = f.clock.Add(time.Minute)
	f.eng.Step(context.Background())
	if !strings.Contains(git(t, f.root.Path, "status", "-sb"), "behind 1") {
		t.Fatal("fetched again before the interval")
	}
	f.clock = f.clock.Add(5 * time.Minute)
	f.eng.Step(context.Background())
	if !strings.Contains(git(t, f.root.Path, "status", "-sb"), "behind 2") {
		t.Fatal("did not fetch after the interval")
	}
}

func TestFastForwardWhenOn(t *testing.T) {
	f := setup(t, func(e *rules.Effective) { e.Snapshot.Enabled = false; e.FastForward.Enabled = true })
	other, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, other, "clone", "-q", f.bare, ".")
	write(t, other, "b.txt", "x\n")
	git(t, other, "add", ".")
	git(t, other, "commit", "-qm", "remote")
	git(t, other, "push", "-q", "origin", "main")
	f.eng.Step(context.Background())
	if _, err := os.Stat(filepath.Join(f.root.Path, "b.txt")); err != nil {
		t.Fatalf("not fast-forwarded: %v", f.logs)
	}
	if f.count("auto.fast-forward") != 1 {
		t.Fatalf("%v", f.logs)
	}
}

func TestFastForwardRefusalIsLoggedOnce(t *testing.T) {
	f := setup(t, func(e *rules.Effective) {
		e.Snapshot.Enabled = false
		e.FastForward.Enabled = true
		e.Fetch.EveryMinutes = 1
	})
	write(t, f.root.Path, "l.txt", "local\n")
	git(t, f.root.Path, "add", ".")
	git(t, f.root.Path, "commit", "-qm", "local")
	other, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, other, "clone", "-q", f.bare, ".")
	write(t, other, "b.txt", "x\n")
	git(t, other, "add", ".")
	git(t, other, "commit", "-qm", "remote")
	git(t, other, "push", "-q", "origin", "main")
	for i := 0; i < 4; i++ {
		f.eng.Step(context.Background())
		f.clock = f.clock.Add(2 * time.Minute)
	}
	if f.count("auto.fast-forward") != 1 {
		t.Fatalf("a diverged branch is refused, and said once: %v", f.logs)
	}
	if _, err := os.Stat(filepath.Join(f.root.Path, "b.txt")); err == nil {
		t.Fatal("a diverged branch was merged")
	}
}

func TestAllRulesOffDoesNothing(t *testing.T) {
	f := setup(t, func(e *rules.Effective) {
		e.Snapshot.Enabled, e.Fetch.Enabled, e.FastForward.Enabled = false, false, false
	})
	write(t, f.root.Path, "a.txt", "work\n")
	f.touch(t, "a.txt", time.Hour)
	f.eng.Step(context.Background())
	if len(f.logs) != 0 {
		t.Fatalf("%v", f.logs)
	}
}

type sent struct {
	name string
	data map[string]any
}

func capture(f *fixture, up *bool) *[]sent {
	var out []sent
	f.eng.Emit = func(name string, data any) bool {
		if up != nil && !*up {
			return false
		}
		out = append(out, sent{name, data.(map[string]any)})
		return true
	}
	return &out
}

func TestNoticeOncePerEpisode(t *testing.T) {
	f := setup(t, func(e *rules.Effective) {
		e.Snapshot.Enabled, e.Fetch.Enabled = false, false
		e.Notify.DirtyAfterMinutes, e.Notify.BehindAfterMinutes = 60, 30
	})
	up := false
	out := capture(f, &up)
	write(t, f.root.Path, "a.txt", "work\n")
	f.eng.Step(context.Background()) // dirty is seen now
	f.clock = f.clock.Add(61 * time.Minute)
	f.eng.Step(context.Background()) // the line is down: nothing sent, nothing marked
	if len(*out) != 0 {
		t.Fatal("sent while the line was down")
	}
	up = true
	f.eng.Step(context.Background())
	f.eng.Step(context.Background())
	if len(*out) != 1 || (*out)[0].name != "notice" || (*out)[0].data["kind"] != "dirty" || (*out)[0].data["repo"] != "r1" || (*out)[0].data["count"] != 1 {
		t.Fatalf("one dirty notice expected: %+v", *out)
	}
	if _, has := (*out)[0].data["files"]; has {
		t.Fatal("a notice carries counts, not names")
	}
	// the tree is committed (episode over), then dirty again for another hour: a new notice
	git(t, f.root.Path, "checkout", "--", "a.txt")
	f.eng.Step(context.Background())
	write(t, f.root.Path, "a.txt", "again\n")
	f.eng.Step(context.Background())
	f.clock = f.clock.Add(61 * time.Minute)
	f.eng.Step(context.Background())
	if len(*out) != 2 {
		t.Fatalf("a new episode gets its own notice: %+v", *out)
	}
}

func TestBehindNotice(t *testing.T) {
	f := setup(t, func(e *rules.Effective) {
		e.Snapshot.Enabled = false
		e.Fetch.EveryMinutes = 1
		e.Notify.BehindAfterMinutes = 30
	})
	out := capture(f, nil)
	other, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, other, "clone", "-q", f.bare, ".")
	write(t, other, "b.txt", "x\n")
	git(t, other, "add", ".")
	git(t, other, "commit", "-qm", "remote")
	git(t, other, "push", "-q", "origin", "main")
	f.eng.Step(context.Background()) // fetched: behind 1 is seen
	f.clock = f.clock.Add(31 * time.Minute)
	f.eng.Step(context.Background())
	if len(*out) != 1 || (*out)[0].data["kind"] != "behind" || (*out)[0].data["count"] != 1 {
		t.Fatalf("%+v", *out)
	}
}

func TestProposeCommitNeedsIdleAndNeverNamesSecrets(t *testing.T) {
	f := setup(t, func(e *rules.Effective) {
		e.Snapshot.Enabled, e.Fetch.Enabled, e.Notify.Enabled = false, false, false
		e.ProposeCommit.Enabled, e.ProposeCommit.IdleMinutes = true, 30
	})
	out := capture(f, nil)
	write(t, f.root.Path, "a.txt", "work\n")
	write(t, f.root.Path, "new.go", "package x\n")
	write(t, f.root.Path, ".env.local", "S=1\n")
	f.touch(t, "a.txt", 5*time.Minute)
	f.touch(t, "new.go", 5*time.Minute)
	f.touch(t, ".env.local", 5*time.Minute)
	f.eng.Step(context.Background())
	if len(*out) != 0 {
		t.Fatal("proposed while the person is still active")
	}
	f.clock = f.clock.Add(40 * time.Minute)
	f.eng.Step(context.Background())
	f.eng.Step(context.Background())
	if len(*out) != 1 || (*out)[0].name != "propose-commit" {
		t.Fatalf("%+v", *out)
	}
	files := (*out)[0].data["files"].([]map[string]string)
	var names []string
	for _, x := range files {
		names = append(names, x["path"])
	}
	joined := strings.Join(names, ",")
	if !strings.Contains(joined, "a.txt") || !strings.Contains(joined, "new.go") || strings.Contains(joined, ".env") {
		t.Fatalf("file list: %v", names)
	}
}
