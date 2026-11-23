package policy

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
)

// Root is a repository the person allowed.
type Root struct {
	ID   string `json:"id"`   // short, stable: what the server uses to name it
	Path string `json:"path"` // the real absolute path
}

func idOf(p string) string {
	h := sha1.Sum([]byte(p))
	return hex.EncodeToString(h[:])[:8]
}

func rootsFile() (string, error) {
	d, err := config.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "roots.json"), nil
}

// LoadRoots returns the allowed repositories (paths that no longer exist are kept: they simply report an error).
func LoadRoots() ([]Root, error) {
	f, err := rootsFile()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(f)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var paths []string
	if err := json.Unmarshal(b, &paths); err != nil {
		return nil, fmt.Errorf("%s: %w", f, err)
	}
	out := make([]Root, 0, len(paths))
	for _, p := range paths {
		out = append(out, Root{ID: idOf(p), Path: p})
	}
	return out, nil
}

func saveRoots(roots []Root) error {
	f, err := rootsFile()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f), 0o700); err != nil {
		return err
	}
	paths := make([]string, 0, len(roots))
	for _, r := range roots {
		paths = append(paths, r.Path)
	}
	sort.Strings(paths)
	b, _ := json.MarshalIndent(paths, "", "  ")
	tmp := f + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, f)
}

// AddRoot allows one repository: the path must be the top folder of a git working tree.
func AddRoot(p string) (Root, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return Root{}, err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return Root{}, fmt.Errorf("no such folder: %s", p)
	}
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		return Root{}, fmt.Errorf("%s is not a folder", p)
	}
	if err := CheckRoot(real); err != nil {
		return Root{}, err
	}
	out, err := exec.Command("git", "-C", real, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return Root{}, fmt.Errorf("%s is not inside a git repository", real)
	}
	top, _ := filepath.EvalSymlinks(strings.TrimSpace(string(out)))
	if top != real {
		return Root{}, fmt.Errorf("%s is a subfolder of the repository %s — add the repository's top folder", real, top)
	}
	roots, err := LoadRoots()
	if err != nil {
		return Root{}, err
	}
	for _, r := range roots {
		if r.Path == real {
			return r, nil // already there
		}
	}
	r := Root{ID: idOf(real), Path: real}
	return r, saveRoots(append(roots, r))
}

// RemoveRoot forgets a repository (by id or path); false when it was not there.
func RemoveRoot(idOrPath string) (bool, error) {
	roots, err := LoadRoots()
	if err != nil {
		return false, err
	}
	want := idOrPath
	if abs, err := filepath.Abs(idOrPath); err == nil {
		if real, err := filepath.EvalSymlinks(abs); err == nil {
			want = real
		}
	}
	var keep []Root
	found := false
	for _, r := range roots {
		if r.ID == idOrPath || r.Path == want {
			found = true
			continue
		}
		keep = append(keep, r)
	}
	if !found {
		return false, nil
	}
	return true, saveRoots(keep)
}

// Find returns the root with this id.
func Find(roots []Root, id string) (Root, bool) {
	for _, r := range roots {
		if r.ID == id {
			return r, true
		}
	}
	return Root{}, false
}
