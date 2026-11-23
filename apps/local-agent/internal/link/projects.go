package link

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
)

// Project is a project of the server that has a repository this computer could fetch.
type Project struct {
	ID      string `json:"id"`
	Slug    string `json:"slug"`
	Name    string `json:"name"`
	RepoURL string `json:"repoUrl"`
	Branch  string `json:"branch,omitempty"`
}

// FetchProjects asks the server which projects can be opened here (this computer's own token is the credential).
func FetchProjects(ctx context.Context, hc *http.Client, cfg config.Config) ([]Project, error) {
	if hc == nil {
		hc = &http.Client{Timeout: 20 * time.Second}
	}
	base, err := NormalizeServer(cfg.Server)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/local-agent/projects", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	res, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the server does not answer: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return nil, fmt.Errorf("the server does not accept this computer (disconnected?) — sign in again with `aigentron login`")
	case res.StatusCode == http.StatusNotFound:
		return nil, fmt.Errorf("this server is too old to list projects — update it to 0.2.3 or later")
	case res.StatusCode != 200:
		return nil, fmt.Errorf("the server answered %d", res.StatusCode)
	}
	var out struct {
		Projects []Project `json:"projects"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("the server's answer could not be read")
	}
	return out.Projects, nil
}
