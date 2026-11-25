package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Arttron/aigentron/apps/local-agent/internal/oplog"
	"github.com/Arttron/aigentron/apps/local-agent/internal/proto"
)

const protocolDir = "../../../../packages/shared/protocol/local-agent"

// Every command in the shared fixtures must be an op this daemon knows (so the contract and the handler cannot drift apart),
// and an unknown op must be refused.
func TestHandlerKnowsEveryFixtureCommand(t *testing.T) {
	t.Setenv("AIGENTRON_LOCAL_HOME", t.TempDir())
	files, _ := filepath.Glob(filepath.Join(protocolDir, "command*.json"))
	if len(files) < 8 {
		t.Fatalf("expected the command fixtures, found %d", len(files))
	}
	var rev atomic.Int64
	h := newHandler(&rev)
	for _, file := range files {
		raw, _ := os.ReadFile(file)
		f, err := proto.Decode(raw)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if f.Op == "llm.chat" {
			continue // would need a live backend; its arguments are checked by the llm tests
		}
		_, err = h(context.Background(), f.Op, f.Args)
		if err != nil && strings.Contains(err.Error(), "unknown op") {
			t.Errorf("%s: the daemon does not know op %q", filepath.Base(file), f.Op)
		}
	}
	if _, err := h(context.Background(), "no.such.op", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "unknown op") {
		t.Fatalf("an unknown op must be refused, got %v", err)
	}
}

// A repository the person never added is refused with a message that says how to add it.
func TestRepoOpRefusesUnknownRepo(t *testing.T) {
	t.Setenv("AIGENTRON_LOCAL_HOME", t.TempDir())
	var rev atomic.Int64
	_, err := newHandler(&rev)(context.Background(), "repo.read", json.RawMessage(`{"repo":"zzzz","path":"a.go"}`))
	if err == nil || !strings.Contains(err.Error(), "no allowed repository") {
		t.Fatalf("got %v", err)
	}
}

// The data of the result fixtures has the fields the server reads.
func TestResultFixtureShapes(t *testing.T) {
	want := map[string][]string{
		"result-repo-log.json":   {"commits"},
		"result-repo-read.json":  {"path", "text", "offset", "size", "more"},
		"result-llm-models.json": {"models", "problems", "shared"},
	}
	for file, keys := range want {
		raw, err := os.ReadFile(filepath.Join(protocolDir, file))
		if err != nil {
			t.Fatal(err)
		}
		f, _ := proto.Decode(raw)
		var data map[string]json.RawMessage
		if err := json.Unmarshal(f.Data, &data); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		for _, k := range keys {
			if _, ok := data[k]; !ok {
				t.Errorf("%s: data has no %q", file, k)
			}
		}
	}
}

// The journal records what the server asked and how it ended — and never the contents of a prompt or a file.
func TestJournalRecordsRequestsNotContents(t *testing.T) {
	t.Setenv("AIGENTRON_LOCAL_HOME", t.TempDir())
	var rev atomic.Int64
	h := newHandler(&rev)
	_, _ = h(context.Background(), "repo.read", json.RawMessage(`{"repo":"zzzz","path":".env"}`)) // before it is on: nothing is written
	if got, _ := oplog.Tail(0); len(got) != 0 {
		t.Fatalf("the journal is off by default, got %+v", got)
	}
	if err := oplog.Save(oplog.Config{Enabled: true, MaxMB: 1, Keep: 1}); err != nil {
		t.Fatal(err)
	}
	_, _ = h(context.Background(), "repo.read", json.RawMessage(`{"repo":"zzzz","path":".env"}`))
	_, _ = h(context.Background(), "llm.chat", json.RawMessage(`{"id":"j","backend":"ollama","request":{"model":"qwen3","messages":[{"role":"user","content":"TOPSECRETPROMPT"}]}}`))
	_, _ = h(context.Background(), "status", json.RawMessage(`{}`))
	got, _ := oplog.Tail(0)
	if len(got) != 3 {
		t.Fatalf("want 3 entries, got %+v", got)
	}
	if got[0].Op != "repo.read" || got[0].Repo != "zzzz" || got[0].Path != ".env" || got[0].Result != "error" {
		t.Errorf("a refused read: %+v", got[0])
	}
	if got[1].Op != "llm.chat" || got[1].Detail != "ollama/qwen3" {
		t.Errorf("a model request: %+v", got[1])
	}
	if got[2].Op != "status" || got[2].Result != "ok" {
		t.Errorf("status: %+v", got[2])
	}
	p, _ := oplog.FilePath()
	raw, _ := os.ReadFile(p)
	if strings.Contains(string(raw), "TOPSECRETPROMPT") {
		t.Fatal("a prompt reached the journal")
	}
}
