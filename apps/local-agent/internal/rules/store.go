package rules

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"gopkg.in/yaml.v3"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
)

// ProjectFileNames are looked up in this order inside the repository.
var ProjectFileNames = []string{".aigentron/local.yaml", ".aigentron/local.yml"}

const maxFile = 64 * 1024

var revLine = regexp.MustCompile(`(?m)^# revision: (\d{1,9})\s*$`)

// GlobalPath is where the synced global config is kept on this machine (next to the daemon's own config).
func GlobalPath() (string, error) {
	d, err := config.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "rules.global.yaml"), nil
}

// SaveGlobal writes what the server pushed, atomically. The file is for reading (and works offline); it is overwritten at every sync.
func SaveGlobal(rev int, l Layer) error {
	p, err := GlobalPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	body, err := yaml.Marshal(l)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	fmt.Fprintf(&buf, "# Managed by the Aigentron server (Add-ons → Local agent). Edits here are overwritten at the next sync.\n# revision: %d\n", rev)
	buf.Write(body)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// LoadGlobal reads the synced file; rev 0 and an empty layer when there is none yet (the defaults apply).
func LoadGlobal() (int, Layer, error) {
	p, err := GlobalPath()
	if err != nil {
		return 0, Layer{}, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return 0, Layer{}, nil
	}
	if err != nil {
		return 0, Layer{}, err
	}
	l, err := Parse(b)
	if err != nil {
		return 0, Layer{}, fmt.Errorf("%s: %w", p, err)
	}
	rev := 0
	if m := revLine.FindSubmatch(b); m != nil {
		rev, _ = strconv.Atoi(string(m[1]))
	}
	return rev, l, nil
}

// LoadProject reads the repository's own file; nil (no error) when it has none.
func LoadProject(repo string) (*Layer, string, error) {
	for _, name := range ProjectFileNames {
		p := filepath.Join(repo, filepath.FromSlash(name))
		st, err := os.Lstat(p)
		if err != nil {
			continue
		}
		if !st.Mode().IsRegular() { // a symlink could point anywhere on the disk
			return nil, p, fmt.Errorf("%s is not a regular file", p)
		}
		if st.Size() > maxFile {
			return nil, p, fmt.Errorf("%s is larger than %d KB", p, maxFile/1024)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, p, err
		}
		l, err := ParseProject(b)
		if err != nil {
			return nil, p, fmt.Errorf("%s: %w", p, err)
		}
		return &l, p, nil
	}
	return nil, "", nil
}
