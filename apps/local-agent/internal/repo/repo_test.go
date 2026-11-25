package repo

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
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

func write(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// a repository with a remote: main has one commit pushed
func fixture(t *testing.T) (policy.Root, string) {
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
	return policy.Root{ID: "abcd1234", Path: work}, bare
}

func TestStatusCounts(t *testing.T) {
	root, _ := fixture(t)
	ctx := context.Background()
	st := ReadStatus(ctx, root)
	if st.Error != "" || st.Branch != "main" || st.Upstream != "origin/main" || st.Ahead != 0 || st.Behind != 0 || len(st.Files) != 0 || st.Head == "" {
		t.Fatalf("clean: %+v", st)
	}
	write(t, root.Path, "a.txt", "two\n")    // unstaged edit
	write(t, root.Path, "b.txt", "new\n")    // untracked
	write(t, root.Path, "c.txt", "staged\n") // staged add
	git(t, root.Path, "add", "c.txt")
	write(t, root.Path, "a.txt", "two\nthree\n")
	git(t, root.Path, "commit", "-qam", "local") // ahead 1
	write(t, root.Path, "a.txt", "four\n")       // dirty again
	st = ReadStatus(ctx, root)
	if st.Ahead != 1 || st.Unstaged != 1 || st.Untracked != 1 || st.Staged != 0 || len(st.Files) != 2 {
		t.Fatalf("dirty: %+v", st)
	}
}

func TestBehindAndOriginWithoutCredentials(t *testing.T) {
	root, bare := fixture(t)
	other, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, other, "clone", "-q", bare, ".")
	write(t, other, "x.txt", "x\n")
	git(t, other, "add", ".")
	git(t, other, "commit", "-qm", "remote work")
	git(t, other, "push", "-q")
	git(t, root.Path, "fetch", "-q")
	if st := ReadStatus(context.Background(), root); st.Behind != 1 || st.Ahead != 0 {
		t.Fatalf("%+v", st)
	}
	git(t, root.Path, "remote", "set-url", "origin", "https://user:ghp_SECRET@github.com/acme/shop.git")
	st := ReadStatus(context.Background(), root)
	if st.Origin != "https://github.com/acme/shop.git" || strings.Contains(st.Origin, "SECRET") {
		t.Fatalf("a token leaked: %q", st.Origin)
	}
}

