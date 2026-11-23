// Package rules is the local agent's policy for a repository: what it may do on its own (snapshots, fetch, fast-forward …).
//
// Two layers, both YAML/JSON documents of the same shape:
//
//	global  — one per server, edited on the dashboard (Add-ons → Local agent) and synced to the machine (rules.global.yaml, overwritten on every sync)
//	project — .aigentron/local.yaml in the repository, committed with the code
//
// The project file comes from a repository — anyone who can push to it can write it — so it is NOT trusted to grant power: it may switch a rule off and
// tune it, but a rule is switched on only where the global config allows it (`projectCanEnable`). The hard limits (roots, never-paths, which actions need a
// card) are not in these files at all.
package rules

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const Version = 1

// Names of the rules (the keys of the document, and the values of projectCanEnable).
var RuleNames = []string{"snapshot", "fetch", "fastForward", "notify", "proposeCommit"}

type Snapshot struct {
	Enabled     *bool `yaml:"enabled,omitempty" json:"enabled,omitempty"`
	IdleMinutes *int  `yaml:"idleMinutes,omitempty" json:"idleMinutes,omitempty"`
	Keep        *int  `yaml:"keep,omitempty" json:"keep,omitempty"`
}
type Fetch struct {
	Enabled      *bool `yaml:"enabled,omitempty" json:"enabled,omitempty"`
	EveryMinutes *int  `yaml:"everyMinutes,omitempty" json:"everyMinutes,omitempty"`
}
type FastForward struct {
	Enabled *bool `yaml:"enabled,omitempty" json:"enabled,omitempty"`
}
type Notify struct {
	Enabled            *bool `yaml:"enabled,omitempty" json:"enabled,omitempty"`
	DirtyAfterMinutes  *int  `yaml:"dirtyAfterMinutes,omitempty" json:"dirtyAfterMinutes,omitempty"`
	BehindAfterMinutes *int  `yaml:"behindAfterMinutes,omitempty" json:"behindAfterMinutes,omitempty"`
}
type ProposeCommit struct {
	Enabled     *bool `yaml:"enabled,omitempty" json:"enabled,omitempty"`
	IdleMinutes *int  `yaml:"idleMinutes,omitempty" json:"idleMinutes,omitempty"`
}
type Quiet struct {
	TypingSeconds *int `yaml:"typingSeconds,omitempty" json:"typingSeconds,omitempty"`
}

// Layer is one document as written (every field optional: unset = "not said here").
type Layer struct {
	Version          int            `yaml:"version,omitempty" json:"version,omitempty"`
	Snapshot         *Snapshot      `yaml:"snapshot,omitempty" json:"snapshot,omitempty"`
	Fetch            *Fetch         `yaml:"fetch,omitempty" json:"fetch,omitempty"`
	FastForward      *FastForward   `yaml:"fastForward,omitempty" json:"fastForward,omitempty"`
	Notify           *Notify        `yaml:"notify,omitempty" json:"notify,omitempty"`
	ProposeCommit    *ProposeCommit `yaml:"proposeCommit,omitempty" json:"proposeCommit,omitempty"`
	Quiet            *Quiet         `yaml:"quiet,omitempty" json:"quiet,omitempty"`
	Ignore           []string       `yaml:"ignore,omitempty" json:"ignore,omitempty"`
	ProjectCanEnable []string       `yaml:"projectCanEnable,omitempty" json:"projectCanEnable,omitempty"`
}

// Effective is the result: every value is set.
type Effective struct {
	Snapshot struct {
		Enabled     bool `json:"enabled"`
		IdleMinutes int  `json:"idleMinutes"`
		Keep        int  `json:"keep"`
	} `json:"snapshot"`
	Fetch struct {
		Enabled      bool `json:"enabled"`
		EveryMinutes int  `json:"everyMinutes"`
	} `json:"fetch"`
	FastForward struct {
		Enabled bool `json:"enabled"`
	} `json:"fastForward"`
	Notify struct {
		Enabled            bool `json:"enabled"`
		DirtyAfterMinutes  int  `json:"dirtyAfterMinutes"`
		BehindAfterMinutes int  `json:"behindAfterMinutes"`
	} `json:"notify"`
	ProposeCommit struct {
		Enabled     bool `json:"enabled"`
		IdleMinutes int  `json:"idleMinutes"`
	} `json:"proposeCommit"`
	Quiet struct {
		TypingSeconds int `json:"typingSeconds"`
	} `json:"quiet"`
	Ignore           []string `json:"ignore"`
	ProjectCanEnable []string `json:"projectCanEnable"`
}

