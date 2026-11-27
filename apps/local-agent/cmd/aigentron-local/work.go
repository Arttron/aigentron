package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/agent"
	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
	"github.com/Arttron/aigentron/apps/local-agent/internal/shell"
	"github.com/Arttron/aigentron/apps/local-agent/internal/writes"
)

// workOp answers the commands that look around and work in an allowed repository: list and search files, edit and create a file, run a command.
// Looking around is open to a connected project like the read commands; everything else needs the owner's switch (`aigentron writes on`) and no Stop in force.
// The server has already asked the person (a grant card, and for a command the same classification as on a server agent).
func workOp(ctx context.Context, op string, args json.RawMessage) (any, error) {
	var a struct {
		Repo       string `json:"repo"`
		Path       string `json:"path"`
		Query      string `json:"query"`
		Old        string `json:"old"`
		New        string `json:"new"`
		Content    string `json:"content"`
		Command    string `json:"command"`
		TimeoutSec int    `json:"timeoutSec"`
		Task       string `json:"task"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, errors.New("bad arguments")
	}
	if op == "exec.cancel" {
		return map[string]any{"cancelled": shell.Cancel(a.Task)}, nil
	}
	if op != "fs.list" && op != "fs.search" {
		if until := writes.StoppedUntil(); !until.IsZero() {
			return nil, fmt.Errorf("the person pressed Stop on this computer (until %s) — do not change or run anything; ask them", until.Format("15:04"))
		}
		if !writes.Allowed() {
			return nil, errors.New("writes are off on this computer: the owner can allow changes with `aigentron writes on`")
		}
	}
	roots, err := policy.LoadRoots()
	if err != nil {
		return nil, err
	}
	root, ok := policy.Find(roots, a.Repo)
	if !ok {
		return nil, fmt.Errorf("no allowed repository %q (add it on that computer with `aigentron add <path>`)", a.Repo)
	}
	file := func(tool string, m map[string]any) (any, error) {
		b, _ := json.Marshal(m)
		text, err := agent.RunTool(ctx, root, tool, b)
		if err != nil {
			return nil, err
		}
		return map[string]any{"text": text}, nil
	}
	switch op {
	case "fs.list":
		return file("list_files", map[string]any{"path": a.Path})
	case "fs.search":
		return file("search", map[string]any{"query": a.Query, "path": a.Path})
	case "fs.edit":
		return file("edit_file", map[string]any{"path": a.Path, "old": a.Old, "new": a.New})
	case "fs.write":
		return file("write_file", map[string]any{"path": a.Path, "content": a.Content})
	default: // exec.run
		// a Stop pressed on this computer while the command runs cuts it off
		rctx, cancel := context.WithCancel(ctx)
		defer cancel()
		go func() {
			for t := time.NewTicker(time.Second); ; {
				select {
				case <-rctx.Done():
					t.Stop()
					return
				case <-t.C:
					if writes.Stopped() {
						cancel()
					}
				}
			}
		}()
		return shell.Run(rctx, shell.Opts{Dir: root.Path, Command: a.Command, Timeout: time.Duration(a.TimeoutSec) * time.Second, Task: a.Task})
	}
}
