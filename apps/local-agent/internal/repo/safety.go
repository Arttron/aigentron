package repo

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
)

// The safety net (L2): what the daemon may do to a repository on its own. Nothing here changes the person's branch, index or working tree except
// FastForward, which only moves a clean branch forward to its own upstream; the snapshot is a commit object under refs/aigentron/wip/ and nothing else.

const wipPrefix = "refs/aigentron/wip/"

// Busy says why the daemon must leave the repository alone right now ("" = free): git's own lock is held, or a merge / rebase / cherry-pick /
// bisect is in progress.
func Busy(st Status) string {
	if st.State != "" {
		return st.State + " in progress"
	}
	if st.Error != "" {
		return st.Error
	}
	if gd, err := os.Stat(filepath.Join(gitDirOf(st.Path), "index.lock")); err == nil && !gd.IsDir() {
		return "git is working (index.lock)"
	}
	return ""
}

func gitDirOf(root string) string {
	// a plain repository; a worktree's or submodule's `.git` file is followed
	g := filepath.Join(root, ".git")
	if st, err := os.Stat(g); err == nil && !st.IsDir() {
		if b, err := os.ReadFile(g); err == nil {
			if d, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir: "); ok {
				if !filepath.IsAbs(d) {
					d = filepath.Join(root, d)
				}
				return d
			}
		}
	}
	return g
}

// Dirty is the number of changed or new paths.
func Dirty(st Status) int { return st.Staged + st.Unstaged + st.Untracked + st.Conflicted }

// LastTouched is the newest modification time among the changed files (zero when nothing is changed): "the person edited something a moment ago".
func LastTouched(st Status) time.Time {
	var newest time.Time
	for _, f := range st.Files {
		if fi, err := os.Lstat(filepath.Join(st.Path, filepath.FromSlash(f.Path))); err == nil && fi.ModTime().After(newest) {
			newest = fi.ModTime()
		}
	}
	return newest
}

func identity() []string {
	return []string{"GIT_AUTHOR_NAME=Aigentron", "GIT_AUTHOR_EMAIL=aigentron@localhost", "GIT_COMMITTER_NAME=Aigentron", "GIT_COMMITTER_EMAIL=aigentron@localhost"}
}

// Snapshot is one saved state of the working tree.
type WIP struct {
	Ref    string `json:"ref"`
	Commit string `json:"commit"`
	Time   string `json:"time"`
	Branch string `json:"branch"`
}

// SaveWIP stores the whole working tree (changed and new files, minus what .gitignore, the never-list and `ignore` leave out) as a commit under
// refs/aigentron/wip/<branch>/<n>, without touching the branch, the real index or any file. It returns "" when nothing changed since the last snapshot.
// keep is how many snapshots of this branch are kept.
func SaveWIP(ctx context.Context, root policy.Root, branch string, ignore []string, keep int) (string, error) {
	if branch == "" {
		branch = "detached"
	}
	// a filter in the repository's OWN config would run a program when files are added: refuse (the person's global filters, e.g. git-lfs, are theirs)
	if r, err := Git(ctx, root.Path, "config", "--local", "--name-only", "--get-regexp", `^filter\..*\.(clean|smudge|process)$`); err == nil && strings.TrimSpace(r.Out) != "" {
		return "", errors.New("the repository's own git config defines a filter; snapshots are off for it")
	}
	if _, err := Git(ctx, root.Path, "rev-parse", "--verify", "-q", "HEAD"); err != nil {
		return "", errors.New("no commit yet")
	}
	dir, err := os.MkdirTemp("", "aigentron-idx-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	env := append(identity(), "GIT_INDEX_FILE="+filepath.Join(dir, "index"))
	o := runOpts{timeout: 60 * time.Second, env: env}
	if _, err := run(ctx, root.Path, o, "read-tree", "HEAD"); err != nil {
		return "", err
	}
	spec := []string{"add", "-A", "--", "."}
	spec = append(spec, policy.DiffExcludes()...)
	for _, p := range ignore {
		spec = append(spec, ":(exclude,glob)"+p)
	}
	if _, err := run(ctx, root.Path, o, spec...); err != nil {
		return "", err
	}
	tree, err := run(ctx, root.Path, o, "write-tree")
	if err != nil {
		return "", err
	}
	treeSha := strings.TrimSpace(tree.Out)
	if head, err := Git(ctx, root.Path, "rev-parse", "HEAD^{tree}"); err == nil && strings.TrimSpace(head.Out) == treeSha {
		return "", nil // the same as the last commit: nothing to keep
	}
	list, err := ListWIP(ctx, root, branch)
	if err != nil {
		return "", err
	}
	if len(list) > 0 {
		if last, err := Git(ctx, root.Path, "rev-parse", list[0].Commit+"^{tree}"); err == nil && strings.TrimSpace(last.Out) == treeSha {
			return "", nil // the same as the last snapshot
		}
	}
	c, err := run(ctx, root.Path, runOpts{env: identity()}, "commit-tree", treeSha, "-p", "HEAD", "-m", "aigentron: work in progress on "+branch)
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(c.Out)
	ref := wipPrefix + branch + "/" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if _, err := Git(ctx, root.Path, "update-ref", ref, sha); err != nil {
		return "", err
	}
	if keep > 0 {
		if all, err := ListWIP(ctx, root, branch); err == nil {
			for i := keep; i < len(all); i++ {
				_, _ = Git(ctx, root.Path, "update-ref", "-d", all[i].Ref)
			}
		}
	}
	return sha, nil
}

// ListWIP lists the snapshots of a branch, newest first.
func ListWIP(ctx context.Context, root policy.Root, branch string) ([]WIP, error) {
	if branch == "" {
		branch = "detached"
	}
	r, err := Git(ctx, root.Path, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)", wipPrefix+branch+"/")
	if err != nil {
		return nil, err
	}
	var out []WIP
	for _, line := range strings.Split(r.Out, "\n") {
		f := strings.Split(line, "\t")
		if len(f) != 3 {
			continue
		}
		rest := strings.TrimPrefix(f[0], wipPrefix+branch+"/")
		if _, err := strconv.ParseInt(rest, 10, 64); err != nil {
			continue // another branch whose name starts with this one's
		}
		out = append(out, WIP{Ref: f[0], Commit: f[1], Time: f[2], Branch: branch})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ref > out[j].Ref })
	return out, nil
}

