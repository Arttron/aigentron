// Package policy holds the hard limits of the local agent. They are NOT settings: neither the server, nor a repository's file, nor a model can change them.
//
//   - roots: only repositories the person added on this machine (`aigentron add`) are ever touched;
//   - every path an agent names is resolved (symlinks included) and must stay inside its root;
//   - a never-list of secrets (.env, keys, credentials, .git, .ssh …) is refused for reading and left out of every diff.
package policy

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// neverDirs are directory names that are never read, wherever they are in a repository.
var neverDirs = []string{".git", ".ssh", ".gnupg", ".aws", ".kube", ".docker", ".azure", ".config/gcloud"}

// neverNames are file-name patterns (path.Match, on the base name) that are never read.
var neverNames = []string{".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.kdbx", "*.keystore", "*.jks", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd"}

// allowedExamples are .env look-alikes that hold no secret by convention.
var allowedExamples = map[string]bool{".env.example": true, ".env.sample": true, ".env.template": true, ".env.dist": true, ".env.defaults": true}

// NeverReason says why a path (relative to its root, slash-separated) is refused, or "" when it may be read.
func NeverReason(rel string) string {
	rel = path.Clean(filepath.ToSlash(rel))
	parts := strings.Split(rel, "/")
	for i := range parts {
		for _, d := range neverDirs {
			dp := strings.Split(d, "/")
			if i+len(dp) <= len(parts) && strings.Join(parts[i:i+len(dp)], "/") == d {
				return fmt.Sprintf("%s is never read (it can hold credentials)", d)
			}
		}
	}
	base := parts[len(parts)-1]
	if allowedExamples[base] {
		return ""
	}
	for _, pat := range neverNames {
		if ok, _ := path.Match(pat, base); ok {
			return fmt.Sprintf("%s is on the never-read list (a secret or key file)", base)
		}
	}
	return ""
}

// DiffExcludes are git pathspecs that keep the never-list out of a diff (git would otherwise print the contents of a changed .env).
func DiffExcludes() []string {
	var out []string
	for _, d := range neverDirs {
		out = append(out, ":(exclude,glob)**/"+d+"/**")
	}
	for _, n := range neverNames {
		out = append(out, ":(exclude,glob)**/"+n)
	}
	return out
}

// Resolve turns a path an agent named (relative to the root) into a real absolute path that is inside the root and not on the never-list.
// The target must exist (it is for reading). Symlinks are followed and re-checked: a link inside the repository that points out of it is refused.
func Resolve(root, rel string) (string, error) {
	if rel == "" || rel == "." {
		return root, nil
	}
	if filepath.IsAbs(rel) || strings.ContainsRune(rel, 0) {
		return "", errors.New("the path must be relative to the repository")
	}
	clean := path.Clean(filepath.ToSlash(rel))
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", errors.New("the path leaves the repository")
	}
	if why := NeverReason(clean); why != "" {
		return "", errors.New(why)
	}
	abs, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(clean)))
	if err != nil {
		return "", fmt.Errorf("no such path: %s", clean)
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	if abs != rootReal && !strings.HasPrefix(abs, rootReal+string(filepath.Separator)) {
		return "", errors.New("the path points outside the repository")
	}
	// the real target (after links) must not be a secret either
	if r, err := filepath.Rel(rootReal, abs); err == nil {
		if why := NeverReason(r); why != "" {
			return "", errors.New(why)
		}
	}
	return abs, nil
}

// CheckRoot refuses folders that must never be a root: the filesystem root, the home folder or anything above it, and the secret folders.
func CheckRoot(p string) error {
	if !filepath.IsAbs(p) {
		return errors.New("the path must be absolute")
	}
	if filepath.Dir(p) == p {
		return errors.New("the filesystem root cannot be a repository root")
	}
	if home, err := os.UserHomeDir(); err == nil {
		homeReal, _ := filepath.EvalSymlinks(home)
		for _, h := range []string{home, homeReal} {
			if h == "" {
				continue
			}
			if p == h || strings.HasPrefix(h, p+string(filepath.Separator)) {
				return errors.New("your home folder (or a folder above it) cannot be a root — add the repository itself")
			}
		}
	}
	for _, seg := range strings.Split(filepath.ToSlash(p), "/") {
		for _, d := range neverDirs {
			if seg == d {
				return fmt.Errorf("%s cannot be inside a root", d)
			}
		}
	}
	return nil
}
