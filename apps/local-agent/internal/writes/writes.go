// Package writes holds the machine owner's two controls over what the server may DO on THIS computer: the switch that lets it change anything at all
// (`aigentron writes on|off`; off by default; the server cannot turn it on) and Stop (`aigentron stop`: for a while nothing is changed or run, whatever the
// server asks). Both are files next to the pairing, set only here. Even with the switch on, the person still approves in the dashboard — the switch is the
// second lock, so that a compromised or mistaken server cannot write.
package writes

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
)

// Config is writes.json. The zero value is "no writes".
type Config struct {
	// Write lets the server edit files, create files, commit and run commands inside the allowed folders.
	Write bool `json:"write"`
}

func file() (string, error) {
	d, err := config.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "writes.json"), nil
}

// Load reads the switch (a missing file = everything off).
func Load() (Config, error) {
	p, err := file()
	if err != nil {
		return Config{}, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, err // a broken file must not mean "allowed"
	}
	return c, nil
}

// Save writes the switch.
func Save(c Config) error {
	p, err := file()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Allowed says whether the server may change things here (false on any error).
func Allowed() bool {
	c, err := Load()
	return err == nil && c.Write
}

type stopFile struct {
	Until int64 `json:"until"` // unix seconds
}

func stopPath() (string, error) {
	d, err := config.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "stop.json"), nil
}

// Stop forbids every change and every command for the given time (the person pressed Stop on this computer).
func Stop(d time.Duration) error {
	p, err := stopPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(stopFile{Until: time.Now().Add(d).Unix()})
	return os.WriteFile(p, b, 0o600)
}

// Resume lifts a Stop.
func Resume() error {
	p, err := stopPath()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// StoppedUntil returns when a Stop ends (zero when there is none). A file that cannot be read counts as a Stop: the safe side.
func StoppedUntil() time.Time {
	p, err := stopPath()
	if err != nil {
		return time.Now().Add(time.Hour)
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return time.Time{}
	}
	var f stopFile
	if err != nil || json.Unmarshal(b, &f) != nil {
		return time.Now().Add(time.Hour)
	}
	if t := time.Unix(f.Until, 0); t.After(time.Now()) {
		return t
	}
	return time.Time{}
}

// Stopped says whether a Stop is in force.
func Stopped() bool { return !StoppedUntil().IsZero() }
