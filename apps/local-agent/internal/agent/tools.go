package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/Arttron/aigentron/apps/local-agent/internal/policy"
	"github.com/Arttron/aigentron/apps/local-agent/internal/repo"
)

const maxList = 400

func parse[T any](args json.RawMessage) (T, error) {
	var v T
	if err := json.Unmarshal(args, &v); err != nil {
		return v, errors.New("bad arguments: " + err.Error())
	}
	return v, nil
}

// keep drops the never-list from a list of repository paths.
func keep(lines []string) []string {
	out := lines[:0:0]
	for _, l := range lines {
		if l != "" && policy.NeverReason(l) == "" {
			out = append(out, l)
		}
	}
	return out
}

// writable resolves a path for writing: its folder must exist inside the root (links resolved), the name must not be on the never-list, and an existing target
// must not be a link out. It returns the absolute path.
func writable(root policy.Root, rel string) (string, error) {
	clean := path.Clean(filepath.ToSlash(rel))
	if rel == "" || clean == "." || filepath.IsAbs(rel) || strings.HasPrefix(clean, "../") || clean == ".." || strings.ContainsRune(rel, 0) {
		return "", errors.New("the path must be a file inside the repository")
	}
	if why := policy.NeverReason(clean); why != "" {
		return "", errors.New(why)
	}
	if clean == ".git" || strings.HasPrefix(clean, ".git/") || strings.Contains(clean, "/.git/") {
		return "", errors.New(".git is never written")
	}
	dir, err := policy.Resolve(root.Path, path.Dir(clean))
	if err != nil {
		return "", fmt.Errorf("the folder does not exist inside the repository: %s", path.Dir(clean))
	}
	abs := filepath.Join(dir, path.Base(clean))
	if fi, err := os.Lstat(abs); err == nil {
		if fi.Mode()&os.ModeSymlink != 0 || !fi.Mode().IsRegular() {
			return "", errors.New("only a regular file can be written")
		}
	}
	return abs, nil
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func tools(root policy.Root) []Tool {
	read := []Tool{
		{
			Name: "list_files", Description: "List the files of the repository (tracked and new, never secrets). `path` limits to a folder.",
			Schema: `{"type":"object","properties":{"path":{"type":"string"}}}`,
			Run: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, err := parse[struct{ Path string }](a)
				if err != nil {
					return "", err
				}
				args := []string{"ls-files", "--cached", "--others", "--exclude-standard", "-z"}
				if v.Path != "" {
					if _, err := policy.Resolve(root.Path, v.Path); err != nil {
						return "", err
					}
					args = append(args, "--", ":(literal)"+filepath.ToSlash(v.Path))
				}
				r, err := repo.Git(ctx, root.Path, args...)
				if err != nil {
					return "", err
				}
				all := strings.Split(r.Out, "\x00")
				files := keep(all)
				note := ""
				if hidden := len(strings.Split(strings.TrimRight(r.Out, "\x00"), "\x00")) - len(files); hidden > 0 {
					note = fmt.Sprintf("\n[%d secret file(s) such as .env exist but are not available to you]", hidden)
				}
				if len(files) > maxList {
					note += fmt.Sprintf("\n[… %d more: narrow it with `path`]", len(files)-maxList)
					files = files[:maxList]
				}
				return strings.Join(files, "\n") + note, nil
			},
		},
		{
			Name: "search", Description: "Search the repository's text files for a fixed string (git grep). Returns file:line: text.",
			Schema: `{"type":"object","properties":{"query":{"type":"string"},"path":{"type":"string"}},"required":["query"]}`,
			Run: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, err := parse[struct{ Query, Path string }](a)
				if err != nil || strings.TrimSpace(v.Query) == "" {
					return "", errors.New("query is required")
				}
				args := []string{"grep", "--untracked", "-n", "-I", "-F", "-e", v.Query}
				if v.Path != "" {
					if _, err := policy.Resolve(root.Path, v.Path); err != nil {
						return "", err
					}
					args = append(args, "--", ":(literal)"+filepath.ToSlash(v.Path))
				}
				r, err := repo.Git(ctx, root.Path, args...)
				if err != nil {
					if strings.Contains(err.Error(), "exit status 1") || strings.HasSuffix(err.Error(), ": exit status 1") {
						return "no matches", nil
					}
					return "", err
				}
				var out []string
				for _, l := range strings.Split(r.Out, "\n") {
					if f, _, ok := strings.Cut(l, ":"); ok && policy.NeverReason(f) == "" {
						out = append(out, clip(l, 300))
					}
				}
				if len(out) == 0 {
					return "no matches", nil
				}
				if len(out) > 100 {
					out = append(out[:100], "[… more matches: narrow the search]")
				}
				return strings.Join(out, "\n"), nil
			},
		},
		{
			Name: "read_file", Description: "Read a text file of the repository (64 KB at a time; pass `offset` to continue).",
			Schema: `{"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer"}},"required":["path"]}`,
			Run: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, err := parse[struct {
					Path   string
					Offset int
				}](a)
				if err != nil {
					return "", err
				}
				c, err := repo.ReadFile(root, v.Path, v.Offset, 0)
				if err != nil {
					return "", err
				}
				if c.More {
					return c.Text + fmt.Sprintf("\n[… the file continues (%d bytes): read_file with offset=%d]", c.Size, c.Offset+len(c.Text)), nil
				}
				return c.Text, nil
			},
		},
		{
			Name: "git_status", Description: "Branch, upstream, and changed files.",
			Schema: `{"type":"object","properties":{}}`,
			Run: func(ctx context.Context, a json.RawMessage) (string, error) {
				s := repo.ReadStatus(ctx, root)
				if s.Error != "" {
					return "", errors.New(s.Error)
				}
				b, _ := json.MarshalIndent(s, "", " ")
				return string(b), nil
			},
		},
		{
			Name: "git_diff", Description: "The uncommitted changes (a unified diff); `staged` for the index. Secret files are left out.",
			Schema: `{"type":"object","properties":{"path":{"type":"string"},"staged":{"type":"boolean"}}}`,
			Run: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, err := parse[struct {
					Path   string
					Staged bool
				}](a)
				if err != nil {
					return "", err
				}
				r, err := repo.ReadDiff(ctx, root, v.Path, v.Staged)
				if err != nil {
					return "", err
				}
				if strings.TrimSpace(r.Out) == "" {
					return "no changes", nil
				}
				return r.Out, nil
			},
		},
		{
			Name: "git_log", Description: "The latest commits (at most 50), optionally of one path.",
			Schema: `{"type":"object","properties":{"limit":{"type":"integer"},"path":{"type":"string"}}}`,
			Run: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, err := parse[struct {
					Limit int
					Path  string
				}](a)
				if err != nil {
					return "", err
				}
				cs, err := repo.ReadLog(ctx, root, v.Limit, v.Path)
				if err != nil {
					return "", err
				}
				var out []string
				for _, c := range cs {
					out = append(out, fmt.Sprintf("%s %s %s: %s", c.Hash[:min(10, len(c.Hash))], c.Date[:min(10, len(c.Date))], c.Author, c.Subject))
				}
				return strings.Join(out, "\n"), nil
			},
		},
	}

	write := []Tool{
		{
			Name: "edit_file", Description: "Replace an exact text in a file. `old` must occur exactly once. The person approves it first.",
			Schema: `{"type":"object","properties":{"path":{"type":"string"},"old":{"type":"string"},"new":{"type":"string"}},"required":["path","old","new"]}`,
			Describe: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, abs, err := editTarget(root, a)
				if err != nil {
					return "", err
				}
				_ = abs
				return fmt.Sprintf("Edit %s\n--- remove\n%s\n+++ add\n%s", v.Path, clip(v.Old, 1500), clip(v.New, 1500)), nil
			},
			Run: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, abs, err := editTarget(root, a)
				if err != nil {
					return "", err
				}
				b, _ := os.ReadFile(abs)
				if err := os.WriteFile(abs, []byte(strings.Replace(string(b), v.Old, v.New, 1)), 0o644); err != nil {
					return "", err
				}
				return "edited " + v.Path, nil
			},
		},
		{
			Name: "write_file", Description: "Create a new file (an existing file is NOT overwritten: use edit_file). The person approves it first.",
			Schema: `{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}`,
			Describe: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, _, err := newFileTarget(root, a)
				if err != nil {
					return "", err
				}
				return fmt.Sprintf("Create %s (%d bytes)\n%s", v.Path, len(v.Content), clip(v.Content, 1500)), nil
			},
			Run: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, abs, err := newFileTarget(root, a)
				if err != nil {
					return "", err
				}
				if err := os.WriteFile(abs, []byte(v.Content), 0o644); err != nil {
					return "", err
				}
				return "created " + v.Path, nil
			},
		},
		{
			Name: "git_commit", Description: "Commit the listed files with a message (only those files are staged). The person approves it first. Hooks do not run.",
			Schema: `{"type":"object","properties":{"message":{"type":"string"},"paths":{"type":"array","items":{"type":"string"}}},"required":["message","paths"]}`,
			Describe: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, err := commitArgs(root, a)
				if err != nil {
					return "", err
				}
				return fmt.Sprintf("Commit %d file(s): %s\nMessage: %s", len(v.Paths), strings.Join(v.Paths, ", "), clip(v.Message, 500)), nil
			},
			Run: func(ctx context.Context, a json.RawMessage) (string, error) {
				v, err := commitArgs(root, a)
				if err != nil {
					return "", err
				}
				add := []string{"add", "--"}
				for _, p := range v.Paths {
					add = append(add, ":(literal)"+filepath.ToSlash(p))
				}
				if _, err := repo.Git(ctx, root.Path, add...); err != nil {
					return "", err
				}
				commit := []string{"commit", "--no-verify", "-m", v.Message, "--"}
				for _, p := range v.Paths {
					commit = append(commit, ":(literal)"+filepath.ToSlash(p))
				}
				r, err := repo.Git(ctx, root.Path, commit...)
				if err != nil {
					return "", err
				}
				return clip(r.Out, 800), nil
			},
		},
	}
	return append(read, write...)
}

