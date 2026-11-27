package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
	"github.com/Arttron/aigentron/apps/local-agent/internal/writes"
)

func workRepo(t *testing.T) (policy.Root, func(op, args string) (any, error)) {
	t.Helper()
	t.Setenv("AIGENTRON_LOCAL_HOME", t.TempDir())
	for k, v := range map[string]string{"GIT_CONFIG_GLOBAL": os.DevNull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"} {
		t.Setenv(k, v)
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	for _, a := range [][]string{{"init", "-q", "-b", "main"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, a...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", a, err, out)
		}
	}
	_ = os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "src", "a.go"), []byte("return a - b\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("TOKEN=TOPSECRET\n"), 0o644)
	root, err := policy.AddRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	var rev atomic.Int64
	h := newHandler(&rev)
	return root, func(op, args string) (any, error) {
		return h(context.Background(), op, json.RawMessage(strings.ReplaceAll(args, "@", root.ID)))
	}
}

func text(t *testing.T, v any) string {
	t.Helper()
	b, _ := json.Marshal(v)
	var m struct{ Text string }
	_ = json.Unmarshal(b, &m)
	return m.Text
}

// Looking around needs no switch; the secret file is invisible.
func TestFsListAndSearchNeedNoSwitch(t *testing.T) {
	_, run := workRepo(t)
	v, err := run("fs.list", `{"repo":"@"}`)
	if err != nil || !strings.Contains(text(t, v), "src/a.go") || strings.Contains(text(t, v), "\n.env") {
		t.Fatalf("%v %v", v, err)
	}
	v, err = run("fs.search", `{"repo":"@","query":"a - b"}`)
	if err != nil || !strings.Contains(text(t, v), "src/a.go:1") {
		t.Fatalf("%v %v", v, err)
	}
	if v, err = run("fs.search", `{"repo":"@","query":"TOPSECRET"}`); err != nil || strings.Contains(text(t, v), "TOPSECRET") {
		t.Fatalf("a secret leaked through a search: %v %v", v, err)
	}
}

// Changes need the owner's switch, and a Stop beats it.
func TestChangesNeedTheSwitchAndStopBeatsIt(t *testing.T) {
	root, run := workRepo(t)
	edit := `{"repo":"@","path":"src/a.go","old":"a - b","new":"a + b"}`
	for _, op := range []string{"fs.edit", "fs.write", "exec.run"} {
		if _, err := run(op, `{"repo":"@","path":"x.md","content":"x","command":"true"}`); err == nil || !strings.Contains(err.Error(), "writes are off") {
			t.Fatalf("%s must be refused by default: %v", op, err)
		}
	}
	_ = writes.Save(writes.Config{Write: true})
	if _, err := run("fs.edit", edit); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root.Path, "src", "a.go")); string(b) != "return a + b\n" {
		t.Fatalf("not edited: %q", b)
	}
	if _, err := run("fs.write", `{"repo":"@","path":"src/new.go","content":"package src\n"}`); err != nil {
		t.Fatal(err)
	}
	// the secret file and the git folder can be neither written nor edited
	for _, bad := range []string{`{"repo":"@","path":".env","content":"x"}`, `{"repo":"@","path":".git/config","content":"x"}`, `{"repo":"@","path":"../x.txt","content":"x"}`, `{"repo":"@","path":"src/new.go","content":"over"}`} {
		if _, err := run("fs.write", bad); err == nil {
			t.Errorf("written: %s", bad)
		}
	}
	if _, err := run("fs.edit", `{"repo":"@","path":".env","old":"TOPSECRET","new":"x"}`); err == nil {
		t.Error("the secret file was edited")
	}
	_ = writes.Stop(time.Hour)
	for _, op := range []string{"fs.edit", "fs.write", "exec.run"} {
		if _, err := run(op, `{"repo":"@","path":"x.md","content":"x","command":"true"}`); err == nil || !strings.Contains(err.Error(), "Stop") {
			t.Fatalf("%s must be refused during a Stop: %v", op, err)
		}
	}
	if _, err := run("fs.list", `{"repo":"@"}`); err != nil {
		t.Fatalf("looking is allowed during a Stop: %v", err)
	}
	_ = writes.Resume()
	if _, err := run("fs.edit", `{"repo":"@","path":"src/a.go","old":"a + b","new":"a * b"}`); err != nil {
		t.Fatalf("after Resume: %v", err)
	}
}

func TestExecRunsInTheRepositoryAndStopCutsItOff(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip()
	}
	root, run := workRepo(t)
	_ = writes.Save(writes.Config{Write: true})
	v, err := run("exec.run", `{"repo":"@","command":"cat src/a.go; echo done"}`)
	b, _ := json.Marshal(v)
	if err != nil || !strings.Contains(string(b), "return a - b") || !strings.Contains(string(b), `"exit":0`) {
		t.Fatalf("%s %v", b, err)
	}
	if _, err := run("exec.run", `{"repo":"nope","command":"true"}`); err == nil || !strings.Contains(err.Error(), "no allowed repository") {
		t.Fatalf("%v", err)
	}
	// cut off by name (the server's Stop), and by the person's Stop on this computer
	done := make(chan string, 1)
	go func() {
		v, _ := run("exec.run", `{"repo":"@","command":"sleep 30","task":"T"}`)
		b, _ := json.Marshal(v)
		done <- string(b)
	}()
	time.Sleep(300 * time.Millisecond)
	if _, err := run("exec.cancel", `{"task":"T"}`); err != nil {
		t.Fatal(err)
	}
	select {
	case out := <-done:
		if !strings.Contains(out, `"cancelled":true`) {
			t.Fatalf("%s", out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("exec.cancel did not cut it off")
	}
	go func() {
		v, _ := run("exec.run", `{"repo":"@","command":"sleep 30"}`)
		b, _ := json.Marshal(v)
		done <- string(b)
	}()
	time.Sleep(300 * time.Millisecond)
	_ = writes.Stop(time.Hour)
	select {
	case out := <-done:
		if !strings.Contains(out, `"cancelled":true`) {
			t.Fatalf("%s", out)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("the person's Stop did not cut it off")
	}
	_ = root
}
