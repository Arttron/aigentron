package policy

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestNeverReason(t *testing.T) {
	for _, bad := range []string{".env", "app/.env", ".env.production", "keys/server.pem", "a/b/id_rsa", "id_ed25519.pub", ".npmrc", ".git/config", "sub/.git/hooks/x", ".ssh/known_hosts", "x/.aws/credentials", "cert.p12", ".config/gcloud/creds.json", ".netrc"} {
		if NeverReason(bad) == "" {
			t.Errorf("%s must be refused", bad)
		}
	}
	for _, ok := range []string{"README.md", "src/main.go", ".env.example", "config/.env.sample", "environment.ts", "gitignore.txt", ".github/workflows/x.yml", "docs/keys.md", "my.keyboard"} {
		if why := NeverReason(ok); why != "" {
			t.Errorf("%s must be allowed, got: %s", ok, why)
		}
	}
}

func TestDiffExcludesCoverTheList(t *testing.T) {
	ex := strings.Join(DiffExcludes(), " ")
	for _, want := range []string{"**/.env", "**/*.pem", "**/.git/**", "**/id_rsa*"} {
		if !strings.Contains(ex, want) {
			t.Errorf("missing %s in %s", want, ex)
		}
	}
}

func TestResolveStaysInsideTheRoot(t *testing.T) {
	root := t.TempDir()
	root, _ = filepath.EvalSymlinks(root)
	_ = os.MkdirAll(filepath.Join(root, "src"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "src", "a.go"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(root, ".env"), []byte("S=1"), 0o644)
	outside := t.TempDir()
	_ = os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("s"), 0o644)
	_ = os.Symlink(outside, filepath.Join(root, "link"))
	_ = os.Symlink(filepath.Join(root, ".env"), filepath.Join(root, "innocent.txt"))

	if p, err := Resolve(root, "src/a.go"); err != nil || p != filepath.Join(root, "src", "a.go") {
		t.Errorf("good path: %v %v", p, err)
	}
	if p, err := Resolve(root, ""); err != nil || p != root {
		t.Errorf("the root itself: %v %v", p, err)
	}
	for name, rel := range map[string]string{
		"absolute":         "/etc/passwd",
		"climbing":         "../x",
		"climbing inside":  "src/../../x",
		"never list":       ".env",
		"symlink out":      "link/secret.txt",
		"link to a secret": "innocent.txt",
		"missing":          "nope.txt",
		"git internals":    ".git/config",
		"nul byte":         "a\x00b",
	} {
		if p, err := Resolve(root, rel); err == nil {
			t.Errorf("%s: %q was accepted as %s", name, rel, p)
		}
	}
}

func TestCheckRoot(t *testing.T) {
	home, _ := os.UserHomeDir()
	for _, bad := range []string{"/", home, filepath.Dir(home), filepath.Join(home, ".ssh"), "relative/path"} {
		if err := CheckRoot(bad); err == nil {
			t.Errorf("%q must not be a root", bad)
		}
	}
	if err := CheckRoot(filepath.Join(home, "Code", "project")); err != nil {
		t.Errorf("a project folder must be fine: %v", err)
	}
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestAddAndRemoveRoots(t *testing.T) {
	t.Setenv("AIGENTRON_LOCAL_HOME", t.TempDir())
	repo, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, repo, "init", "-q")
	r, err := AddRoot(repo)
	if err != nil || r.Path != repo || len(r.ID) != 8 {
		t.Fatalf("%+v %v", r, err)
	}
	if again, err := AddRoot(repo); err != nil || again.ID != r.ID {
		t.Fatal("adding twice must be a no-op")
	}
	roots, _ := LoadRoots()
	if len(roots) != 1 {
		t.Fatalf("%v", roots)
	}
	_ = os.MkdirAll(filepath.Join(repo, "sub"), 0o755)
	if _, err := AddRoot(filepath.Join(repo, "sub")); err == nil || !strings.Contains(err.Error(), "top folder") {
		t.Errorf("a subfolder must be refused: %v", err)
	}
	if _, err := AddRoot(t.TempDir()); err == nil {
		t.Error("a folder that is not a repository must be refused")
	}
	if ok, err := RemoveRoot(r.ID); !ok || err != nil {
		t.Fatalf("remove by id: %v %v", ok, err)
	}
	if ok, _ := RemoveRoot(repo); ok {
		t.Error("already removed")
	}
	if roots, _ := LoadRoots(); len(roots) != 0 {
		t.Fatal("not removed")
	}
}

