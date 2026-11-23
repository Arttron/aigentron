// Package workspace is "open a project here": fetch a project's repository onto this computer (or recognise a copy that is already here), after checking everything
// the server told us. The server is trusted to NAME the project, not to be able to run anything: the address is validated here, the clone runs with git's
// program-launching features switched off, and the folder is checked before and after.
package workspace

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var scpLike = regexp.MustCompile(`^([A-Za-z0-9_.-]+@)?([A-Za-z0-9.-]+):([^/].*|/.*)$`)

// CheckRepoURL accepts only what a person's own git clones over the network: https / ssh / git URLs and `user@host:path`. A local path, file:, ext:: (runs a
// command), an address that looks like an option, one with a password, or with control characters is refused.
func CheckRepoURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	switch {
	case s == "":
		return "", errors.New("the project has no repository address")
	case strings.HasPrefix(s, "-"):
		return "", errors.New("the repository address looks like an option")
	case strings.ContainsAny(s, " \t\r\n\x00\\") || strings.Contains(s, "::"):
		return "", errors.New("the repository address has characters a clone address never has")
	}
	if !strings.Contains(s, "://") {
		if m := scpLike.FindStringSubmatch(s); m != nil && !strings.HasPrefix(s, "/") && !strings.HasPrefix(s, ".") {
			return s, nil // git@github.com:acme/shop.git
		}
		return "", errors.New("the repository address must be https://, ssh:// or git@host:owner/repo.git (not a local path)")
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || u.Hostname() == "" {
		return "", errors.New("the repository address cannot be read")
	}
	switch strings.ToLower(u.Scheme) {
	case "https", "ssh", "git", "git+ssh", "http":
	default:
		return "", fmt.Errorf("a %s: repository address is not allowed", u.Scheme)
	}
	if _, has := u.User.Password(); has {
		return "", errors.New("the repository address contains a password — fix it on the server (Projects → repository); the clone uses your own git login")
	}
	return s, nil
}

// Normalize makes two spellings of one remote comparable (https://Host/Owner/Repo.git == git@host:owner/repo): the same rule as the server's sameRemote.
func Normalize(raw string) string {
	s := strings.TrimSpace(raw)
	if m := scpLike.FindStringSubmatch(s); m != nil && !strings.Contains(s, "://") {
		s = "ssh://" + m[2] + "/" + strings.TrimPrefix(m[3], "/")
	}
	u, err := url.Parse(s)
	if err != nil || u.Hostname() == "" {
		return ""
	}
	p := strings.TrimSuffix(strings.TrimRight(u.Path, "/"), ".git")
	return strings.ToLower(u.Hostname() + p)
}

var slugRe = regexp.MustCompile(`[^a-z0-9._-]+`)

// FolderName is a safe folder name for a project.
func FolderName(slugOrName string) string {
	s := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(slugOrName), "-"), "-.")
	if s == "" {
		return "project"
	}
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}

// Dest is what a destination folder is like.
type Dest int

const (
	DestFree   Dest = iota // does not exist (its parent does)
	DestEmpty              // an empty folder
	DestExists             // has files: maybe the project already
)

// CheckDest looks at a destination before anything is written.
func CheckDest(dest string) (Dest, error) {
	abs, err := filepath.Abs(dest)
	if err != nil {
		return 0, err
	}
	fi, err := os.Lstat(abs)
	if errors.Is(err, os.ErrNotExist) {
		parent, perr := os.Stat(filepath.Dir(abs))
		if perr != nil || !parent.IsDir() {
			return 0, fmt.Errorf("the folder %s does not exist", filepath.Dir(abs))
		}
		return DestFree, nil
	}
	if err != nil {
		return 0, err
	}
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return 0, fmt.Errorf("%s exists and is not a plain folder", abs)
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return 0, err
	}
	if len(entries) == 0 {
		return DestEmpty, nil
	}
	return DestExists, nil
}

// OriginOf is the `origin` of a repository in dir ("" when there is none).
func OriginOf(ctx context.Context, dir string) string {
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "remote", "get-url", "origin").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// TopOf is the top folder of the git repository that contains dir ("" when it is not in one).
func TopOf(ctx context.Context, dir string) string {
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return ""
	}
	top, err := filepath.EvalSymlinks(strings.TrimSpace(string(out)))
	if err != nil {
		return ""
	}
	return top
}

// Clone runs `git clone` of a checked address into dest. The person's own git login (ssh agent, credential helper, an https prompt) is used, so stdio is passed
// through. `allowFile` is for tests only.
func Clone(ctx context.Context, repoURL, dest, branch string, stdio [3]*os.File, allowFile bool) error {
	args := []string{
		"-c", "protocol.ext.allow=never",
		"-c", "core.hooksPath=/dev/null",
		"-c", "core.fsmonitor=false",
	}
	if !allowFile {
		args = append(args, "-c", "protocol.file.allow=never")
	}
	args = append(args, "clone", "--no-recurse-submodules")
	if branch != "" && !strings.HasPrefix(branch, "-") && !strings.ContainsAny(branch, " \t\r\n\x00") {
		args = append(args, "--branch", branch)
	}
	args = append(args, "--", repoURL, dest)
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdio[0], stdio[1], stdio[2]
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git clone failed: %v", err)
	}
	return nil
}