// Defaults are what applies when nothing is configured.
func Defaults() Effective {
	var e Effective
	e.Snapshot.Enabled, e.Snapshot.IdleMinutes, e.Snapshot.Keep = true, 2, 20
	e.Fetch.Enabled, e.Fetch.EveryMinutes = true, 5
	e.FastForward.Enabled = false
	e.Notify.Enabled, e.Notify.DirtyAfterMinutes, e.Notify.BehindAfterMinutes = true, 60, 30
	e.ProposeCommit.Enabled, e.ProposeCommit.IdleMinutes = false, 30
	e.Quiet.TypingSeconds = 20
	e.Ignore, e.ProjectCanEnable = []string{}, []string{}
	return e
}

type bound struct{ min, max int }

var bounds = map[string]bound{
	"snapshot.idleMinutes":      {1, 120},
	"snapshot.keep":             {1, 200},
	"fetch.everyMinutes":        {1, 1440},
	"notify.dirtyAfterMinutes":  {1, 10080},
	"notify.behindAfterMinutes": {1, 10080},
	"proposeCommit.idleMinutes": {5, 1440},
	"quiet.typingSeconds":       {5, 600},
}

func checkInt(key string, v *int) error {
	if v == nil {
		return nil
	}
	b := bounds[key]
	if *v < b.min || *v > b.max {
		return fmt.Errorf("%s must be between %d and %d (got %d)", key, b.min, b.max, *v)
	}
	return nil
}

func checkIgnore(patterns []string) error {
	if len(patterns) > 50 {
		return errors.New("ignore: at most 50 patterns")
	}
	for _, p := range patterns {
		if p == "" || len(p) > 200 {
			return errors.New("ignore: a pattern must be 1–200 characters")
		}
		if strings.HasPrefix(p, "/") || strings.Contains(p, "..") {
			return fmt.Errorf("ignore: %q must be a relative pattern without ..", p)
		}
		for _, r := range p {
			if r < 32 {
				return fmt.Errorf("ignore: %q has a control character", p)
			}
		}
	}
	return nil
}

// Validate checks one layer on its own (ranges, names). Strictness about unknown keys is in Parse.
func (l Layer) Validate() error {
	if l.Version != 0 && l.Version != Version {
		return fmt.Errorf("version %d is not understood (this agent reads version %d)", l.Version, Version)
	}
	var errs []error
	add := func(err error) {
		if err != nil {
			errs = append(errs, err)
		}
	}
	if l.Snapshot != nil {
		add(checkInt("snapshot.idleMinutes", l.Snapshot.IdleMinutes))
		add(checkInt("snapshot.keep", l.Snapshot.Keep))
	}
	if l.Fetch != nil {
		add(checkInt("fetch.everyMinutes", l.Fetch.EveryMinutes))
	}
	if l.Notify != nil {
		add(checkInt("notify.dirtyAfterMinutes", l.Notify.DirtyAfterMinutes))
		add(checkInt("notify.behindAfterMinutes", l.Notify.BehindAfterMinutes))
	}
	if l.ProposeCommit != nil {
		add(checkInt("proposeCommit.idleMinutes", l.ProposeCommit.IdleMinutes))
	}
	if l.Quiet != nil {
		add(checkInt("quiet.typingSeconds", l.Quiet.TypingSeconds))
	}
	add(checkIgnore(l.Ignore))
	for _, n := range l.ProjectCanEnable {
		if !contains(RuleNames, n) {
			add(fmt.Errorf("projectCanEnable: unknown rule %q (known: %s)", n, strings.Join(RuleNames, ", ")))
		}
	}
	return errors.Join(errs...)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Parse reads a YAML (or JSON — it is a subset) document; unknown keys are an error, so a typo is not silently ignored.
func Parse(data []byte) (Layer, error) {
	var l Layer
	if len(bytes.TrimSpace(data)) == 0 {
		return l, nil
	}
	if t := bytes.TrimSpace(data); t[0] == '{' || t[0] == '[' {
		// JSON (what the server pushes): strict about types — YAML would read "yes" as true
		dec := json.NewDecoder(bytes.NewReader(t))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&l); err != nil {
			return Layer{}, fmt.Errorf("cannot read the rules: %w", err)
		}
	} else {
		dec := yaml.NewDecoder(bytes.NewReader(data))
		dec.KnownFields(true)
		if err := dec.Decode(&l); err != nil && !errors.Is(err, io.EOF) {
			return Layer{}, fmt.Errorf("cannot read the rules: %w", err)
		}
	}
	if err := l.Validate(); err != nil {
		return Layer{}, err
	}
	return l, nil
}

