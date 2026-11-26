// Package repo reads a repository (L1: read only) by running the system git, the way the person's own terminal would — but defensively:
// a repository can carry a malicious .git/config, so everything that could run a program from it is switched off for every call.
package repo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	gitTimeout = 20 * time.Second
	// MaxOutput caps what one git call may return (a diff of a huge change is cut, and says so).
	MaxOutput = 200 * 1024
)

// hardening is put in front of every command: a repository's own config must not be able to execute anything.
//
//	core.fsmonitor / core.hooksPath / diff.external / textconv / pager / ssh / credential helpers are the usual ways a hostile .git/config runs code.
var hardening = []string{
	"-c", "core.fsmonitor=false",
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.pager=cat",
	"-c", "core.quotepath=off",
	"-c", "diff.external=",
	"-c", "protocol.ext.allow=never",
	"-c", "credential.helper=",
	"--no-optional-locks", // a status must not take index.lock: the person's own git may be running
}

// Result is the output of one git call.
type Result struct {
	Out       string
	Truncated bool
}

type capped struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
			c.truncated = true
		} else {
			c.buf.Write(p)
		}
	} else if len(p) > 0 {
		c.truncated = true
	}
	return len(p), nil
}

// Git runs `git -C dir <args>` with the hardening, a timeout and a cap on the output.
func Git(ctx context.Context, dir string, args ...string) (Result, error) {
	return run(ctx, dir, runOpts{timeout: gitTimeout}, args...)
}

// runOpts are the few ways one call differs from the read-only default.
type runOpts struct {
	timeout time.Duration
	env     []string // added after the defaults (a later value wins)
	extra   []string // more `-c` pairs, put after the hardening
	stdin   string
}

func run(ctx context.Context, dir string, o runOpts, args ...string) (Result, error) {
	if o.timeout <= 0 {
		o.timeout = gitTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, o.timeout)
	defer cancel()
	full := append(append(append([]string{}, hardening...), o.extra...), args...)
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, full...)...)
	cmd.Env = append(append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_PAGER=cat", "LC_ALL=C", "GIT_ASKPASS=/bin/false", "GIT_EXTERNAL_DIFF=", "GIT_SSH_COMMAND=/bin/false"), o.env...)
	if o.stdin != "" {
		cmd.Stdin = strings.NewReader(o.stdin)
	}
	out := &capped{max: MaxOutput}
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = out, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return Result{}, errors.New("git took too long")
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return Result{}, fmt.Errorf("git %s: %s", args[0], firstLine(msg))
	}
	return Result{Out: out.buf.String(), Truncated: out.truncated}, nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
