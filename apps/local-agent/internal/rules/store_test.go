package rules

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGlobalRoundTripAndRevision(t *testing.T) {
	t.Setenv("AIGENTRON_LOCAL_HOME", t.TempDir())
	if rev, l, err := LoadGlobal(); err != nil || rev != 0 || l.Snapshot != nil {
		t.Fatalf("nothing synced yet: %d %v", rev, err)
	}
	on := true
	n := 7
	if err := SaveGlobal(5, Layer{FastForward: &FastForward{Enabled: &on}, Snapshot: &Snapshot{IdleMinutes: &n}, ProjectCanEnable: []string{"fetch"}}); err != nil {
		t.Fatal(err)
	}
	rev, l, err := LoadGlobal()
	if err != nil || rev != 5 || !*l.FastForward.Enabled || *l.Snapshot.IdleMinutes != 7 || l.ProjectCanEnable[0] != "fetch" {
		t.Fatalf("got %d %+v %v", rev, l, err)
	}
	p, _ := GlobalPath()
	b, _ := os.ReadFile(p)
	if !strings.HasPrefix(string(b), "# Managed by the Aigentron server") {
		t.Errorf("no header:\n%s", b)
	}
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode().Perm())
	}
}

func TestLoadProject(t *testing.T) {
	repo := t.TempDir()
	if l, _, err := LoadProject(repo); l != nil || err != nil {
		t.Fatalf("no file: %v %v", l, err)
	}
	_ = os.MkdirAll(filepath.Join(repo, ".aigentron"), 0o755)
	write := func(s string) { _ = os.WriteFile(filepath.Join(repo, ".aigentron", "local.yaml"), []byte(s), 0o644) }
	write("snapshot: {idleMinutes: 9}\n")
	l, path, err := LoadProject(repo)
	if err != nil || l == nil || *l.Snapshot.IdleMinutes != 9 || !strings.HasSuffix(path, "local.yaml") {
		t.Fatalf("%v %v %v", l, path, err)
	}
	write("projectCanEnable: [fetch]\n")
	if _, _, err := LoadProject(repo); err == nil || !strings.Contains(err.Error(), "local.yaml") {
		t.Fatalf("a project granting itself power must be refused with the file named: %v", err)
	}
	write("typo: 1\n")
	if _, _, err := LoadProject(repo); err == nil {
		t.Fatal("unknown key accepted")
	}
	// a symlink (to anywhere on the disk) is not read
	_ = os.Remove(filepath.Join(repo, ".aigentron", "local.yaml"))
	secret := filepath.Join(t.TempDir(), "secret")
	_ = os.WriteFile(secret, []byte("snapshot: {idleMinutes: 1}"), 0o600)
	if err := os.Symlink(secret, filepath.Join(repo, ".aigentron", "local.yaml")); err == nil {
		if _, _, err := LoadProject(repo); err == nil {
			t.Fatal("followed a symlink")
		}
	}
	// a huge file is refused
	_ = os.Remove(filepath.Join(repo, ".aigentron", "local.yaml"))
	write(strings.Repeat("# x\n", 40_000))
	if _, _, err := LoadProject(repo); err == nil {
		t.Fatal("huge file accepted")
	}
}
