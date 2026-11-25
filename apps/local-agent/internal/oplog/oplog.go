// Package oplog is the journal of what the server asked this computer to do: one JSON line per command (when, which operation, which repository and path,
// whether it was done or refused). It records requests, never contents: no file text, diff, prompt or answer is written.
//
// It is optional and off by default. The setting is the person's, made on this computer (`aigentron log on|off|rotate`, a file next to the pairing); the
// server cannot switch it off or change it. The file rotates by size, so it cannot grow without bound.
package oplog

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
)

const (
	DefaultMaxMB = 5
	DefaultKeep  = 3
	MaxMaxMB     = 100
	MaxKeep      = 20
	maxErrLen    = 200
)

// Config is oplog.json next to the pairing. The zero value is "off".
type Config struct {
	Enabled bool `json:"enabled"`
	// MaxMB is the size at which the file is rotated; Keep is how many rotated files (ops.log.1 …) are kept besides the current one.
	MaxMB int `json:"maxMB"`
	Keep  int `json:"keep"`
}

// Defaults is the setting when nothing was saved: off, 5 MB, three old files.
func Defaults() Config { return Config{MaxMB: DefaultMaxMB, Keep: DefaultKeep} }

// Normalized clamps the numbers (a size below 1 MB falls back to the default; Keep 0 is allowed: the old file is just dropped).
func (c Config) Normalized() Config {
	if c.MaxMB < 1 {
		c.MaxMB = DefaultMaxMB
	}
	if c.MaxMB > MaxMaxMB {
		c.MaxMB = MaxMaxMB
	}
	if c.Keep < 0 {
		c.Keep = 0
	}
	if c.Keep > MaxKeep {
		c.Keep = MaxKeep
	}
	return c
}

// Entry is one line of the journal.
type Entry struct {
	Time   string `json:"time"`
	Op     string `json:"op"`
	Repo   string `json:"repo,omitempty"`
	Path   string `json:"path,omitempty"`
	Detail string `json:"detail,omitempty"` // e.g. the model of an llm.chat (never the prompt)
	Result string `json:"result"`           // "ok" or "error"
	Error  string `json:"error,omitempty"`
	Ms     int64  `json:"ms"`
}

func dir() (string, error) { return config.Dir() }

func configFile() (string, error) {
	d, err := dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "oplog.json"), nil
}

// FilePath is the current journal file.
func FilePath() (string, error) {
	d, err := dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "ops.log"), nil
}

// Load reads the setting (missing file = off, defaults).
func Load() (Config, error) {
	p, err := configFile()
	if err != nil {
		return Config{}, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return Defaults(), nil
	}
	if err != nil {
		return Config{}, err
	}
	c := Defaults() // fields missing from a hand-edited file keep their defaults
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, fmt.Errorf("%s is not valid: %w", p, err)
	}
	return c.Normalized(), nil
}

// Save writes the setting.
func Save(c Config) error {
	p, err := configFile()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c.Normalized(), "", "  ")
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

var mu sync.Mutex

// Record appends an entry when the journal is on. It never fails the command: a journal problem is returned for the caller to print once, not to act on.
func Record(e Entry) error {
	c, err := Load()
	if err != nil || !c.Enabled {
		return err
	}
	if e.Time == "" {
		e.Time = time.Now().UTC().Format(time.RFC3339)
	}
	if len(e.Error) > maxErrLen {
		e.Error = e.Error[:maxErrLen]
	}
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	p, err := FilePath()
	if err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	if st, err := os.Stat(p); err == nil && st.Size()+int64(len(line)) > int64(c.MaxMB)<<20 {
		if err := rotate(p, c.Keep); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(line)
	return err
}

// rotate shifts ops.log → ops.log.1 → ops.log.2 … and drops what is beyond keep (keep 0: the old file is simply removed).
func rotate(p string, keep int) error {
	if keep < 1 {
		return os.Remove(p)
	}
	_ = os.Remove(p + "." + strconv.Itoa(keep))
	for i := keep - 1; i >= 1; i-- {
		if err := os.Rename(p+"."+strconv.Itoa(i), p+"."+strconv.Itoa(i+1)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return os.Rename(p, p+".1")
}

// Tail returns the last n entries, newest last, reading the rotated files too when the current one is short.
func Tail(n int) ([]Entry, error) {
	p, err := FilePath()
	if err != nil {
		return nil, err
	}
	c, _ := Load()
	var all []Entry
	for i := c.Keep; i >= 0; i-- {
		name := p
		if i > 0 {
			name = p + "." + strconv.Itoa(i)
		}
		b, err := os.ReadFile(name)
		if err != nil {
			continue
		}
		start := 0
		for j := 0; j <= len(b); j++ {
			if j == len(b) || b[j] == '\n' {
				if j > start {
					var e Entry
					if json.Unmarshal(b[start:j], &e) == nil {
						all = append(all, e)
					}
				}
				start = j + 1
			}
		}
	}
	if n > 0 && len(all) > n {
		all = all[len(all)-n:]
	}
	return all, nil
}

// Clear removes the journal (the current file and every rotated one).
func Clear() error {
	p, err := FilePath()
	if err != nil {
		return err
	}
	for i := 0; i <= MaxKeep; i++ {
		name := p
		if i > 0 {
			name = p + "." + strconv.Itoa(i)
		}
		if err := os.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
