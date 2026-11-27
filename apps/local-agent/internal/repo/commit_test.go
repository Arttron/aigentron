package repo

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func identify(t *testing.T, dir string) {
	t.Helper()
	git(t, dir, "config", "user.name", "Person")
	git(t, dir, "config", "user.email", "person@example.com")
}

func TestCommitFilesCommitsOnlyWhatWasNamed(t *testing.T) {
	root, _ := fixture(t)
	identify(t, root.Path)
	ctx := context.Background()
	write(t, root.Path, "a.txt", "one\nedited\n")
	write(t, root.Path, "new.go", "package x\n")
	write(t, root.Path, "other.txt", "not in this commit\n")
	git(t, root.Path, "add", "other.txt") // staged by the person: must stay staged, uncommitted
	headBefore := strings.TrimSpace(git(t, root.Path, "rev-parse", "HEAD"))

	res, err := CommitFiles(ctx, root, "fix: a thing\n\nbody", []string{"a.txt", "./new.go", "a.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Branch != "main" || len(res.Files) != 2 || res.Commit == "" {
		t.Fatalf("%+v", res)
	}
	files := git(t, root.Path, "show", "--name-only", "--format=%an <%ae>%n%s", "HEAD")
	for _, want := range []string{"Person <person@example.com>", "fix: a thing", "a.txt", "new.go"} {
		if !strings.Contains(files, want) {
			t.Errorf("%q missing from:\n%s", want, files)
		}
	}
	if strings.Contains(files, "other.txt") {
		t.Fatalf("an unnamed file was committed:\n%s", files)
	}
	if strings.TrimSpace(git(t, root.Path, "rev-parse", "HEAD~1")) != headBefore {
		t.Fatal("not exactly one new commit")
	}
	if st := git(t, root.Path, "status", "--porcelain=v1"); !strings.Contains(st, "A  other.txt") {
		t.Fatalf("the person's own staging was disturbed:\n%s", st)
	}
	if strings.Contains(git(t, root.Path, "log", "origin/main..HEAD", "--oneline"), "") && strings.TrimSpace(git(t, root.Path, "rev-parse", "origin/main")) != headBefore {
		t.Fatal("something was pushed")
	}
}

func TestCommitFilesRefusals(t *testing.T) {
	root, _ := fixture(t)
	identify(t, root.Path)
	ctx := context.Background()
	write(t, root.Path, "a.txt", "changed\n")
	write(t, root.Path, ".env", "SECRET=1\n")
	write(t, root.Path, "key.pem", "KEY\n")
	write(t, root.Path, "dir/inside.txt", "x\n")
	outside := t.TempDir()
	_ = os.WriteFile(filepath.Join(outside, "o.txt"), []byte("o"), 0o644)
	_ = os.Symlink(outside, filepath.Join(root.Path, "lnk"))
	head := strings.TrimSpace(git(t, root.Path, "rev-parse", "HEAD"))

	bad := map[string][]string{
		"never list":     {".env"},
		"never (case)":   {".ENV"},
		"key":            {"a.txt", "key.pem"}, // one bad file spoils the whole commit
		"absolute":       {"/etc/passwd"},
		"climbing":       {"../x"},
		"git folder":     {".git/config"},
		"a folder":       {"dir"},
		"the root":       {"."},
		"a glob":         {"*.txt"},
		"pathspec magic": {":(top)a.txt"},
		"through a link": {"lnk/o.txt"},
		"nothing":        {},
		"missing":        {"nope.txt"},
	}
	for name, paths := range bad {
		if _, err := CommitFiles(ctx, root, "msg", paths); err == nil {
			t.Errorf("%s: %v was accepted", name, paths)
		}
	}
	for name, msg := range map[string]string{"empty": "  ", "huge": strings.Repeat("x", 5000), "nul": "a\x00b"} {
		if _, err := CommitFiles(ctx, root, msg, []string{"a.txt"}); err == nil {
			t.Errorf("message %s accepted", name)
		}
	}
	if strings.TrimSpace(git(t, root.Path, "rev-parse", "HEAD")) != head {
		t.Fatal("a refused commit still committed")
	}
	if st := git(t, root.Path, "diff", "--cached", "--name-only"); strings.TrimSpace(st) != "" {
		t.Fatalf("a refused commit left things staged: %q", st)
	}
}

func TestCommitFilesStateRefusals(t *testing.T) {
	root, _ := fixture(t)
	identify(t, root.Path)
	ctx := context.Background()
	write(t, root.Path, "a.txt", "changed\n")

	_ = os.WriteFile(filepath.Join(root.Path, ".git", "MERGE_HEAD"), []byte("x"), 0o644)
	if _, err := CommitFiles(ctx, root, "m", []string{"a.txt"}); err == nil || !strings.Contains(err.Error(), "merge") {
		t.Errorf("during a merge: %v", err)
	}
	_ = os.Remove(filepath.Join(root.Path, ".git", "MERGE_HEAD"))

	git(t, root.Path, "config", "filter.x.clean", "cat")
	if _, err := CommitFiles(ctx, root, "m", []string{"a.txt"}); err == nil || !strings.Contains(err.Error(), "filter") {
		t.Errorf("with a filter: %v", err)
	}
	git(t, root.Path, "config", "--unset", "filter.x.clean")

	git(t, root.Path, "checkout", "-q", "--detach")
	if _, err := CommitFiles(ctx, root, "m", []string{"a.txt"}); err == nil || !strings.Contains(err.Error(), "detached") {
		t.Errorf("detached: %v", err)
	}
}

func TestCommitFilesNeedsAnIdentityAndIgnoresHooks(t *testing.T) {
	root, _ := fixture(t)
	ctx := context.Background()
	marker := filepath.Join(t.TempDir(), "hook-ran")
	hook := filepath.Join(root.Path, ".git", "hooks", "pre-commit")
	_ = os.MkdirAll(filepath.Dir(hook), 0o755)
	_ = os.WriteFile(hook, []byte("#!/bin/sh\ntouch "+marker+"\n"), 0o755)
	git(t, root.Path, "config", "core.hooksPath", filepath.Dir(hook))
	write(t, root.Path, "a.txt", "changed\n")
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	if _, err := CommitFiles(ctx, root, "m", []string{"a.txt"}); err == nil || !strings.Contains(err.Error(), "user.email") {
		t.Fatalf("no identity must be refused with advice: %v", err)
	}
	identify(t, root.Path)
	if _, err := CommitFiles(ctx, root, "m", []string{"a.txt"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a hook of the repository ran")
	}
}

func TestCommitFilesCommitsADeletion(t *testing.T) {
	root, _ := fixture(t)
	identify(t, root.Path)
	_ = os.Remove(filepath.Join(root.Path, "a.txt"))
	if _, err := CommitFiles(context.Background(), root, "remove a", []string{"a.txt"}); err != nil {
		t.Fatal(err)
	}
	if out := git(t, root.Path, "show", "--name-status", "--format=", "HEAD"); !strings.Contains(out, "D\ta.txt") {
		t.Fatalf("%q", out)
	}
}
