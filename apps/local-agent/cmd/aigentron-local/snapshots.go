package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"path/filepath"

	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
	"github.com/Arttron/aigentron/apps/local-agent/internal/repo"
)

// rootArg finds an allowed repository by id or path.
func rootArg(arg string) (policy.Root, error) {
	roots, err := policy.LoadRoots()
	if err != nil {
		return policy.Root{}, err
	}
	if r, ok := policy.Find(roots, arg); ok {
		return r, nil
	}
	abs, err := filepath.Abs(arg)
	if err == nil {
		if real, err := filepath.EvalSymlinks(abs); err == nil {
			abs = real
		}
		for _, r := range roots {
			if r.Path == abs {
				return r, nil
			}
		}
	}
	return policy.Root{}, fmt.Errorf("%q is not an allowed repository (see: aigentron roots)", arg)
}

func cmdSnapshots(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: aigentron snapshots <id|path>")
	}
	root, err := rootArg(args[0])
	if err != nil {
		return err
	}
	ctx := context.Background()
	st := repo.ReadStatus(ctx, root)
	list, err := repo.ListWIP(ctx, root, st.Branch)
	if err != nil {
		return err
	}
	if len(list) == 0 {
		fmt.Printf("No snapshots of branch %q yet. The program keeps one when you have unsaved changes and have not touched them for a while (rules: snapshot).\n", st.Branch)
		return nil
	}
	for _, w := range list {
		fmt.Printf("%s  %s\n", w.Commit[:12], w.Time)
	}
	fmt.Println("Restore one with: aigentron restore", args[0], "<snapshot>")
	return nil
}

func cmdRestore(args []string) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	force := fs.Bool("force", false, "overwrite uncommitted changes (they are saved as a snapshot first)")
	// flags may come after the positional arguments
	var pos []string
	rest := args
	for len(rest) > 0 {
		if err := fs.Parse(rest); err != nil {
			return err
		}
		if fs.NArg() == 0 {
			break
		}
		pos = append(pos, fs.Arg(0))
		rest = fs.Args()[1:]
	}
	if len(pos) != 2 {
		return errors.New("usage: aigentron restore <id|path> <snapshot> [--force]")
	}
	root, err := rootArg(pos[0])
	if err != nil {
		return err
	}
	ctx := context.Background()
	st := repo.ReadStatus(ctx, root)
	list, err := repo.ListWIP(ctx, root, st.Branch)
	if err != nil {
		return err
	}
	var full string
	for _, w := range list {
		if len(pos[1]) >= 7 && len(pos[1]) <= len(w.Commit) && w.Commit[:len(pos[1])] == pos[1] {
			if full != "" {
				return errors.New("that prefix matches more than one snapshot: type more of it")
			}
			full = w.Commit
		}
	}
	if full == "" {
		return errors.New("no such snapshot on this branch (see: aigentron snapshots)")
	}
	if err := repo.RestoreWIP(ctx, root, full, *force); err != nil {
		return err
	}
	fmt.Println("Restored. Files that were not in the snapshot were left as they are.")
	return nil
}
