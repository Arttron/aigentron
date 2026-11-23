package repo

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
)

// File is one changed path in a status.
type File struct {
	Path string `json:"path"`
	XY   string `json:"xy"` // git's two-letter state: "M." staged edit, ".M" unstaged edit, "??" untracked, "UU" conflicted …
}

// Status is the state of a repository, as the dashboard and the agents see it.
type Status struct {
	ID         string `json:"id"`
	Path       string `json:"path"`
	Branch     string `json:"branch"`
	Detached   bool   `json:"detached"`
	Head       string `json:"head"`
	Upstream   string `json:"upstream,omitempty"`
	Ahead      int    `json:"ahead"`
	Behind     int    `json:"behind"`
	Staged     int    `json:"staged"`
	Unstaged   int    `json:"unstaged"`
	Untracked  int    `json:"untracked"`
	Conflicted int    `json:"conflicted"`
	// State is "" or what is in progress: merge · rebase · cherry-pick · revert · bisect
	State    string `json:"state,omitempty"`
	Origin   string `json:"origin,omitempty"`
	Files    []File `json:"files"`
	FilesCut bool   `json:"filesCut,omitempty"`
	Error    string `json:"error,omitempty"`
}

const maxFiles = 200

// StripCredentials removes a login / token from a remote URL (https://user:token@host/x → https://host/x); an scp-style address has none.
func StripCredentials(raw string) string {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		if at := strings.Index(raw, "@"); at >= 0 && !strings.Contains(raw[:at], "/") && strings.Contains(raw[at:], ":") {
			return raw // git@github.com:org/repo.git — a user name, no secret
		}
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	u.User = nil
	return u.String()
}

func inProgress(gitDir string) string {
	for name, state := range map[string]string{"MERGE_HEAD": "merge", "rebase-merge": "rebase", "rebase-apply": "rebase", "CHERRY_PICK_HEAD": "cherry-pick", "REVERT_HEAD": "revert", "BISECT_LOG": "bisect"} {
		if _, err := os.Stat(filepath.Join(gitDir, name)); err == nil {
			return state
		}
	}
	return ""
}

// ReadStatus reads the state of one repository.
func ReadStatus(ctx context.Context, root policy.Root) Status {
	st := Status{ID: root.ID, Path: root.Path, Files: []File{}}
	res, err := Git(ctx, root.Path, "status", "--porcelain=v2", "-b", "--untracked-files=normal")
	if err != nil {
		st.Error = err.Error()
		return st
	}
	for _, line := range strings.Split(res.Out, "\n") {
		switch {
		case strings.HasPrefix(line, "# branch.oid "):
			if oid := strings.TrimPrefix(line, "# branch.oid "); len(oid) >= 7 {
				st.Head = oid[:7]
			}
		case strings.HasPrefix(line, "# branch.head "):
			st.Branch = strings.TrimPrefix(line, "# branch.head ")
			if st.Branch == "(detached)" {
				st.Detached, st.Branch = true, ""
			}
		case strings.HasPrefix(line, "# branch.upstream "):
			st.Upstream = strings.TrimPrefix(line, "# branch.upstream ")
		case strings.HasPrefix(line, "# branch.ab "):
			var a, b int
			if _, err := fmt.Sscanf(strings.TrimPrefix(line, "# branch.ab "), "+%d -%d", &a, &b); err == nil {
				st.Ahead, st.Behind = a, b
			}
		case strings.HasPrefix(line, "1 ") || strings.HasPrefix(line, "2 "):
			f := strings.SplitN(line, " ", 9)
			if len(f) < 9 {
				continue
			}
			xy := f[1]
			if xy[0] != '.' {
				st.Staged++
			}
			if xy[1] != '.' {
				st.Unstaged++
			}
			p := f[8]
			if f[0] == "2" { // a rename: "<new>\t<old>"
				p, _, _ = strings.Cut(p, "\t")
			}
			st.addFile(p, xy)
		case strings.HasPrefix(line, "u "):
			f := strings.SplitN(line, " ", 11)
			st.Conflicted++
			if len(f) >= 11 {
				st.addFile(f[10], f[1])
			}
		case strings.HasPrefix(line, "? "):
			st.Untracked++
			st.addFile(strings.TrimPrefix(line, "? "), "??")
		}
	}
	if gd, err := Git(ctx, root.Path, "rev-parse", "--absolute-git-dir"); err == nil {
		st.State = inProgress(strings.TrimSpace(gd.Out))
	}
	if o, err := Git(ctx, root.Path, "remote", "get-url", "origin"); err == nil {
		st.Origin = StripCredentials(o.Out)
	}
	return st
}