// RestoreWIP puts the files of a snapshot back into the working tree (files that are not in the snapshot are left alone). Unless force, it refuses when
// the tree has uncommitted changes, because they would be overwritten — take a snapshot first, or pass force.
func RestoreWIP(ctx context.Context, root policy.Root, commit string, force bool) error {
	if !isHex(commit) {
		return errors.New("a snapshot is named by its commit id")
	}
	st := ReadStatus(ctx, root)
	if why := Busy(st); why != "" {
		return fmt.Errorf("not now: %s", why)
	}
	if !force && Dirty(st) > 0 {
		return errors.New("the working tree has changes that a restore would overwrite; run again with --force (a snapshot of them is taken first)")
	}
	if Dirty(st) > 0 {
		if _, err := SaveWIP(ctx, root, st.Branch, nil, 0); err != nil {
			return fmt.Errorf("could not save the current state first: %w", err)
		}
	}
	if r, err := Git(ctx, root.Path, "for-each-ref", "--format=%(objectname)", wipPrefix); err != nil || !containsLine(r.Out, commit) {
		return errors.New("that is not one of this repository's snapshots")
	}
	_, err := Git(ctx, root.Path, "restore", "--source="+commit, "--worktree", "--", ".")
	return err
}

func isHex(s string) bool {
	if len(s) < 7 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}

func containsLine(out, sha string) bool {
	for _, l := range strings.Split(out, "\n") {
		if l != "" && strings.HasPrefix(l, sha) {
			return true
		}
	}
	return false
}

// netOpts is for the calls that talk to the remote: the person's own ssh and its agent are used (the read-only calls cannot), while everything in
// the repository's config that could run a program is overridden on the command line (a `-c` beats the config file).
func netOpts() runOpts {
	ssh := "ssh -o BatchMode=yes -o ConnectTimeout=15"
	if p, err := exec.LookPath("ssh"); err != nil || p == "" {
		ssh = "/bin/false"
	}
	return runOpts{
		timeout: 90 * time.Second,
		env:     []string{"GIT_SSH_COMMAND=" + ssh, "GIT_ASKPASS=/bin/false"},
		extra:   []string{"-c", "core.sshCommand=", "-c", "core.gitProxy=", "-c", "core.askPass=", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.recurseSubmodules=false"},
	}
}

// Fetch updates the remote-tracking branches (never `pull`: no branch, index or file changes).
func Fetch(ctx context.Context, root policy.Root) error {
	_, err := run(ctx, root.Path, netOpts(), "fetch", "--prune", "--no-tags", "--no-recurse-submodules", "--upload-pack=git-upload-pack", "--quiet")
	return err
}

// FastForward moves the current branch to its upstream when that is a pure fast-forward and the tree is clean. Anything else is refused with the reason.
func FastForward(ctx context.Context, root policy.Root) (bool, error) {
	st := ReadStatus(ctx, root)
	switch {
	case Busy(st) != "":
		return false, errors.New(Busy(st))
	case st.Detached || st.Branch == "":
		return false, errors.New("a detached HEAD")
	case st.Upstream == "":
		return false, errors.New("the branch has no upstream")
	case st.Staged+st.Unstaged+st.Conflicted > 0:
		return false, errors.New("the tree has uncommitted changes")
	case st.Ahead > 0:
		return false, errors.New("the branch has local commits the upstream lacks")
	case st.Behind == 0:
		return false, nil
	}
	if _, err := Git(ctx, root.Path, "merge", "--ff-only", "--no-edit", "--no-verify", "@{upstream}"); err != nil {
		return false, err
	}
	return true, nil
}