// A bypass attempt must not get past the never-list by spelling: case (macOS and Windows disks ignore it), dots, slashes.
func TestNeverReasonSpellingTricks(t *testing.T) {
	for _, bad := range []string{".ENV", ".Env.local", "KEYS/Server.PEM", "ID_RSA", "Id_Ed25519", ".GIT/config", "x/.Git/hooks/y", ".SSH/id_rsa", "./.env", "src/../.env", "a/./.env", ".env/", "x//.env", ".NPMRC"} {
		if NeverReason(bad) == "" {
			t.Errorf("%q must be refused", bad)
		}
	}
	for _, ok := range []string{".ENV.EXAMPLE", ".Env.Sample"} {
		if why := NeverReason(ok); why != "" {
			t.Errorf("%q is an example file and must be allowed, got: %s", ok, why)
		}
	}
}

// Links inside the repository must not lead to a secret, to the git folder, or outside — whatever the link's own name looks like.
func TestResolveLinkTricks(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	outside, _ := filepath.EvalSymlinks(t.TempDir())
	_ = os.MkdirAll(filepath.Join(root, ".git"), 0o755)
	_ = os.WriteFile(filepath.Join(root, ".git", "config"), []byte("[core]"), 0o644)
	_ = os.MkdirAll(filepath.Join(root, "src"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "src", "a.go"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("s"), 0o644)
	// a relative link to the git folder, a link to a file outside (absolute and by climbing), a chain of links, a link to the root's parent
	_ = os.Symlink(".git", filepath.Join(root, "gitlink"))
	_ = os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "abs.txt"))
	_ = os.Symlink("../"+filepath.Base(outside)+"/secret.txt", filepath.Join(root, "rel.txt"))
	_ = os.Symlink("abs.txt", filepath.Join(root, "chain1"))
	_ = os.Symlink("chain1", filepath.Join(root, "chain2"))
	_ = os.Symlink("..", filepath.Join(root, "src", "up"))
	_ = os.Symlink(filepath.Join(root, "src", "a.go"), filepath.Join(root, "ok-link.go"))

	for name, rel := range map[string]string{
		"link to .git folder":    "gitlink/config",
		"absolute link out":      "abs.txt",
		"relative link out":      "rel.txt",
		"chain of links":         "chain2",
		"link to the parent":     "src/up/" + filepath.Base(outside) + "/secret.txt",
		"link then climb":        "gitlink/../abs.txt",
		"backslash climbing":     `..\..\x`,
		"trailing slash on .env": ".env/",
	} {
		if p, err := Resolve(root, rel); err == nil {
			t.Errorf("%s: %q was accepted as %s", name, rel, p)
		}
	}
	// a link that stays inside and leads to a normal file is fine
	if p, err := Resolve(root, "ok-link.go"); err != nil || p != filepath.Join(root, "src", "a.go") {
		t.Errorf("an inside link: %v %v", p, err)
	}
}

// Roots must not be a way in either: a link to the home folder or to a secret folder is refused once resolved.
func TestCheckRootRefusesLinksToForbiddenPlaces(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home")
	}
	link := filepath.Join(t.TempDir(), "h")
	if err := os.Symlink(home, link); err != nil {
		t.Skip("no symlinks")
	}
	// AddRoot resolves the path before checking; the link must not hide the home folder
	if _, err := AddRoot(link); err == nil {
		_, _ = RemoveRoot(link)
		t.Error("a link to the home folder was accepted as a root")
	}
}