type edit struct{ Path, Old, New string }

func editTarget(root policy.Root, a json.RawMessage) (edit, string, error) {
	v, err := parse[edit](a)
	if err != nil {
		return v, "", err
	}
	if v.Old == "" {
		return v, "", errors.New("old must not be empty")
	}
	abs, err := writable(root, v.Path)
	if err != nil {
		return v, "", err
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return v, "", fmt.Errorf("cannot read %s: %v", v.Path, err)
	}
	switch n := strings.Count(string(b), v.Old); {
	case n == 0:
		return v, "", errors.New("the text to replace was not found — read the file again and copy it exactly")
	case n > 1:
		return v, "", fmt.Errorf("the text occurs %d times — include more surrounding lines so it is unique", n)
	}
	return v, abs, nil
}

type newFile struct{ Path, Content string }

func newFileTarget(root policy.Root, a json.RawMessage) (newFile, string, error) {
	v, err := parse[newFile](a)
	if err != nil {
		return v, "", err
	}
	if len(v.Content) > 512*1024 {
		return v, "", errors.New("the file is too large")
	}
	abs, err := writable(root, v.Path)
	if err != nil {
		return v, "", err
	}
	if _, err := os.Lstat(abs); err == nil {
		return v, "", errors.New("the file already exists — use edit_file")
	}
	return v, abs, nil
}

