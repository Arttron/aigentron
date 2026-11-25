// aigentron is the Aigentron agent for a person's own machine: it pairs with a server and keeps one connection up
// so server-side agents (under approvals) can work with the local repositories. See docs/plan-local-agent.md.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
	"github.com/Arttron/aigentron/apps/local-agent/internal/link"
	"github.com/Arttron/aigentron/apps/local-agent/internal/llm"
	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
	"github.com/Arttron/aigentron/apps/local-agent/internal/repo"
	"github.com/Arttron/aigentron/apps/local-agent/internal/rules"
)

// version is set at build time: -ldflags "-X main.version=$(cat VERSION)".
var version = "dev"

const usage = `aigentron %s

  login --server <url> [--name <device name>]                sign in through your browser (the usual way)
  pair --server <url> --code <code> [--name <device name>]   pair with a one-use code (a machine without a browser)
  run                                                        connect and stay connected (in this terminal)
  update [--check]                                           become the version of your server (checks the SHA-256, keeps the old one as .prev, restarts the service)
  service install|uninstall|status                           keep "run" going in the background and start it at sign-in (launchd / systemd --user)
  add <path>                                                 allow a git repository (its top folder) — agents can then read it, never anything else
  remove <id|path>                                           stop allowing a repository
  roots                                                      list the allowed repositories
  open [<project>] [--dir <folder>]                          work on a server project from any folder: use the copy that is here, or clone it (you confirm the address and folder)
  chat [--repo <id|path>] [--model <name>] [-p <prompt>]      work on a repository with a model that runs HERE (offline: no server, no internet); every change asks you first
  llm [add <name> <url> | allow <model> | deny <model> | remove <name> | parallel <n>]   share a model that runs here (Ollama, LM Studio, llama-server) with the server
  log [-n 20] | on | off | rotate <MB> <files> | path | clear   the journal of what the server asked this computer to do (off by default; requests only, never contents)
  rules [--repo <path>]                                      show the rules that apply (global + the repository's .aigentron/local.yaml)
  server <url>                                               the server moved to another address: keep the pairing, change the address
  status                                                     show the pairing (never the token)
  unpair                                                     forget the pairing on this machine
  version
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, usage, version)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println(version)
	case "login":
		err = cmdLogin(os.Args[2:])
	case "pair":
		err = cmdPair(os.Args[2:])
	case "run":
		err = cmdRun()
	case "add":
		err = cmdAdd(os.Args[2:])
	case "remove":
		err = cmdRemove(os.Args[2:])
	case "roots":
		err = cmdRoots()
	case "update":
		err = cmdUpdate(os.Args[2:])
	case "service":
		err = cmdService(os.Args[2:])
	case "open":
		err = cmdOpen(os.Args[2:])
	case "chat":
		err = cmdChat(os.Args[2:])
	case "llm":
		err = cmdLLM(os.Args[2:])
	case "log":
		err = cmdLog(os.Args[2:])
	case "rules":
		err = cmdRules(os.Args[2:])
	case "server":
		err = cmdServer(os.Args[2:])
	case "status":
		err = cmdStatus()
	case "unpair":
		err = config.Clear()
		if err == nil {
			fmt.Println("Forgotten. (Remove the device on the dashboard too.)")
		}
	case "help", "--help", "-h":
		fmt.Printf(usage, version)
	default:
		fmt.Fprintf(os.Stderr, usage, version)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func info() link.Info {
	host, _ := os.Hostname()
	return link.Info{Version: version, OS: runtime.GOOS, Arch: runtime.GOARCH, Host: host}
}

func cmdPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	server := fs.String("server", "", "server address, e.g. https://dev.example.com")
	code := fs.String("code", "", "one-use pairing code")
	host, _ := os.Hostname()
	name := fs.String("name", deviceName(host), "device name shown in the dashboard")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *server == "" || *code == "" {
		return errors.New("--server and --code are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cfg, err := link.Pair(ctx, nil, *server, *code, *name, info())
	if err != nil {
		return err
	}
	if err := config.Save(cfg); err != nil {
		return err
	}
	fmt.Printf("Paired with %s as %q. Start it with: %s run\n", cfg.Server, cfg.Device, progName())
	return nil
}

func cmdLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	server := fs.String("server", "", "server address, e.g. https://dev.example.com")
	host, _ := os.Hostname()
	name := fs.String("name", deviceName(host), "device name shown in the dashboard")
	noBrowser := fs.Bool("no-browser", false, "only print the link, do not open it")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *server == "" {
		return errors.New("--server is required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := link.Login(ctx, nil, *server, *name, info(), func(p link.LoginPrompt) {
		fmt.Printf("\nTo connect this computer, open:\n\n  %s\n\nand check that the code is  %s  (valid %d min).\n", p.VerificationURL, p.UserCode, int(p.ExpiresIn.Minutes()))
		if !*noBrowser && openBrowser(p.VerificationURL) != nil {
			fmt.Println("(could not open a browser — open the link yourself)")
		}
		fmt.Println("Waiting for approval…")
	})
	if err != nil {
		return err
	}
	if err := config.Save(cfg); err != nil {
		return err
	}
	fmt.Printf("Connected to %s as %q. Start it with: %s run\n", cfg.Server, cfg.Device, progName())
	return nil
}

// openBrowser asks the OS to open a link in the default browser.
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

func cmdServer(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: aigentron server <url>")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	addr, err := link.NormalizeServer(args[0])
	if err != nil {
		return err
	}
	cfg.Server = addr
	if err := config.Save(cfg); err != nil {
		return err
	}
	fmt.Printf("The server address is now %s (the pairing is kept; restart `run` if it is running).\n", addr)
	return nil
}

func cmdStatus() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	fmt.Printf("server: %s\ndevice: %s\nversion: %s (%s/%s)\n", cfg.Server, cfg.Device, version, runtime.GOOS, runtime.GOARCH)
	return nil
}

func cmdRun() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// started inside a project's folder: that is how the person says "work here" (asked once, on a terminal)
	offerCwdRoot(ctx, bufio.NewReader(os.Stdin))
	rev, _, err := rules.LoadGlobal()
	if err != nil {
		fmt.Fprintln(os.Stderr, "warning:", err, "— using the defaults until the server syncs the rules")
		rev = 0
	}
	var cur atomic.Int64
	cur.Store(int64(rev))
	c := &link.Client{Cfg: cfg, Info: info(), Handle: newHandler(&cur), Rev: func() int { return int(cur.Load()) }}
	// watch the allowed repositories and tell the server what changed (the whole picture again whenever the line comes back)
	w := repo.NewWatcher(policy.LoadRoots, c.Emit)
	if n, err := strconv.Atoi(os.Getenv("AIGENTRON_LOCAL_POLL_SECONDS")); err == nil && n >= 1 { // a knob for tests and the impatient
		w.Interval = time.Duration(n) * time.Second
	}
	c.OnState = func(state string) {
		if state == "online" {
			w.Flush()
		}
	}
	go w.Run(ctx)
	if err := c.Run(ctx); err != nil {
		return err
	}
	return nil
}

// newHandler answers the commands of this stage: `status` and `config.set` (the server pushes the global rules; later stages add the repository operations).
func newHandler(rev *atomic.Int64) link.Handler {
	return journaled(handle(rev))
}

func handle(rev *atomic.Int64) link.Handler {
	return func(ctx context.Context, op string, args json.RawMessage) (any, error) {
		switch op {
		case "status":
			i := info()
			roots, _ := policy.LoadRoots()
			return map[string]any{"version": i.Version, "os": i.OS, "arch": i.Arch, "host": i.Host, "roots": len(roots), "configRev": rev.Load(), "llm": llmShared(), "journal": journalOn()}, nil
		case "config.set":
			var a struct {
				Rev   int             `json:"rev"`
				Rules json.RawMessage `json:"rules"`
			}
			if err := json.Unmarshal(args, &a); err != nil || a.Rev < 1 || len(a.Rules) == 0 {
				return nil, errors.New("config.set needs {rev, rules}")
			}
			l, err := rules.Parse(a.Rules)
			if err != nil {
				return nil, err
			}
			if err := rules.SaveGlobal(a.Rev, l); err != nil {
				return nil, err
			}
			rev.Store(int64(a.Rev))
			return map[string]any{"rev": a.Rev}, nil
		case "llm.models", "llm.chat", "llm.cancel":
			return llmOp(ctx, "", op, args)
		case "repos.list", "repo.status", "repo.diff", "repo.log", "repo.read":
			return repoOp(ctx, op, args)
		}
		return nil, fmt.Errorf("unknown op %q", op)
	}
}

// repoOp answers the read-only repository commands. A repository is named by its id (from `roots`); only repositories the person added are known.
func repoOp(ctx context.Context, op string, args json.RawMessage) (any, error) {
	roots, err := policy.LoadRoots()
	if err != nil {
		return nil, err
	}
	if op == "repos.list" {
		return map[string]any{"repos": repo.Snapshot(ctx, roots)}, nil
	}
	var a struct {
		Repo   string `json:"repo"`
		Path   string `json:"path"`
		Staged bool   `json:"staged"`
		Limit  int    `json:"limit"`
		Offset int    `json:"offset"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, errors.New("bad arguments")
	}
	root, ok := policy.Find(roots, a.Repo)
	if !ok {
		return nil, fmt.Errorf("no allowed repository %q (add it on that computer with `aigentron add <path>`)", a.Repo)
	}
	switch op {
	case "repo.status":
		return repo.ReadStatus(ctx, root), nil
	case "repo.diff":
		r, err := repo.ReadDiff(ctx, root, a.Path, a.Staged)
		if err != nil {
			return nil, err
		}
		return map[string]any{"diff": r.Out, "truncated": r.Truncated}, nil
	case "repo.log":
		c, err := repo.ReadLog(ctx, root, a.Limit, a.Path)
		if err != nil {
			return nil, err
		}
		return map[string]any{"commits": c}, nil
	default: // repo.read
		return repo.ReadFile(root, a.Path, a.Offset, a.Limit)
	}
}

