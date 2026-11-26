package repo

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveWIPKeepsWorkWithoutTouchingTheTree(t *testing.T) {
	root, _ := fixture(t)
	ctx := context.Background()
	write(t, root.Path, "a.txt", "one\nedited\n")
	write(t, root.Path, "new.txt", "brand new\n")
	write(t, root.Path, ".env", "TOKEN=SUPERSECRET\n")
	write(t, root.Path, "mine/ignored.log", "skip me\n")
	before := git(t, root.Path, "status", "--porcelain=v1")
	headBefore := strings.TrimSpace(git(t, root.Path, "rev-parse", "HEAD"))

	sha, err := SaveWIP(ctx, root, "main", []string{"mine/**"}, 5)
	if err != nil || sha == "" {
		t.Fatalf("%q %v", sha, err)
	}
	// the person's tree, index and branch are exactly as they were
	if after := git(t, root.Path, "status", "--porcelain=v1"); after != before {
		t.Fatalf("status changed:\n%s\nvs\n%s", before, after)
	}
	if strings.TrimSpace(git(t, root.Path, "rev-parse", "HEAD")) != headBefore {
		t.Fatal("HEAD moved")
	}
	if b, _ := os.ReadFile(filepath.Join(root.Path, "a.txt")); string(b) != "one\nedited\n" {
		t.Fatal("a file changed")
	}
	// the snapshot holds the edit and the new file, but not the secret nor the ignored folder
	files := git(t, root.Path, "ls-tree", "-r", "--name-only", sha)
	for _, want := range []string{"a.txt", "new.txt"} {
		if !strings.Contains(files, want) {
			t.Errorf("%s missing from the snapshot:\n%s", want, files)
		}
	}
	for _, bad := range []string{".env", "ignored.log"} {
		if strings.Contains(files, bad) {
			t.Errorf("%s must not be in the snapshot:\n%s", bad, files)
		}
	}
	if got := git(t, root.Path, "show", sha+":a.txt"); got != "one\nedited\n" {
		t.Errorf("snapshot content: %q", got)
	}
	// nothing changed since: no second snapshot
	if again, err := SaveWIP(ctx, root, "main", []string{"mine/**"}, 5); err != nil || again != "" {
		t.Fatalf("a repeat must be skipped: %q %v", again, err)
	}
	list, _ := ListWIP(ctx, root, "main")
	if len(list) != 1 || list[0].Commit != sha {
		t.Fatalf("%+v", list)
	}
}

func TestSaveWIPOfACleanTreeAndKeepLimit(t *testing.T) {
	root, _ := fixture(t)
	ctx := context.Background()
	if sha, err := SaveWIP(ctx, root, "main", nil, 3); err != nil || sha != "" {
		t.Fatalf("a clean tree has nothing to keep: %q %v", sha, err)
	}
	for i := 0; i < 5; i++ {
		write(t, root.Path, "a.txt", strings.Repeat("x", i+1)+"\n")
		if sha, err := SaveWIP(ctx, root, "main", nil, 3); err != nil || sha == "" {
			t.Fatalf("snapshot %d: %q %v", i, sha, err)
		}
	}
	list, _ := ListWIP(ctx, root, "main")
	if len(list) != 3 {
		t.Fatalf("keep 3, got %d", len(list))
	}
	if got := git(t, root.Path, "show", list[0].Commit+":a.txt"); got != "xxxxx\n" {
		t.Errorf("newest first: %q", got)
	}
}

func TestSaveWIPRefusesARepositoryWithItsOwnFilter(t *testing.T) {
	root, _ := fixture(t)
	git(t, root.Path, "config", "filter.evil.clean", "touch /tmp/aigentron-pwned")
	write(t, root.Path, "a.txt", "changed\n")
	if _, err := SaveWIP(context.Background(), root, "main", nil, 3); err == nil || !strings.Contains(err.Error(), "filter") {
		t.Fatalf("got %v", err)
	}
}