type commitReq struct {
	Message string
	Paths   []string
}

func commitArgs(root policy.Root, a json.RawMessage) (commitReq, error) {
	v, err := parse[commitReq](a)
	if err != nil {
		return v, err
	}
	if strings.TrimSpace(v.Message) == "" || len(v.Paths) == 0 || len(v.Paths) > 100 {
		return v, errors.New("a message and 1–100 paths are required")
	}
	for _, p := range v.Paths {
		clean := path.Clean(filepath.ToSlash(p))
		if filepath.IsAbs(p) || clean == ".." || strings.HasPrefix(clean, "../") || clean == "." {
			return v, fmt.Errorf("%q is not a file inside the repository", p)
		}
		if why := policy.NeverReason(clean); why != "" {
			return v, errors.New(why)
		}
		// a folder would stage everything under it, a stray .env included: files only
		if fi, err := os.Lstat(filepath.Join(root.Path, filepath.FromSlash(clean))); err == nil && !fi.Mode().IsRegular() {
			return v, fmt.Errorf("%q is not a regular file — list the files to commit one by one", p)
		}
	}
	return v, nil
}

// serverTools are the tools the server's agents may run here through the line, by name. The person's approval has already happened on the server (a card in the
// dashboard), so these run without the terminal question — but with every limit the tool itself has: the never-list, paths inside the root, files not links.
var serverTools = map[string]bool{"list_files": true, "search": true, "read_file": true, "edit_file": true, "write_file": true}

// RunTool runs one of the file tools of the local agent for the server. args is the tool's JSON arguments.
func RunTool(ctx context.Context, root policy.Root, name string, args json.RawMessage) (string, error) {
	if !serverTools[name] {
		return "", fmt.Errorf("no such tool %q", name)
	}
	for _, t := range tools(root) {
		if t.Name == name {
			return t.Run(ctx, args)
		}
	}
	return "", fmt.Errorf("no such tool %q", name)
}
