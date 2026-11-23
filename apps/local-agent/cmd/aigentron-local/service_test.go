package main

import (
	"strings"
	"testing"
)

func TestRenderPlistEscapes(t *testing.T) {
	p := renderPlist("dev.aigentron", `/Users/a&b/<x>/aigentron`, "/tmp/log", "/h&me")
	for _, want := range []string{"<string>/Users/a&amp;b/&lt;x&gt;/aigentron</string><string>run</string>", "<key>KeepAlive</key><true/>", "AIGENTRON_LOCAL_HOME</key><string>/h&amp;me"} {
		if !strings.Contains(p, want) {
			t.Errorf("missing %q in\n%s", want, p)
		}
	}
	if strings.Contains(renderPlist("l", "/x", "/l", ""), "EnvironmentVariables") {
		t.Error("no env when there is no override")
	}
}

func TestRenderUnitQuotes(t *testing.T) {
	u := renderUnit(`/home/my user/.local/bin/aigentron`, "")
	if !strings.Contains(u, `ExecStart="/home/my user/.local/bin/aigentron" run`) || !strings.Contains(u, "Restart=always") {
		t.Error(u)
	}
	if !strings.Contains(renderUnit(`/a%b/$c`, ""), `"/a%%b/$$c"`) {
		t.Error("% and $ must be doubled")
	}
}

func TestLaunchdState(t *testing.T) {
	out := "gui/501/dev.aigentron = {\n\tstate = running\n\tpid = 81557\n\tsub = {\n\t\tstate = active\n\t\tpid = 9\n\t}\n}"
	if got := launchdState(out); got != "running, pid 81557" {
		t.Errorf("got %q", got)
	}
	if launchdState("nothing") != "loaded" {
		t.Error("fallback")
	}
}