func TestRestoreWIP(t *testing.T) {
	root, _ := fixture(t)
	ctx := context.Background()
	write(t, root.Path, "a.txt", "precious work\n")
	sha, _ := SaveWIP(ctx, root, "main", nil, 5)
	git(t, root.Path, "checkout", "--", "a.txt") // the work is lost from the tree
	if err := RestoreWIP(ctx, root, sha, false); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root.Path, "a.txt")); string(b) != "precious work\n" {
		t.Fatalf("not restored: %q", b)
	}
	// a dirty tree is not overwritten without force; with force the current state is saved first
	write(t, root.Path, "a.txt", "newer\n")
	if err := RestoreWIP(ctx, root, sha, false); err == nil {
		t.Fatal("a dirty tree must be refused")
	}
	if err := RestoreWIP(ctx, root, sha, true); err != nil {
		t.Fatal(err)
	}
	list, _ := ListWIP(ctx, root, "main")
	if len(list) != 2 || git(t, root.Path, "show", list[0].Commit+":a.txt") != "newer\n" {
		t.Fatalf("the state before the forced restore must be kept: %+v", list)
	}
	// only the repository's own snapshots, and only by commit id
	if err := RestoreWIP(ctx, root, strings.TrimSpace(git(t, root.Path, "rev-parse", "HEAD")), true); err == nil {
		t.Error("an ordinary commit is not a snapshot")
	}
	if err := RestoreWIP(ctx, root, "--help", true); err == nil {
		t.Error("an option must not pass as a commit id")
	}
}

func TestFetchAndFastForward(t *testing.T) {
	root, bare := fixture(t)
	ctx := context.Background()
	// someone else pushes a commit
	other, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, other, "clone", "-q", bare, ".")
	write(t, other, "b.txt", "from elsewhere\n")
	git(t, other, "add", ".")
	git(t, other, "commit", "-qm", "remote work")
	git(t, other, "push", "-q", "origin", "main")

	if ok, err := FastForward(ctx, root); err != nil || ok {
		t.Fatalf("before a fetch there is nothing to move to: %v %v", ok, err)
	}
	if err := Fetch(ctx, root); err != nil {
		t.Fatal(err)
	}
	if st := ReadStatus(ctx, root); st.Behind != 1 {
		t.Fatalf("behind: %+v", st)
	}
	write(t, root.Path, "a.txt", "dirty\n")
	if _, err := FastForward(ctx, root); err == nil {
		t.Fatal("a dirty tree must not be fast-forwarded")
	}
	git(t, root.Path, "checkout", "--", "a.txt")
	if ok, err := FastForward(ctx, root); err != nil || !ok {
		t.Fatalf("%v %v", ok, err)
	}
	if _, err := os.Stat(filepath.Join(root.Path, "b.txt")); err != nil {
		t.Fatal("the new commit was not brought in")
	}
	// a diverged branch is refused, never merged
	write(t, root.Path, "c.txt", "local\n")
	git(t, root.Path, "add", ".")
	git(t, root.Path, "commit", "-qm", "local work")
	write(t, other, "d.txt", "more\n")
	git(t, other, "add", ".")
	git(t, other, "commit", "-qm", "more remote work")
	git(t, other, "push", "-q", "origin", "main")
	_ = Fetch(ctx, root)
	if ok, err := FastForward(ctx, root); err == nil || ok {
		t.Fatalf("a diverged branch must be refused: %v %v", ok, err)
	}
}

func TestBusy(t *testing.T) {
	root, _ := fixture(t)
	if why := Busy(ReadStatus(context.Background(), root)); why != "" {
		t.Fatalf("free repository reported busy: %s", why)
	}
	_ = os.WriteFile(filepath.Join(root.Path, ".git", "index.lock"), nil, 0o644)
	if why := Busy(ReadStatus(context.Background(), root)); !strings.Contains(why, "index.lock") {
		t.Fatalf("%q", why)
	}
	_ = os.Remove(filepath.Join(root.Path, ".git", "index.lock"))
	_ = os.WriteFile(filepath.Join(root.Path, ".git", "MERGE_HEAD"), []byte("x"), 0o644)
	if why := Busy(ReadStatus(context.Background(), root)); !strings.Contains(why, "merge") {
		t.Fatalf("%q", why)
	}
}

// A hostile repository config must not run a program during a fetch.
func TestFetchIgnoresHostileConfig(t *testing.T) {
	root, _ := fixture(t)
	marker := filepath.Join(t.TempDir(), "pwned")
	git(t, root.Path, "config", "core.sshCommand", "touch "+marker)
	git(t, root.Path, "config", "core.gitProxy", "touch "+marker)
	git(t, root.Path, "config", "remote.origin.uploadpack", "touch "+marker+"; git-upload-pack")
	_ = Fetch(context.Background(), root)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a program from the repository's config ran")
	}
}