// ParseProject reads the repository's file: it may not carry `projectCanEnable` (that is the global config's to say).
func ParseProject(data []byte) (Layer, error) {
	l, err := Parse(data)
	if err != nil {
		return Layer{}, err
	}
	if len(l.ProjectCanEnable) > 0 {
		return Layer{}, errors.New("projectCanEnable belongs in the global config (the dashboard), not in a project file")
	}
	return l, nil
}

func setBool(dst *bool, src *bool) {
	if src != nil {
		*dst = *src
	}
}
func setInt(dst *int, src *int) {
	if src != nil {
		*dst = *src
	}
}

// apply writes what a layer says over e. `canEnable` is nil for the trusted (global) layer; for the project layer it is the list of rules it may switch on.
// Returns what was refused.
func apply(e *Effective, l Layer, project bool) []string {
	var warn []string
	allowed := append([]string(nil), e.ProjectCanEnable...)
	on := func(name string, dst *bool, src *bool) {
		if src == nil {
			return
		}
		if project && *src && !*dst && !contains(allowed, name) {
			warn = append(warn, fmt.Sprintf("the project file switches %s on, but the global config does not allow that (projectCanEnable) — ignored", name))
			return
		}
		*dst = *src
	}
	if s := l.Snapshot; s != nil {
		on("snapshot", &e.Snapshot.Enabled, s.Enabled)
		setInt(&e.Snapshot.IdleMinutes, s.IdleMinutes)
		setInt(&e.Snapshot.Keep, s.Keep)
	}
	if f := l.Fetch; f != nil {
		on("fetch", &e.Fetch.Enabled, f.Enabled)
		setInt(&e.Fetch.EveryMinutes, f.EveryMinutes)
	}
	if f := l.FastForward; f != nil {
		on("fastForward", &e.FastForward.Enabled, f.Enabled)
	}
	if n := l.Notify; n != nil {
		on("notify", &e.Notify.Enabled, n.Enabled)
		setInt(&e.Notify.DirtyAfterMinutes, n.DirtyAfterMinutes)
		setInt(&e.Notify.BehindAfterMinutes, n.BehindAfterMinutes)
	}
	if p := l.ProposeCommit; p != nil {
		on("proposeCommit", &e.ProposeCommit.Enabled, p.Enabled)
		setInt(&e.ProposeCommit.IdleMinutes, p.IdleMinutes)
	}
	if q := l.Quiet; q != nil && q.TypingSeconds != nil {
		// waiting longer after the person types is always safe; acting sooner is not for a project to decide
		if project && *q.TypingSeconds < e.Quiet.TypingSeconds {
			warn = append(warn, fmt.Sprintf("the project file shortens quiet.typingSeconds below the global %d — ignored", e.Quiet.TypingSeconds))
		} else {
			e.Quiet.TypingSeconds = *q.TypingSeconds
		}
	}
	// ignore patterns only add (union), in both layers
	for _, p := range l.Ignore {
		if !contains(e.Ignore, p) {
			e.Ignore = append(e.Ignore, p)
		}
	}
	if !project {
		e.ProjectCanEnable = append([]string{}, l.ProjectCanEnable...)
		sort.Strings(e.ProjectCanEnable)
	}
	return warn
}

// Merge computes the rules for one repository: defaults < global < project (see the package comment for what the project may do). A nil layer is skipped.
func Merge(global, project *Layer) (Effective, []string) {
	e := Defaults()
	var warn []string
	if global != nil {
		warn = append(warn, apply(&e, *global, false)...)
	}
	if project != nil {
		warn = append(warn, apply(&e, *project, true)...)
	}
	return e, warn
}

// Normalize turns a (global) layer into the full document the server stores and shows: defaults filled, then the layer on top.
func Normalize(global Layer) Effective {
	e, _ := Merge(&global, nil)
	return e
}