func TestStripCredentials(t *testing.T) {
	for in, want := range map[string]string{
		"https://tok@github.com/a/b.git": "https://github.com/a/b.git",
		"https://u:p@host:8443/a/b":      "https://host:8443/a/b",
		"git@github.com:acme/shop.git":   "git@github.com:acme/shop.git",
		"ssh://git@host/a/b.git":         "ssh://host/a/b.git",
		"file:///srv/git/shop.git":       "file:///srv/git/shop.git",
		"":                               "",
	} {
		if got := StripCredentials(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

func TestStateInProgress(t *testing.T) {
	root, _ := fixture(t)
	git(t, root.Path, "checkout", "-qb", "side")
	write(t, root.Path, "a.txt", "side\n")
	git(t, root.Path, "commit", "-qam", "side")
	git(t, root.Path, "checkout", "-q", "main")
	write(t, root.Path, "a.txt", "main\n")
	git(t, root.Path, "commit", "-qam", "main")
	cmd := exec.Command("git", "-C", root.Path, "merge", "side")
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	_ = cmd.Run() // conflicts
	st := ReadStatus(context.Background(), root)
	if st.State != "merge" || st.Conflicted != 1 {
		t.Fatalf("%+v", st)
	}
}

func TestDiffNeverShowsSecrets(t *testing.T) {
	root, _ := fixture(t)
	git(t, root.Path, "config", "user.name", "t")
	write(t, root.Path, ".env", "TOKEN=old\n")
	write(t, root.Path, "server.pem", "KEY-old\n")
	write(t, root.Path, "src/code.go", "package a\n")
	git(t, root.Path, "add", "-f", ".")
	git(t, root.Path, "commit", "-qm", "with secrets")
	write(t, root.Path, ".env", "TOKEN=SUPERSECRET\n")
	write(t, root.Path, "server.pem", "KEY-SUPERSECRET\n")
	write(t, root.Path, "src/code.go", "package a\n// changed\n")
	res, err := ReadDiff(context.Background(), root, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(res.Out, "SUPERSECRET") || strings.Contains(res.Out, ".env") || strings.Contains(res.Out, "server.pem") {
		t.Fatalf("a secret is in the diff:\n%s", res.Out)
	}
	if !strings.Contains(res.Out, "// changed") {
		t.Fatalf("the real change is missing:\n%s", res.Out)
	}
	if _, err := ReadDiff(context.Background(), root, ".ENV", false); err == nil {
		t.Error("asking for the diff of .ENV (another spelling of .env) must be refused")
	}
	if _, err := ReadDiff(context.Background(), root, ".env", false); err == nil {
		t.Error("asking for the diff of .env must be refused")
	}
	if _, err := ReadDiff(context.Background(), root, "../etc/passwd", false); err == nil {
		t.Error("climbing out must be refused")
	}
}

// The diff's exclusions ignore case too: a changed "KEY.PEM" or ".Env" must not leak on any disk.
func TestDiffExcludesOtherSpellings(t *testing.T) {
	root, _ := fixture(t)
	git(t, root.Path, "config", "user.name", "t")
	write(t, root.Path, "KEY.PEM", "old\n")
	write(t, root.Path, "cfg/.Env", "old\n")
	git(t, root.Path, "add", "-f", ".")
	git(t, root.Path, "commit", "-qm", "caps")
	write(t, root.Path, "KEY.PEM", "SUPERSECRET\n")
	write(t, root.Path, "cfg/.Env", "SUPERSECRET\n")
	res, err := ReadDiff(context.Background(), root, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(res.Out, "SUPERSECRET") {
		t.Fatalf("a secret is in the diff:\n%s", res.Out)
	}
}

func TestLog(t *testing.T) {
	root, _ := fixture(t)
	write(t, root.Path, "b.txt", "b\n")
	git(t, root.Path, "add", ".")
	git(t, root.Path, "commit", "-qm", "second commit")
	log, err := ReadLog(context.Background(), root, 10, "")
	if err != nil || len(log) != 2 || log[0].Subject != "second commit" || len(log[0].Hash) != 40 {
		t.Fatalf("%+v %v", log, err)
	}
	one, err := ReadLog(context.Background(), root, 10, "a.txt")
	if err != nil || len(one) != 1 || one[0].Subject != "first" {
		t.Fatalf("by path: %+v %v", one, err)
	}
	if _, err := ReadLog(context.Background(), root, 10, ".env"); err == nil {
		t.Error("log of a never-list path must be refused")
	}
}

func TestReadFile(t *testing.T) {
	root, _ := fixture(t)
	write(t, root.Path, "big.txt", strings.Repeat("0123456789\n", 10000)) // 110 KB
	write(t, root.Path, "bin.dat", "ab\x00cd")
	write(t, root.Path, ".env", "S=1")
	c, err := ReadFile(root, "a.txt", 0, 0)
	if err != nil || c.Text != "one\n" || c.More {
		t.Fatalf("%+v %v", c, err)
	}
	c, err = ReadFile(root, "big.txt", 0, 0)
	if err != nil || len(c.Text) != 64*1024 || !c.More {
		t.Fatalf("first chunk: %d %v %v", len(c.Text), c.More, err)
	}
	c2, _ := ReadFile(root, "big.txt", len(c.Text), 0)
	if c2.Offset != 64*1024 || c2.More {
		t.Fatalf("second chunk: %+v", c2.More)
	}
	for _, bad := range []string{".env", ".ENV", "./.env", "src/../.env", "bin.dat", "../x", "/etc/passwd", ".git/config", "nope", "."} {
		if _, err := ReadFile(root, bad, 0, 0); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}

// A repository's own config must not be able to run a program: core.fsmonitor and an external diff are the classic ways.
func TestHostileRepositoryConfigDoesNotRun(t *testing.T) {
	root, _ := fixture(t)
	marker := filepath.Join(t.TempDir(), "pwned")
	script := filepath.Join(t.TempDir(), "evil.sh")
	_ = os.WriteFile(script, []byte("#!/bin/sh\ntouch "+marker+"\n"), 0o755)
	git(t, root.Path, "config", "core.fsmonitor", script)
	git(t, root.Path, "config", "diff.external", script)
	git(t, root.Path, "config", "core.pager", script)
	git(t, root.Path, "config", "alias.status", "!"+script) // aliases cannot shadow built-ins, but be sure
	write(t, root.Path, "a.txt", "changed\n")
	ctx := context.Background()
	ReadStatus(ctx, root)
	if _, err := ReadDiff(ctx, root, "", false); err != nil {
		t.Logf("diff: %v", err)
	}
	if _, err := ReadLog(ctx, root, 5, ""); err != nil {
		t.Logf("log: %v", err)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a repository's config ran a program on this machine")
	}
}

func TestWatcherReportsChangesOnceAndAgainOnFlush(t *testing.T) {
	root, _ := fixture(t)
	var sent []map[string]any
	online := true
	w := NewWatcher(func() ([]policy.Root, error) { return []policy.Root{root}, nil }, func(name string, data any) bool {
		if !online {
			return false
		}
		sent = append(sent, data.(map[string]any))
		return true
	})
	ctx := context.Background()
	w.poll(ctx, true)
	w.poll(ctx, false) // nothing changed: silent
	if len(sent) != 1 {
		t.Fatalf("want 1 event, got %d", len(sent))
	}
	write(t, root.Path, "z.txt", "z\n")
	w.poll(ctx, false)
	if len(sent) != 2 {
		t.Fatalf("a change must be reported: %d", len(sent))
	}
	online = false
	write(t, root.Path, "y.txt", "y\n")
	w.poll(ctx, false) // offline: not sent, not marked as sent
	online = true
	w.poll(ctx, false)
	if len(sent) != 3 {
		t.Fatalf("the change made while offline must arrive once the line is back: %d", len(sent))
	}
}

func TestWatcherRunStopsWithContext(t *testing.T) {
	root, _ := fixture(t)
	w := NewWatcher(func() ([]policy.Root, error) { return []policy.Root{root}, nil }, func(string, any) bool { return true })
	w.Interval = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	time.Sleep(60 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not stop")
	}
}

// The `repos` event fixture is shared with the orchestrator (local-repos.test.ts): what the daemon sends must fit what the server reads.
func TestReposEventFixtureMatchesStatus(t *testing.T) {
	b, err := os.ReadFile("../../../../packages/shared/protocol/local-agent/event-repos.json")
	if err != nil {
		t.Fatal(err)
	}
	var ev struct {
		Type string `json:"type"`
		Name string `json:"name"`
		Data struct {
			Repos []Status `json:"repos"`
		} `json:"data"`
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields() // a field the fixture has and Status lacks (or the reverse) is a contract break
	if err := dec.Decode(&ev); err != nil {
		t.Fatal(err)
	}
	if len(ev.Data.Repos) != 1 || ev.Data.Repos[0].Ahead != 1 || ev.Data.Repos[0].Files[1].XY != "??" {
		t.Fatalf("%+v", ev)
	}
	// and a real Status encodes to keys the server knows
	out, _ := json.Marshal(Status{ID: "a1b2c3d4", Files: []File{}})
	for _, key := range []string{`"id"`, `"branch"`, `"ahead"`, `"files"`} {
		if !strings.Contains(string(out), key) {
			t.Errorf("missing %s in %s", key, out)
		}
	}
}