func (s *Status) addFile(p, xy string) {
	if len(s.Files) >= maxFiles {
		s.FilesCut = true
		return
	}
	s.Files = append(s.Files, File{Path: p, XY: xy})
}

// Commit is one line of the log.
type Commit struct {
	Hash    string `json:"hash"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Subject string `json:"subject"`
}

// ReadLog returns the latest commits (optionally of one path), at most 50.
func ReadLog(ctx context.Context, root policy.Root, limit int, rel string) ([]Commit, error) {
	if limit < 1 || limit > 50 {
		limit = 20
	}
	args := []string{"log", "-n", strconv.Itoa(limit), "--date=iso-strict", "--pretty=format:%H%x1f%an%x1f%ad%x1f%s"}
	if rel != "" {
		if _, err := policy.Resolve(root.Path, rel); err != nil {
			// a deleted file has no path any more, but its history may still be asked for: only the never-list and escapes are refused then
			if why := policy.NeverReason(rel); why != "" || strings.Contains(rel, "..") || filepath.IsAbs(rel) {
				return nil, err
			}
		}
		args = append(args, "--", ":(literal)"+filepath.ToSlash(rel))
	}
	res, err := Git(ctx, root.Path, args...)
	if err != nil {
		if strings.Contains(err.Error(), "does not have any commits") {
			return []Commit{}, nil
		}
		return nil, err
	}
	out := []Commit{}
	for _, line := range strings.Split(res.Out, "\n") {
		f := strings.Split(line, "\x1f")
		if len(f) == 4 {
			out = append(out, Commit{Hash: f[0], Author: f[1], Date: f[2], Subject: f[3]})
		}
	}
	return out, nil
}

// ReadDiff returns the diff of the working tree (or the index with staged=true), never including the never-list.
func ReadDiff(ctx context.Context, root policy.Root, rel string, staged bool) (Result, error) {
	args := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U3"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--")
	if rel != "" {
		if _, err := policy.Resolve(root.Path, rel); err != nil {
			if why := policy.NeverReason(rel); why != "" || strings.Contains(rel, "..") || filepath.IsAbs(rel) {
				return Result{}, err
			}
		}
		args = append(args, ":(literal)"+filepath.ToSlash(rel))
	} else {
		args = append(args, ".")
	}
	args = append(args, policy.DiffExcludes()...)
	return Git(ctx, root.Path, args...)
}

const (
	maxRead     = 64 * 1024
	maxReadFile = 8 * 1024 * 1024
	binarySniff = 8192
)

// FileChunk is a piece of a file.
type FileChunk struct {
	Path   string `json:"path"`
	Text   string `json:"text"`
	Offset int    `json:"offset"`
	Size   int64  `json:"size"`
	More   bool   `json:"more"`
}

// ReadFile reads (a part of) a text file inside the repository: never-list refused, links resolved and re-checked, binary files refused, 64 KB at a time.
func ReadFile(root policy.Root, rel string, offset, limit int) (FileChunk, error) {
	abs, err := policy.Resolve(root.Path, rel)
	if err != nil {
		return FileChunk{}, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return FileChunk{}, err
	}
	if !st.Mode().IsRegular() {
		return FileChunk{}, errors.New("not a regular file")
	}
	if st.Size() > maxReadFile {
		return FileChunk{}, fmt.Errorf("the file is %d MB — too large to read", st.Size()>>20)
	}
	if limit < 1 || limit > maxRead {
		limit = maxRead
	}
	if offset < 0 {
		offset = 0
	}
	f, err := os.Open(abs)
	if err != nil {
		return FileChunk{}, err
	}
	defer f.Close()
	head := make([]byte, binarySniff)
	n, _ := f.Read(head)
	if strings.IndexByte(string(head[:n]), 0) >= 0 {
		return FileChunk{}, errors.New("a binary file")
	}
	buf := make([]byte, limit)
	m, _ := f.ReadAt(buf, int64(offset))
	text := strings.ToValidUTF8(string(buf[:m]), "�")
	return FileChunk{Path: filepath.ToSlash(rel), Text: text, Offset: offset, Size: st.Size(), More: int64(offset+m) < st.Size()}, nil
}
