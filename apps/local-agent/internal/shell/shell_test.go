package shell

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

func skipWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no shell")
	}
}

func TestRunReportsOutputAndExitCode(t *testing.T) {
	skipWindows(t)
	dir := t.TempDir()
	r, err := Run(context.Background(), Opts{Dir: dir, Command: "echo hello; echo oops >&2; exit 3"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Exit != 3 || !strings.Contains(r.Output, "hello") || !strings.Contains(r.Output, "oops") {
		t.Fatalf("%+v", r)
	}
	r, _ = Run(context.Background(), Opts{Dir: dir, Command: "pwd"})
	if !strings.Contains(r.Output, strings.TrimPrefix(dir, "/private")) {
		t.Fatalf("pwd = %q, want a path under %q", r.Output, dir)
	}
}

// No token of the person's own shell reaches a command.
func TestRunDoesNotPassSecretsInTheEnvironment(t *testing.T) {
	skipWindows(t)
	t.Setenv("GITHUB_TOKEN", "ghp_SECRETVALUE")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "SECRETAWS")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
	r, err := Run(context.Background(), Opts{Dir: t.TempDir(), Command: "env"})
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"SECRETVALUE", "SECRETAWS", "SSH_AUTH_SOCK", "GITHUB_TOKEN"} {
		if strings.Contains(r.Output, bad) {
			t.Errorf("%s reached the command", bad)
		}
	}
	if !strings.Contains(r.Output, "PATH=") {
		t.Error("PATH must be kept")
	}
}

func TestRunTimesOutAndKillsChildren(t *testing.T) {
	skipWindows(t)
	start := time.Now()
	r, err := Run(context.Background(), Opts{Dir: t.TempDir(), Command: "sleep 30 & sleep 30", Timeout: 300 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if !r.TimedOut || r.Cancelled {
		t.Fatalf("%+v", r)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("did not stop in time")
	}
}

func TestCancelByTask(t *testing.T) {
	skipWindows(t)
	done := make(chan Result, 1)
	go func() {
		r, _ := Run(context.Background(), Opts{Dir: t.TempDir(), Command: "sleep 30", Task: "t1"})
		done <- r
	}()
	for i := 0; i < 100 && Cancel("t1") == 0; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case r := <-done:
		if !r.Cancelled || r.TimedOut {
			t.Fatalf("%+v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the command was not cut off")
	}
	if Cancel("nobody") != 0 || Cancel("") != 0 {
		t.Error("nothing to cancel")
	}
}

func TestLongOutputKeepsBeginningAndEnd(t *testing.T) {
	skipWindows(t)
	r, err := Run(context.Background(), Opts{Dir: t.TempDir(), Command: "echo START; yes line | head -n 200000; echo END"})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Truncated || !strings.HasPrefix(r.Output, "START") || !strings.HasSuffix(strings.TrimSpace(r.Output), "END") || len(r.Output) > 30*1024 {
		t.Fatalf("truncated=%v len=%d", r.Truncated, len(r.Output))
	}
}

func TestRefusesBadInput(t *testing.T) {
	skipWindows(t)
	for name, o := range map[string]Opts{
		"empty":     {Dir: t.TempDir(), Command: "  "},
		"nul":       {Dir: t.TempDir(), Command: "echo a\x00b"},
		"too long":  {Dir: t.TempDir(), Command: strings.Repeat("x", MaxCommand+1)},
		"no folder": {Dir: "/no/such/folder", Command: "true"},
	} {
		if _, err := Run(context.Background(), o); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
