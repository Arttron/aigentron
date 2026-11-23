package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Arttron/aigentron/apps/local-agent/internal/llm"
	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
)

func gitIn(t *testing.T, dir string, a ...string) string {
	t.Helper()
	c := exec.Command("git", append([]string{"-C", dir}, a...)...)
	c.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", a, err, out)
	}
	return string(out)
}

func newRepo(t *testing.T) policy.Root {
	t.Helper()
	// the agent's own git calls (its commit tool) read the environment: a CI machine has no git identity
	for k, v := range map[string]string{"GIT_CONFIG_GLOBAL": os.DevNull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"} {
		t.Setenv(k, v)
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	gitIn(t, dir, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc add(a, b int) int { return a - b }\n"), 0o644)
	os.WriteFile(filepath.Join(dir, ".env"), []byte("TOKEN=TOPSECRET\n"), 0o644)
	os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	os.WriteFile(filepath.Join(dir, "src", "util.go"), []byte("package src\n"), 0o644)
	gitIn(t, dir, "add", "-f", ".")
	gitIn(t, dir, "commit", "-qm", "init")
	return policy.Root{ID: "r", Path: dir}
}

// script plays the model: each entry answers one request; tool calls are given as name + JSON arguments.
type step struct {
	text string
	name string
	args string
}

func scripted(t *testing.T, steps []step, seen *[]string) func(context.Context, []byte) ([]byte, error) {
	i := 0
	return func(_ context.Context, body []byte) ([]byte, error) {
		var req struct {
			Messages []message `json:"messages"`
		}
		_ = json.Unmarshal(body, &req)
		if n := len(req.Messages); n > 0 && req.Messages[n-1].Role == "tool" && seen != nil {
			*seen = append(*seen, req.Messages[n-1].Content)
		}
		if i >= len(steps) {
			t.Fatalf("the model was asked %d times, the script has %d steps", i+1, len(steps))
		}
		s := steps[i]
		i++
		msg := map[string]any{"role": "assistant", "content": s.text}
		if s.name != "" {
			msg["tool_calls"] = []map[string]any{{"id": "c1", "type": "function", "function": map[string]any{"name": s.name, "arguments": s.args}}}
		}
		return json.Marshal(map[string]any{"choices": []any{map[string]any{"message": msg}}})
	}
}

func session(t *testing.T, root policy.Root, steps []step, approve func(string) bool, seen *[]string) *Session {
	s := New(root, llm.Backend{Name: "x", URL: "http://127.0.0.1:1"}, "m", &bytes.Buffer{}, approve)
	s.Complete = scripted(t, steps, seen)
	return s
}

func TestReadsAndAnswers(t *testing.T) {
	root := newRepo(t)
	var seen []string
	s := session(t, root, []step{
		{name: "list_files", args: `{}`},
		{name: "read_file", args: `{"path":"main.go"}`},
		{name: "search", args: `{"query":"add"}`},
		{text: "add subtracts: a bug."},
	}, nil, &seen)
	got, err := s.Turn(context.Background(), "what does add do?")
	if err != nil || got != "add subtracts: a bug." {
		t.Fatalf("got %q, %v", got, err)
	}
	if !strings.Contains(seen[0], "main.go") || strings.Contains(seen[0], ".env\n") && !strings.Contains(seen[0], ".env.") {
		t.Errorf("list_files: %q", seen[0])
	}
	if strings.Contains(seen[0], "\n.env") || seen[0] == ".env" {
		t.Errorf("list_files shows the secret file: %q", seen[0])
	}
	if !strings.Contains(seen[1], "a - b") || !strings.Contains(seen[2], "main.go:3:") {
		t.Errorf("read/search: %q %q", seen[1], seen[2])
	}
}

func TestSecretsAndEscapesRefused(t *testing.T) {
	root := newRepo(t)
	var seen []string
	s := session(t, root, []step{
		{name: "read_file", args: `{"path":".env"}`},
		{name: "read_file", args: `{"path":"../../etc/passwd"}`},
		{name: "search", args: `{"query":"TOPSECRET"}`},
		{name: "edit_file", args: `{"path":".env","old":"TOPSECRET","new":"x"}`},
		{name: "write_file", args: `{"path":".git/hooks/pre-commit","content":"x"}`},
		{name: "write_file", args: `{"path":"/etc/x","content":"x"}`},
		{name: "git_commit", args: `{"message":"m","paths":["src"]}`},
		{text: "done"},
	}, func(string) bool { t.Error("nothing here should reach an approval"); return true }, &seen)
	if _, err := s.Turn(context.Background(), "go"); err != nil {
		t.Fatal(err)
	}
	for i, o := range seen[:2] {
		if !strings.HasPrefix(o, "error:") || strings.Contains(o, "TOPSECRET") {
			t.Errorf("%d: %q", i, o)
		}
	}
	if !strings.Contains(seen[2], "no matches") {
		t.Errorf("search found the secret: %q", seen[2])
	}
	for i := 3; i < 7; i++ {
		if !strings.HasPrefix(seen[i], "error:") {
			t.Errorf("%d must be refused: %q", i, seen[i])
		}
	}
	if b, _ := os.ReadFile(filepath.Join(root.Path, ".env")); string(b) != "TOKEN=TOPSECRET\n" {
		t.Error(".env was changed")
	}
}

func TestEditNeedsApproval(t *testing.T) {
	root := newRepo(t)
	edit := `{"path":"main.go","old":"a - b","new":"a + b"}`
	var asked []string
	// declined: the file is untouched and the model is told
	var seen []string
	s := session(t, root, []step{{name: "edit_file", args: edit}, {text: "ok, I did not"}}, func(sum string) bool { asked = append(asked, sum); return false }, &seen)
	if _, err := s.Turn(context.Background(), "fix"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root.Path, "main.go")); !strings.Contains(string(b), "a - b") {
		t.Fatal("a declined edit was applied")
	}
	if len(asked) != 1 || !strings.Contains(asked[0], "a + b") || !strings.Contains(seen[0], "declined") {
		t.Fatalf("asked=%v seen=%v", asked, seen)
	}
	// no approver at all (a non-interactive run): also nothing changes
	s = session(t, root, []step{{name: "edit_file", args: edit}, {text: "x"}}, nil, nil)
	_, _ = s.Turn(context.Background(), "fix")
	if b, _ := os.ReadFile(filepath.Join(root.Path, "main.go")); !strings.Contains(string(b), "a - b") {
		t.Fatal("an edit was applied without anyone to approve it")
	}
	// approved: edited, then committed (also approved), hooks never run
	os.MkdirAll(filepath.Join(root.Path, ".git", "hooks"), 0o755)
	os.WriteFile(filepath.Join(root.Path, ".git", "hooks", "pre-commit"), []byte("#!/bin/sh\ntouch "+filepath.Join(root.Path, "HOOK_RAN")+"\n"), 0o755)
	s = session(t, root, []step{
		{name: "edit_file", args: edit},
		{name: "write_file", args: `{"path":"src/new.go","content":"package src\n"}`},
		{name: "git_commit", args: `{"message":"fix add","paths":["main.go","src/new.go"]}`},
		{text: "committed"},
	}, func(string) bool { return true }, nil)
	if _, err := s.Turn(context.Background(), "fix and commit"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root.Path, "main.go")); !strings.Contains(string(b), "a + b") {
		t.Fatal("the approved edit was not applied")
	}
	if log := gitIn(t, root.Path, "log", "--oneline"); !strings.Contains(log, "fix add") {
		t.Fatalf("log: %s", log)
	}
	if _, err := os.Stat(filepath.Join(root.Path, "HOOK_RAN")); err == nil {
		t.Fatal("a git hook ran")
	}
	if st := gitIn(t, root.Path, "status", "--porcelain"); strings.TrimSpace(st) != "" {
		t.Fatalf("not clean after the commit: %q", st)
	}
}

