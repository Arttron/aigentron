package rules

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const fixtures = "../../../../packages/shared/protocol/local-agent/rules"

func readJSON(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtures, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func asJSON(t *testing.T, v any) any {
	t.Helper()
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

// The contract shared with the orchestrator (apps/orchestrator/src/local-agent/local-rules.test.ts): the same documents, the same answers.
func TestContractDefaults(t *testing.T) {
	var want any
	readJSON(t, "defaults.json", &want)
	if got := asJSON(t, Defaults()); !reflect.DeepEqual(got, want) {
		t.Fatalf("defaults differ from the fixture\n got: %v\nwant: %v", got, want)
	}
}

func TestContractValid(t *testing.T) {
	var cases []struct {
		Name       string          `json:"name"`
		Rules      json.RawMessage `json:"rules"`
		Normalized any             `json:"normalized"`
	}
	readJSON(t, "valid.json", &cases)
	if len(cases) < 4 {
		t.Fatal("fixture too small")
	}
	for _, c := range cases {
		l, err := Parse(c.Rules)
		if err != nil {
			t.Errorf("%s: rejected: %v", c.Name, err)
			continue
		}
		if got := asJSON(t, Normalize(l)); !reflect.DeepEqual(got, c.Normalized) {
			t.Errorf("%s: normalized differs\n got: %v\nwant: %v", c.Name, got, c.Normalized)
		}
	}
}

func TestContractInvalid(t *testing.T) {
	var cases []struct {
		Name  string          `json:"name"`
		Rules json.RawMessage `json:"rules"`
	}
	readJSON(t, "invalid.json", &cases)
	if len(cases) < 10 {
		t.Fatal("fixture too small")
	}
	for _, c := range cases {
		if _, err := Parse(c.Rules); err == nil {
			t.Errorf("%s: accepted, must be rejected: %s", c.Name, c.Rules)
		}
	}
}

func TestParseYAMLWithComments(t *testing.T) {
	l, err := Parse([]byte("# my rules\nversion: 1\nsnapshot:\n  idleMinutes: 10   # lazy\nignore: [\"build/**\"]\n"))
	if err != nil {
		t.Fatal(err)
	}
	e := Normalize(l)
	if e.Snapshot.IdleMinutes != 10 || !e.Snapshot.Enabled || e.Ignore[0] != "build/**" {
		t.Fatalf("%+v", e)
	}
	if _, err := Parse([]byte("snapshot: [unclosed")); err == nil {
		t.Fatal("broken YAML accepted")
	}
	if l, err := Parse(nil); err != nil || l.Snapshot != nil {
		t.Fatalf("empty file: %v", err)
	}
}

func parse(t *testing.T, s string, project bool) *Layer {
	t.Helper()
	var l Layer
	var err error
	if project {
		l, err = ParseProject([]byte(s))
	} else {
		l, err = Parse([]byte(s))
	}
	if err != nil {
		t.Fatal(err)
	}
	return &l
}

func TestProjectMayTuneAndSwitchOffButNotOn(t *testing.T) {
	g := parse(t, "snapshot: {idleMinutes: 3}\nfetch: {enabled: true}", false)
	p := parse(t, "snapshot: {enabled: false, idleMinutes: 9}\nfetch: {everyMinutes: 15}\nfastForward: {enabled: true}\nproposeCommit: {enabled: true}", true)
	e, warn := Merge(g, p)
	if e.Snapshot.Enabled || e.Snapshot.IdleMinutes != 9 {
		t.Errorf("a project may switch off and tune: %+v", e.Snapshot)
	}
	if e.Fetch.EveryMinutes != 15 || !e.Fetch.Enabled {
		t.Errorf("tuning kept the rule on: %+v", e.Fetch)
	}
	if e.FastForward.Enabled || e.ProposeCommit.Enabled {
		t.Errorf("a project file switched on what the global config did not allow: ff=%v propose=%v", e.FastForward.Enabled, e.ProposeCommit.Enabled)
	}
	if len(warn) != 2 {
		t.Errorf("want 2 warnings, got %v", warn)
	}
}

func TestGlobalCanLetAProjectEnable(t *testing.T) {
	g := parse(t, "projectCanEnable: [fastForward]", false)
	p := parse(t, "fastForward: {enabled: true}\nproposeCommit: {enabled: true}", true)
	e, warn := Merge(g, p)
	if !e.FastForward.Enabled {
		t.Error("allowed by the global config but not enabled")
	}
	if e.ProposeCommit.Enabled || len(warn) != 1 || !strings.Contains(warn[0], "proposeCommit") {
		t.Errorf("proposeCommit must stay off: %v %v", e.ProposeCommit.Enabled, warn)
	}
}

func TestProjectCannotShortenQuietAndCannotCarryProjectCanEnable(t *testing.T) {
	g := parse(t, "quiet: {typingSeconds: 60}", false)
	p := parse(t, "quiet: {typingSeconds: 10}", true)
	if e, warn := Merge(g, p); e.Quiet.TypingSeconds != 60 || len(warn) != 1 {
		t.Errorf("quiet shortened by a project: %d %v", e.Quiet.TypingSeconds, warn)
	}
	if e, _ := Merge(g, parse(t, "quiet: {typingSeconds: 120}", true)); e.Quiet.TypingSeconds != 120 {
		t.Error("a project may wait longer")
	}
	if _, err := ParseProject([]byte("projectCanEnable: [fastForward]")); err == nil {
		t.Error("a project file granted itself permission")
	}
}

func TestIgnoreIsAUnionAndNilLayersAreFine(t *testing.T) {
	e, _ := Merge(parse(t, "ignore: [a, b]", false), parse(t, "ignore: [b, c]", true))
	if !reflect.DeepEqual(e.Ignore, []string{"a", "b", "c"}) {
		t.Errorf("%v", e.Ignore)
	}
	if e, w := Merge(nil, nil); !reflect.DeepEqual(e, Defaults()) || len(w) != 0 {
		t.Error("no layers must give the defaults")
	}
}
