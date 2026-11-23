// Package link is the daemon's line to the server: pairing over HTTP, then one WebSocket that is kept up.
package link

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
)

// Info says what this daemon is (sent in `hello` and when pairing).
type Info struct {
	Version string
	OS      string
	Arch    string
	Host    string
}

// normalizeServer turns what a person typed into an origin: adds http(s)://, drops a path.
func normalizeServer(s string) (*url.URL, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("the server address is empty")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("not a server address: %q", s)
	}
	return &url.URL{Scheme: u.Scheme, Host: u.Host}, nil
}

// Pair exchanges the one-use code from the dashboard for this device's token.
func Pair(ctx context.Context, hc *http.Client, server, code, device string, info Info) (config.Config, error) {
	u, err := normalizeServer(server)
	if err != nil {
		return config.Config{}, err
	}
	body, _ := json.Marshal(map[string]string{"code": strings.TrimSpace(code), "device": device, "os": info.OS, "arch": info.Arch, "version": info.Version})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, u.String()+"/api/local-agent/token", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(req)
	if err != nil {
		return config.Config{}, fmt.Errorf("cannot reach %s: %w", u.Host, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		var e struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Message == "" {
			e.Message = strings.TrimSpace(string(raw))
		}
		return config.Config{}, fmt.Errorf("pairing refused (%d): %s", res.StatusCode, e.Message)
	}
	var ok struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(raw, &ok); err != nil || ok.Token == "" {
		return config.Config{}, fmt.Errorf("the server's answer has no token")
	}
	return config.Config{Server: u.String(), Token: ok.Token, Device: device}, nil
}

// NormalizeServer is normalizeServer for other packages: it returns the origin as a string.
func NormalizeServer(s string) (string, error) {
	u, err := normalizeServer(s)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}
