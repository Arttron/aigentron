package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
	"github.com/Arttron/aigentron/apps/local-agent/internal/link"
	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
	"github.com/Arttron/aigentron/apps/local-agent/internal/repo"
	"github.com/Arttron/aigentron/apps/local-agent/internal/workspace"
)

// cmdOpen: `aigentron open [<project>] [--dir <folder>] [--yes]` — work on a project's repository from any folder. If a copy is already there it is allowed;
// otherwise the repository is cloned (after you have seen the address and the folder) and allowed. Everything the server said is checked here first.
func cmdOpen(args []string) error {
	fs := flag.NewFlagSet("open", flag.ContinueOnError)
	dir := fs.String("dir", "", "where to put it (default: ./<project>)")
	yes := fs.Bool("yes", false, "do not ask (for scripts)")
	if err := fs.Parse(reorderFlags(args)); err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	projects, err := link.FetchProjects(ctx, nil, cfg)
	if err != nil {
		return err
	}
	if len(projects) == 0 {
		return errors.New("the server has no project with a repository address (Projects → settings → Repository)")
	}
	if fs.NArg() == 0 {
		fmt.Println("Projects you can open (aigentron open <name>):")
		for _, p := range projects {
			fmt.Printf("  %-24s %s\n", p.Slug, p.RepoURL)
		}
		return nil
	}
	p, err := pickProject(projects, strings.Join(fs.Args(), " "))
	if err != nil {
		return err
	}
	repoURL, err := workspace.CheckRepoURL(p.RepoURL)
	if err != nil {
		return fmt.Errorf("%s: %v", p.Name, err)
	}
	dest := *dir
	if dest == "" {
		dest = workspace.FolderName(p.Slug)
	}
	if dest, err = filepath.Abs(dest); err != nil {
		return err
	}
	kind, err := workspace.CheckDest(dest)
	if err != nil {
		return err
	}
	in := bufio.NewReader(os.Stdin)
	confirm := func(q string) bool {
		if *yes {
			return true
		}
		if !isTerminal(os.Stdin) {
			fmt.Println("(no terminal to ask on — add --yes to go ahead)")
			return false
		}
		fmt.Print(q + " [y/N]: ")
		line, _ := in.ReadString('\n')
		return strings.EqualFold(strings.TrimSpace(line), "y") || strings.EqualFold(strings.TrimSpace(line), "yes")
	}

	switch kind {
	case workspace.DestExists:
		// a folder with files: only fine when it already is this project's repository
		top := workspace.TopOf(ctx, dest)
		if top == "" || top != resolved(dest) || workspace.Normalize(workspace.OriginOf(ctx, dest)) != workspace.Normalize(repoURL) {
			return fmt.Errorf("%s is not empty and is not a copy of %s — choose another folder with --dir", dest, p.Name)
		}
		fmt.Printf("%s already holds %s.\n", dest, p.Name)
		if !confirm("Allow the agent to work in it?") {
			return errors.New("not allowed")
		}
	default:
		fmt.Printf("Project:    %s\nRepository: %s\nInto:       %s\nThis downloads the repository with your own git login (nothing from it is run).\n", p.Name, repoURL, dest)
		if !confirm("Clone and allow the agent to work in it?") {
			return errors.New("cancelled")
		}
		if err := workspace.Clone(ctx, repoURL, dest, p.Branch, [3]*os.File{os.Stdin, os.Stdout, os.Stderr}, false); err != nil {
			return err
		}
		if workspace.Normalize(workspace.OriginOf(ctx, dest)) != workspace.Normalize(repoURL) {
			return errors.New("the clone's origin is not the project's repository — left as it is, not allowed")
		}
	}
	r, err := policy.AddRoot(dest)
	if err != nil {
		return fmt.Errorf("cloned, but it cannot be allowed: %v", err)
	}
	fmt.Printf("\nAllowed: %s (id %s)\n  work in it now:   cd %s && %s chat\n  share it with %s: keep `%s run` going and press Share on Add-ons → Local agent.\n", r.Path, r.ID, shellQuote(r.Path), progName(), p.Name, progName())
	return nil
}

func resolved(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}

func shellQuote(s string) string {
	if strings.ContainsAny(s, " \t'\"$`\\") {
		return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
	}
	return s
}

// pickProject: by slug, id or name (case-insensitive); an ambiguous or unknown word lists the choices.
func pickProject(ps []link.Project, word string) (link.Project, error) {
	w := strings.ToLower(strings.TrimSpace(word))
	var hit []link.Project
	for _, p := range ps {
		if strings.EqualFold(p.ID, w) || strings.EqualFold(p.Slug, w) || strings.EqualFold(p.Name, w) {
			hit = append(hit, p)
		}
	}
	if len(hit) == 1 {
		return hit[0], nil
	}
	var names []string
	for _, p := range ps {
		names = append(names, p.Slug)
	}
	if len(hit) > 1 {
		return link.Project{}, fmt.Errorf("%q matches several projects — use the id or slug", word)
	}
	return link.Project{}, fmt.Errorf("no project %q (have: %s)", word, strings.Join(names, ", "))
}

// reorderFlags lets flags come after the project name (`open shop --dir x`), which the flag package does not.
func reorderFlags(args []string) []string {
	var flags, rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") {
			flags = append(flags, a)
			if (a == "--dir" || a == "-dir") && i+1 < len(args) {
				i++
				flags = append(flags, args[i])
			}
		} else {
			rest = append(rest, a)
		}
	}
	return append(flags, rest...)
}

// offerCwdRoot: when the program is started inside a git repository that is not allowed yet, ask once whether to allow it — starting it in the project's folder is
// how the person says "work here". Only on a terminal; the checks of `add` apply (the home folder, a folder above it, secret folders are refused).
func offerCwdRoot(ctx context.Context, in *bufio.Reader) {
	if !isTerminal(os.Stdin) {
		return
	}
	cwd, err := os.Getwd()
	if err != nil {
		return
	}
	top := workspace.TopOf(ctx, cwd)
	if top == "" {
		return
	}
	roots, _ := policy.LoadRoots()
	for _, r := range roots {
		if r.Path == top {
			return
		}
	}
	if err := policy.CheckRoot(top); err != nil {
		return // the home folder and the like: say nothing, `add` explains if asked
	}
	origin := workspace.OriginOf(ctx, top)
	if origin == "" {
		origin = "no origin"
	} else {
		origin = repo.StripCredentials(origin)
	}
	fmt.Printf("This folder is a git repository that is not allowed yet:\n  %s (%s)\nAllow the agent to read it (and, with your approval each time, change it)? [y/N]: ", top, origin)
	line, _ := in.ReadString('\n')
	if !strings.EqualFold(strings.TrimSpace(line), "y") && !strings.EqualFold(strings.TrimSpace(line), "yes") {
		return
	}
	if r, err := policy.AddRoot(top); err != nil {
		fmt.Println("✗", err)
	} else {
		fmt.Printf("Allowed: %s (id %s)\n", r.Path, r.ID)
	}
}
