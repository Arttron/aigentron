package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
	"github.com/Arttron/aigentron/apps/local-agent/internal/link"
	"github.com/Arttron/aigentron/apps/local-agent/internal/update"
)

// cmdUpdate: `aigentron update [--check] [--force]` — become the version of the server this computer is paired with. Only when typed: nothing updates in the background.
func cmdUpdate(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	check := fs.Bool("check", false, "only say whether there is a new version")
	force := fs.Bool("force", false, "install the server's version even if it is the same or older")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if config.Dev() {
		return errors.New("this is a development build — rebuild it with `make local-agent-dev`")
	}
	if runtime.GOOS == "windows" {
		return errors.New("on Windows download the new archive from Add-ons → Local agent")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	server, err := link.NormalizeServer(cfg.Server)
	if err != nil {
		return err
	}
	invoked, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err := filepath.EvalSymlinks(invoked) // `aigentron-local` is a link: replace the program it points to
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	dir := ""
	if !*check {
		dir = filepath.Dir(exe)
	}
	o, err := update.Fetch(ctx, nil, server, runtime.GOOS, runtime.GOARCH, dir)
	if err != nil {
		return err
	}
	if o.Archive != "" {
		defer os.Remove(o.Archive)
	}
	switch {
	case o.Version == version:
		fmt.Printf("Up to date: %s (server %s)\n", version, server)
		if !*force {
			return nil
		}
	case update.Newer(version, o.Version) && !*force:
		fmt.Printf("This program (%s) is newer than the server's package (%s). Update the server, or use --force to install the server's version.\n", version, o.Version)
		return nil
	}
	if *check {
		fmt.Printf("New version available: %s (you have %s). Run `%s update`.\n", o.Version, version, progName())
		return nil
	}
	if err := update.Apply(o, exe); err != nil {
		return err
	}
	fmt.Printf("Updated %s → %s (the old one is kept as %s.prev)\n", version, o.Version, exe)
	switch installed, err := restartService(exe, invoked); {
	case err != nil:
		fmt.Println("The background service could not be restarted:", err, "— run `"+progName()+" service uninstall && "+progName()+" service install`")
	case installed:
		fmt.Println("The background service was restarted.")
	default:
		fmt.Printf("If `%s run` is going in a terminal, stop it and start it again.\n", progName())
	}
	return nil
}
