// Package config keeps the daemon's own settings: which server it is paired with and its device token.
package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Config is stored as JSON in the user's config dir, mode 0600 (the token is a credential).
type Config struct {
	Server string `json:"server"` // origin, e.g. https://dev.example.com
	Token  string `json:"token"`  // lag_<id>_<secret>
	Device string `json:"device"` // the name shown in the dashboard
}

// ErrNotPaired is returned when there is no saved pairing.
var ErrNotPaired = errors.New("not paired: run `aigentron-local pair --server <url> --code <code>`")

// Dir is the folder of the daemon's files; AIGENTRON_LOCAL_HOME overrides it (tests, several profiles).
func Dir() (string, error) {
	if d := os.Getenv("AIGENTRON_LOCAL_HOME"); d != "" {
		return d, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "aigentron-local"), nil
}

func path() (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.json"), nil
}

// Load reads the saved pairing.
func Load() (Config, error) {
	var c Config
	p, err := path()
	if err != nil {
		return c, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return c, ErrNotPaired
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if c.Server == "" || c.Token == "" {
		return c, ErrNotPaired
	}
	return c, nil
}

// Save writes the pairing (atomically, 0600).
func Save(c Config) error {
	p, err := path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Clear forgets the pairing.
func Clear() error {
	p, err := path()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
