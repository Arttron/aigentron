package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/link"
	"github.com/Arttron/aigentron/apps/local-agent/internal/oplog"
	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
)

var warnOnce sync.Once

// journaled writes every command the server sends into the operations journal (when the person turned it on). It records the request and how it ended,
// never contents: the arguments kept are the repository id, the path, and for a model request the backend and model name — not the messages.
func journaled(next link.Handler) link.Handler {
	return func(ctx context.Context, op string, args json.RawMessage) (any, error) {
		start := time.Now()
		data, err := next(ctx, op, args)
		e := entryFor(op, args)
		e.Ms = time.Since(start).Milliseconds()
		e.Result = "ok"
		if err != nil {
			e.Result, e.Error = "error", err.Error()
		}
		if werr := oplog.Record(e); werr != nil {
			warnOnce.Do(func() { fmt.Fprintln(os.Stderr, "warning: the operations journal could not be written:", werr) })
		}
		return data, err
	}
}

func entryFor(op string, args json.RawMessage) oplog.Entry {
	e := oplog.Entry{Op: op}
	var a struct {
		Repo    string `json:"repo"`
		Path    string `json:"path"`
		Backend string `json:"backend"`
		Request struct {
			Model string `json:"model"`
		} `json:"request"`
	}
	if json.Unmarshal(args, &a) == nil {
		e.Repo, e.Path = a.Repo, a.Path
		if a.Backend != "" || a.Request.Model != "" {
			e.Detail = a.Backend + "/" + a.Request.Model
		}
	}
	return e
}

const logUsage = `usage:
  aigentron log [-n 20]        show the last operations the server asked this computer to do
  aigentron log on | off       turn the journal on or off (it is off by default)
  aigentron log rotate <MB> <files>   rotate at <MB> megabytes (1-100), keep <files> old files (0-20)
  aigentron log path           where the files are
  aigentron log clear          delete the journal`

func cmdLog(args []string) error {
	if len(args) > 0 {
		switch args[0] {
		case "on", "off":
			c, err := oplog.Load()
			if err != nil {
				return err
			}
			c.Enabled = args[0] == "on"
			if err := oplog.Save(c); err != nil {
				return err
			}
			if c.Enabled {
				fmt.Printf("Journal on: every command from the server is written (request and outcome, never contents). Rotation: %d MB, %d old files. A running agent picks this up at once.\n", c.MaxMB, c.Keep)
			} else {
				fmt.Println("Journal off. The existing files stay (delete them with: log clear).")
			}
			return nil
		case "rotate":
			if len(args) != 3 {
				return errors.New(logUsage)
			}
			mb, e1 := strconv.Atoi(args[1])
			keep, e2 := strconv.Atoi(args[2])
			if e1 != nil || e2 != nil || mb < 1 || mb > oplog.MaxMaxMB || keep < 0 || keep > oplog.MaxKeep {
				return fmt.Errorf("size 1-%d MB and 0-%d files, e.g. `log rotate 5 3`", oplog.MaxMaxMB, oplog.MaxKeep)
			}
			c, err := oplog.Load()
			if err != nil {
				return err
			}
			c.MaxMB, c.Keep = mb, keep
			if err := oplog.Save(c); err != nil {
				return err
			}
			fmt.Printf("Rotation: at %d MB, %d old files kept (at most about %d MB on disk).\n", mb, keep, mb*(keep+1))
			return nil
		case "path":
			p, err := oplog.FilePath()
			if err != nil {
				return err
			}
			fmt.Println(p)
			return nil
		case "clear":
			if err := oplog.Clear(); err != nil {
				return err
			}
			fmt.Println("Journal deleted.")
			return nil
		}
	}
	fs := flag.NewFlagSet("log", flag.ContinueOnError)
	n := fs.Int("n", 20, "how many entries")
	if err := fs.Parse(args); err != nil {
		return err
	}
	c, err := oplog.Load()
	if err != nil {
		return err
	}
	if !c.Enabled {
		fmt.Println("The journal is off (turn it on with: aigentron log on).")
	}
	entries, err := oplog.Tail(*n)
	if err != nil {
		return err
	}
	for _, e := range entries {
		line := fmt.Sprintf("%s  %-12s", e.Time, e.Op)
		if e.Repo != "" {
			line += " " + e.Repo
		}
		if e.Path != "" {
			line += " " + e.Path
		}
		if e.Detail != "" {
			line += " " + e.Detail
		}
		line += "  " + e.Result
		if e.Error != "" {
			line += ": " + e.Error
		}
		fmt.Println(line)
	}
	if len(entries) == 0 && c.Enabled {
		fmt.Println("Nothing recorded yet.")
	}
	return nil
}

// journalOn: is the operations journal on? (shown in `status`)
func journalOn() bool {
	c, err := oplog.Load()
	return err == nil && c.Enabled
}

// journalAuto records what the rules engine did on its own (op "auto.snapshot" / "auto.fetch" / "auto.fast-forward"), when the journal is on.
func journalAuto(op string, root policy.Root, detail string, err error) {
	e := oplog.Entry{Op: op, Repo: root.ID, Detail: detail, Result: "ok"}
	if err != nil {
		e.Result, e.Error = "error", err.Error()
	}
	_ = oplog.Record(e)
}
