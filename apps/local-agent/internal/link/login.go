package link

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
)

// LoginPrompt is what the person must be shown: open the link (or type the code on the Add-ons page).
type LoginPrompt struct {
	UserCode        string
	VerificationURL string
	ExpiresIn       time.Duration
}

// Login runs the device authorization flow: ask the server for a pair of codes, show the short one (onPrompt), then poll until the person approves it in the dashboard.
func Login(ctx context.Context, hc *http.Client, server, device string, info Info, onPrompt func(LoginPrompt)) (config.Config, error) {
	u, err := normalizeServer(server)
	if err != nil {
		return config.Config{}, err
	}
	if hc == nil {
		hc = http.DefaultClient
	}
	var start struct {
		DeviceCode      string `json:"deviceCode"`
		UserCode        string `json:"userCode"`
		VerificationURL string `json:"verificationUrl"`
		ExpiresInSec    int    `json:"expiresInSec"`
		IntervalSec     int    `json:"intervalSec"`
	}
	if err := postJSON(ctx, hc, u.String()+"/api/local-agent/device/start", map[string]string{"device": device, "os": info.OS, "arch": info.Arch, "version": info.Version}, &start); err != nil {
		return config.Config{}, err
	}
	if start.DeviceCode == "" || start.UserCode == "" {
		return config.Config{}, errors.New("the server's answer has no codes")
	}
	url := start.VerificationURL
	if url == "" {
		url = u.String() + "/addons?tab=local-agent&code=" + start.UserCode
	}
	expires := time.Duration(start.ExpiresInSec) * time.Second
	if expires <= 0 {
		expires = 10 * time.Minute
	}
	if onPrompt != nil {
		onPrompt(LoginPrompt{UserCode: start.UserCode, VerificationURL: url, ExpiresIn: expires})
	}
	interval := time.Duration(start.IntervalSec) * time.Second
	if interval <= 0 {
		interval = 2 * time.Second
	}
	deadline := time.Now().Add(expires)
	for {
		select {
		case <-ctx.Done():
			return config.Config{}, ctx.Err()
		case <-time.After(interval):
		}
		if time.Now().After(deadline) {
			return config.Config{}, errors.New("the sign-in was not approved in time — run login again")
		}
		var poll struct {
			Status string `json:"status"`
			Token  string `json:"token"`
		}
		if err := postJSON(ctx, hc, u.String()+"/api/local-agent/device/poll", map[string]string{"deviceCode": start.DeviceCode}, &poll); err != nil {
			continue // a network hiccup: keep polling until the deadline
		}
		switch poll.Status {
		case "pending":
		case "approved":
			if poll.Token == "" {
				return config.Config{}, errors.New("approved, but the server sent no token")
			}
			return config.Config{Server: u.String(), Token: poll.Token, Device: device}, nil
		case "denied":
			return config.Config{}, errors.New("the sign-in was denied on the dashboard")
		default:
			return config.Config{}, errors.New("the sign-in expired — run login again")
		}
	}
}

func postJSON(ctx context.Context, hc *http.Client, url string, body, out any) error {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	req.Header.Set("content-type", "application/json")
	res, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach the server: %w", err)
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
		return fmt.Errorf("server answered %d: %s", res.StatusCode, e.Message)
	}
	return json.Unmarshal(raw, out)
}