func TestEditErrors(t *testing.T) {
	root := newRepo(t)
	os.WriteFile(filepath.Join(root.Path, "dup.txt"), []byte("x\nx\n"), 0o644)
	var seen []string
	s := session(t, root, []step{
		{name: "edit_file", args: `{"path":"main.go","old":"nope","new":"y"}`},
		{name: "edit_file", args: `{"path":"dup.txt","old":"x","new":"y"}`},
		{name: "write_file", args: `{"path":"main.go","content":"overwrite"}`},
		{text: "x"},
	}, func(string) bool { t.Error("must fail before asking"); return true }, &seen)
	_, _ = s.Turn(context.Background(), "go")
	for i, want := range []string{"not found", "2 times", "already exists"} {
		if !strings.Contains(seen[i], want) {
			t.Errorf("%d: %q lacks %q", i, seen[i], want)
		}
	}
}

func TestStepLimitAndLongOutputs(t *testing.T) {
	root := newRepo(t)
	s := session(t, root, nil, nil, nil)
	n := 0
	s.Complete = func(context.Context, []byte) ([]byte, error) {
		n++
		return json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "", "tool_calls": []map[string]any{{"id": "c", "type": "function", "function": map[string]any{"name": "git_status", "arguments": "{}"}}}}}}})
	}
	if _, err := s.Turn(context.Background(), "loop"); err == nil || n != MaxSteps {
		t.Fatalf("err=%v calls=%d", err, n)
	}
	// old tool outputs are shortened when the conversation grows
	big := strings.Repeat("x", 30000)
	s.msgs = nil
	for i := 0; i < 8; i++ {
		s.msgs = append(s.msgs, message{Role: "tool", Content: big})
	}
	s.shorten()
	if len(s.msgs[0].Content) > keepOldOutputs+100 || len(s.msgs[7].Content) != 30000 {
		t.Errorf("shorten: first=%d last=%d", len(s.msgs[0].Content), len(s.msgs[7].Content))
	}
}

func TestToolCallsWrittenAsText(t *testing.T) {
	root := newRepo(t)
	var seen []string
	s := session(t, root, []step{
		{text: "I'll look.\n\n<function=read_file>\n<parameter=path>\nmain.go\n</parameter>\n</function>\n</tool_call>"},
		{text: "<function=git_log>\n<parameter=limit>\n3\n</parameter>\n</function>"},
		{text: "<function=made_up>\n</function>"},
		{text: "all done"},
	}, nil, &seen)
	got, err := s.Turn(context.Background(), "look")
	if err != nil {
		t.Fatal(err)
	}
	// the first two were run as calls (the text of the call is not shown), the unknown one is just text and ends the turn
	if len(seen) != 2 || !strings.Contains(seen[0], "a - b") || !strings.Contains(seen[1], "init") {
		t.Fatalf("seen=%q", seen)
	}
	if !strings.Contains(got, "made_up") {
		t.Fatalf("got %q", got)
	}
}

func TestCoerce(t *testing.T) {
	calls, rest := extractXMLCalls("x <function=git_diff>\n<parameter=staged>\ntrue\n</parameter>\n</function> y", tools(policy.Root{}))
	if len(calls) != 1 || calls[0].Function.Arguments != `{"staged":true}` || strings.TrimSpace(rest) != "x  y" && strings.TrimSpace(rest) != "x y" {
		t.Fatalf("%+v %q", calls, rest)
	}
}
