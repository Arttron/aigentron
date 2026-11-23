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
