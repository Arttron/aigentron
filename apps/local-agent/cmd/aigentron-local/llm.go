package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/link"
	"github.com/Arttron/aigentron/apps/local-agent/internal/llm"
)

var runner = llm.NewRunner()

// llmOp answers the model commands. `llm.chat` streams: every chunk of the answer goes out as an `llm.chunk` event carrying the command's id, then the
// command's result says how it ended.
func llmOp(ctx context.Context, id, op string, args json.RawMessage) (any, error) {
	cfg, err := llm.Load()
	if err != nil {
		return nil, err
	}
	switch op {
	case "llm.models":
		models, problems := llm.ListModels(ctx, cfg)
		return map[string]any{"models": models, "problems": problems, "shared": len(cfg.Allow) > 0}, nil
	case "llm.cancel":
		var a struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(args, &a)
		runner.Cancel(a.ID)
		return map[string]any{"ok": true}, nil
	case "llm.chat":
		var a llm.ChatArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return nil, errors.New("bad arguments")
		}
		emit := link.EmitterFrom(ctx)
		return runner.Chat(ctx, cfg, a, func(payload string) {
			emit("llm.chunk", map[string]any{"id": a.ID, "data": payload})
		})
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

func cmdLLM(args []string) error {
	if len(args) == 0 {
		return cmdLLMShow()
	}
	cfg, err := llm.Load()
	if err != nil {
		return err
	}
	switch args[0] {
	case "add":
		rest, remote := stripFlag(args[1:], "--allow-remote")
		if len(rest) != 2 {
			return errors.New("usage: aigentron llm add <name> <url> [--allow-remote]   e.g. add ollama http://localhost:11434   ·   add lmstudio http://localhost:1234")
		}
		if err := cfg.AddBackend(rest[0], rest[1], remote); err != nil {
			return err
		}
		fmt.Printf("Added %s. Nothing is shared yet: choose the models with `aigentron llm allow <model>` (a name, a pattern such as qwen*, or *).\n", rest[0])
	case "remove":
		if len(args) != 2 || !cfg.RemoveBackend(args[1]) {
			return errors.New("usage: aigentron llm remove <name>")
		}
		fmt.Println("Removed.")
	case "allow":
		if len(args) < 2 {
			return errors.New("usage: aigentron llm allow <model|pattern> …")
		}
		for _, m := range args[1:] {
			if strings.TrimSpace(m) != "" {
				cfg.Allow = appendUnique(cfg.Allow, m)
			}
		}
		fmt.Println("Shared with the server:", strings.Join(cfg.Allow, ", "))
	case "deny":
		if len(args) < 2 {
			return errors.New("usage: aigentron llm deny <model|pattern> …")
		}
		keep := cfg.Allow[:0]
		for _, p := range cfg.Allow {
			if !contains(args[1:], p) {
				keep = append(keep, p)
			}
		}
		cfg.Allow = keep
		fmt.Println("Shared with the server:", strings.Join(cfg.Allow, ", "))
	case "parallel":
		if len(args) != 2 {
			return errors.New("usage: aigentron llm parallel <1-8>")
		}
		var n int
		if _, err := fmt.Sscanf(args[1], "%d", &n); err != nil || n < 1 || n > 8 {
			return errors.New("a number from 1 to 8")
		}
		cfg.Parallel = n
	case "models":
		return cmdLLMShow()
	default:
		return fmt.Errorf("unknown: llm %s", args[0])
	}
	return llm.Save(cfg)
}

func cmdLLMShow() error {
	cfg, err := llm.Load()
	if err != nil {
		return err
	}
	if len(cfg.Backends) == 0 {
		fmt.Println("No model server set up. Share a local model with the server:\n  aigentron llm add ollama http://localhost:11434\n  aigentron llm allow 'qwen3-coder*'")
		return nil
	}
	for _, b := range cfg.Backends {
		fmt.Printf("%s  %s\n", b.Name, b.URL)
	}
	fmt.Println("shared models:", strings.Join(cfg.Allow, ", "))
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	models, problems := llm.ListModels(ctx, cfg)
	for _, m := range models {
		fmt.Printf("  available to the server: %s (%s)\n", m.ID, m.Backend)
	}
	for _, p := range problems {
		fmt.Fprintln(os.Stderr, "  problem:", p)
	}
	return nil
}

func stripFlag(a []string, flag string) ([]string, bool) {
	out, found := []string{}, false
	for _, x := range a {
		if x == flag {
			found = true
		} else {
			out = append(out, x)
		}
	}
	return out, found
}

func contains(a []string, s string) bool {
	for _, x := range a {
		if x == s {
			return true
		}
	}
	return false
}

func appendUnique(a []string, s string) []string {
	if contains(a, s) {
		return a
	}
	return append(a, s)
}
