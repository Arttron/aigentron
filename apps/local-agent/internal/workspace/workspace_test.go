package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckRepoURL(t *testing.T) {
	for _, ok := range []string{"https://github.com/acme/shop.git", "ssh://git@example.com/acme/web.git", "git@github.com:acme/api.git", "git://example.com/x.git"} {
		if _, err := CheckRepoURL(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{
		"", "   ", "/home/me/shop", "./shop", "../shop", "file:///srv/git/shop.git", "ext::sh -c touch% /tmp/x", "--upload-pack=touch /tmp/x", "-oProxyCommand=x",
		"https://user:secret@github.com/acme/shop.git", "ftp://x.com/y", "https://", "https://github.com/a b", "github.com", "C:\\repo", "fd::17/foo",
	} {
		if _, err := CheckRepoURL(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}

func TestNormalize(t *testing.T) {
	same := []string{"https://github.com/Acme/Shop.git", "git@github.com:acme/shop.git", "ssh://git@GitHub.com/acme/shop", "https://github.com/acme/shop/"}
	for _, a := range same {
		if Normalize(a) != "github.com/acme/shop" {
			t.Errorf("%s → %q", a, Normalize(a))
		}
	}
	if Normalize("https://github.com/acme/shop2") == Normalize("https://github.com/acme/shop") || Normalize("garbage") != "" {
		t.Error("different repositories must differ")
	}
}

func TestFolderName(t *testing.T) {
	for in, want := range map[string]string{"Shop": "shop", "My Shop!": "my-shop", "../../etc": "etc", "": "project", "..": "project", "a/b": "a-b"} {
		if got := FolderName(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

func TestCheckDest(t *testing.T) {
	d := t.TempDir()
	if k, err := CheckDest(filepath.Join(d, "new")); err != nil || k != DestFree {
		t.Errorf("free: %v %v", k, err)
	}
	if _, err := CheckDest(filepath.Join(d, "no", "parent")); err == nil {
		t.Error("a missing parent must be refused")
	}
	os.Mkdir(filepath.Join(d, "empty"), 0o755)
	if k, _ := CheckDest(filepath.Join(d, "empty")); k != DestEmpty {
		t.Error("empty")
	}
	os.WriteFile(filepath.Join(d, "full"), nil, 0o644)
	if _, err := CheckDest(filepath.Join(d, "full")); err == nil {
		t.Error("a file is not a folder")
	}
	os.Mkdir(filepath.Join(d, "busy"), 0o755)
	os.WriteFile(filepath.Join(d, "busy", "x"), []byte("x"), 0o644)
	if k, _ := CheckDest(filepath.Join(d, "busy")); k != DestExists {
		t.Error("busy")
	}
	os.Symlink(d, filepath.Join(d, "link"))
	if _, err := CheckDest(filepath.Join(d, "link")); err == nil {
		t.Error("a link is refused")
	}
}

func git(t *testing.T, dir string, a ...string) {
	t.Helper()
	c := exec.Command("git", append([]string{"-C", dir}, a...)...)
	c.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", a, err, out)
	}
}

func TestCloneRunsNothingFromTheRepository(t *testing.T) {
	src := t.TempDir()
	git(t, src, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(src, "a.txt"), []byte("a"), 0o644)
	git(t, src, "add", ".")
	git(t, src, "commit", "-qm", "init")
	dest := filepath.Join(t.TempDir(), "shop")
	// the template hooks a clone could copy must not run: point the templates at a folder with a post-checkout hook
	tpl := t.TempDir()
	os.MkdirAll(filepath.Join(tpl, "hooks"), 0o755)
	marker := filepath.Join(t.TempDir(), "RAN")
	os.WriteFile(filepath.Join(tpl, "hooks", "post-checkout"), []byte("#!/bin/sh\ntouch "+marker+"\n"), 0o755)
	t.Setenv("GIT_TEMPLATE_DIR", tpl)
	devnull, _ := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err := Clone(context.Background(), src, dest, "main", [3]*os.File{devnull, devnull, devnull}, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "a.txt")); err != nil {
		t.Fatal("not cloned")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a hook ran during the clone")
	}
	if got := OriginOf(context.Background(), dest); got != src {
		t.Errorf("origin %q", got)
	}
	if top := TopOf(context.Background(), dest); !strings.HasSuffix(top, "shop") {
		t.Errorf("top %q", top)
	}
	// a local path is refused unless the test allows it (the real command never does)
	if err := Clone(context.Background(), src, filepath.Join(t.TempDir(), "x"), "", [3]*os.File{devnull, devnull, devnull}, false); err == nil {
		t.Error("file transport must be off")
	}
}