func cmdAdd(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: aigentron add <path to a git repository>")
	}
	r, err := policy.AddRoot(args[0])
	if err != nil {
		return err
	}
	fmt.Printf("Allowed: %s (id %s)\nAgents can now read this repository — its files, diff and history — except secrets (.env, keys, .git, .ssh …). Nothing is changed.\n", r.Path, r.ID)
	return nil
}

func cmdRemove(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: aigentron remove <id or path>")
	}
	ok, err := policy.RemoveRoot(args[0])
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%q is not an allowed repository", args[0])
	}
	fmt.Println("Removed.")
	return nil
}

func cmdRoots() error {
	roots, err := policy.LoadRoots()
	if err != nil {
		return err
	}
	if len(roots) == 0 {
		fmt.Println("No repositories allowed yet. Add one with: aigentron add <path>")
		return nil
	}
	for _, r := range roots {
		fmt.Printf("%s  %s\n", r.ID, r.Path)
	}
	return nil
}

func cmdRules(args []string) error {
	fs := flag.NewFlagSet("rules", flag.ContinueOnError)
	repo := fs.String("repo", "", "a repository: also read its .aigentron/local.yaml")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rev, global, err := rules.LoadGlobal()
	if err != nil {
		return err
	}
	gp, _ := rules.GlobalPath()
	var project *rules.Layer
	if *repo != "" {
		var path string
		if project, path, err = rules.LoadProject(*repo); err != nil {
			return err
		}
		if project == nil {
			fmt.Printf("project file: none (looked for %s in %s)\n", rules.ProjectFileNames[0], *repo)
		} else {
			fmt.Printf("project file: %s\n", path)
		}
	}
	e, warn := rules.Merge(&global, project)
	fmt.Printf("global file:  %s (revision %d%s)\n\n", gp, rev, map[bool]string{true: ", not synced yet — defaults", false: ""}[rev == 0])
	out, _ := json.MarshalIndent(e, "", "  ")
	fmt.Println(string(out))
	for _, w := range warn {
		fmt.Println("warning:", w)
	}
	return nil
}

// llmShared: does this computer share a model with the server? (shown in `status`, so the dashboard can tell)
func llmShared() bool {
	c, err := llm.Load()
	return err == nil && len(c.Backends) > 0 && len(c.Allow) > 0
}

// deviceName is the default name in the dashboard: the development build says so, so it is not mistaken for the installed program on the same computer.
func deviceName(host string) string {
	if config.Dev() {
		return host + " [dev]"
	}
	return host
}

// progName is how the person called this program (aigentron, or aigentron-dev for the development build), for the hints we print.
func progName() string { return filepath.Base(os.Args[0]) }
