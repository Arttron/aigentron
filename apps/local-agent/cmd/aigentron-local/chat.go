package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"

	"github.com/Arttron/aigentron/apps/local-agent/internal/agent"
	"github.com/Arttron/aigentron/apps/local-agent/internal/llm"
	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
)

// cmdChat is the local mode: an agent in the terminal, a model on this machine, no server. It works in one repository the person allowed with `add`.
func cmdChat(args []string) error {
	fs := flag.NewFlagSet("chat", flag.ContinueOnError)
	repoArg := fs.String("repo", "", "the repository (id from `roots`, or its path); default: the one you are in")
	model := fs.String("model", "", "the model (default: the first one the model server has)")
	backend := fs.String("backend", "", "which model server from `llm` (default: the first)")
	prompt := fs.String("p", "", "one request, then exit (nothing that changes the repository can be approved without a terminal)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *prompt == "" && fs.NArg() > 0 {
		*prompt = strings.Join(fs.Args(), " ")
	}

	in0 := bufio.NewReader(os.Stdin)
	if *repoArg == "" {
		offerCwdRoot(context.Background(), in0)
	}
	root, err := pickRoot(*repoArg)
	if err != nil {
		return err
	}
	cfg, err := llm.Load()
	if err != nil {
		return err
	}
	b, err := cfg.Pick(*backend)
	if err != nil {
		return errors.New("no model server set up — `aigentron llm add ollama http://localhost:11434` (LM Studio: http://localhost:1234)")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	m := *model
	if m == "" {
		ids, err := llm.BackendModels(ctx, b)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return fmt.Errorf("%s has no model — pull or load one first", b.Name)
		}
		m = ids[0]
	}

	interactive := isTerminal(os.Stdin)
	in := in0
	var approve func(string) bool
	if interactive {
		approve = func(summary string) bool {
			fmt.Printf("\n┌─ approve?\n%s\n└─ apply [y/N]: ", indent(summary))
			line, _ := in.ReadString('\n')
			return strings.EqualFold(strings.TrimSpace(line), "y") || strings.EqualFold(strings.TrimSpace(line), "yes")
		}
	}
	s := agent.New(root, b, m, os.Stdout, approve)

	ask := func(text string) {
		tctx, cancel := context.WithCancel(ctx)
		defer cancel()
		out, err := s.Turn(tctx, text)
		switch {
		case err != nil:
			fmt.Println("✗", err)
		default:
			fmt.Println("\n" + out + "\n")
		}
	}
	fmt.Printf("aigentron · %s · model %s (%s)\n", root.Path, m, b.Name)
	if *prompt != "" {
		ask(*prompt)
		return nil
	}
	if !interactive {
		return errors.New("no terminal: use -p \"<request>\" for a single request")
	}
	fmt.Println("Ask for something. Every edit and commit is shown to you first. /exit to leave.")
	for ctx.Err() == nil {
		fmt.Print("› ")
		line, err := in.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "/exit" || line == "/quit" || (err != nil && line == "") {
			return nil
		}
		if line != "" {
			ask(line)
		}
	}
	return nil
}

func pickRoot(arg string) (policy.Root, error) {
	roots, err := policy.LoadRoots()
	if err != nil {
		return policy.Root{}, err
	}
	if len(roots) == 0 {
		return policy.Root{}, errors.New("no repository allowed yet — `aigentron add <path to a git repository>`")
	}
	if arg != "" {
		if r, ok := policy.Find(roots, arg); ok {
			return r, nil
		}
		if abs, err := filepath.EvalSymlinks(arg); err == nil {
			for _, r := range roots {
				if r.Path == abs {
					return r, nil
				}
			}
		}
		return policy.Root{}, fmt.Errorf("%q is not an allowed repository (see `aigentron roots`)", arg)
	}
	if out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output(); err == nil {
		top, _ := filepath.EvalSymlinks(strings.TrimSpace(string(out)))
		for _, r := range roots {
			if r.Path == top {
				return r, nil
			}
		}
	}
	if len(roots) == 1 {
		return roots[0], nil
	}
	var names []string
	for _, r := range roots {
		names = append(names, fmt.Sprintf("%s %s", r.ID, r.Path))
	}
	return policy.Root{}, fmt.Errorf("which repository? --repo <id>: %s", strings.Join(names, " · "))
}

func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func indent(s string) string {
	return "│ " + strings.ReplaceAll(strings.TrimRight(s, "\n"), "\n", "\n│ ")
}
