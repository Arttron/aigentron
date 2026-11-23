// Package update replaces the running program with the version of the server it is paired with: download the archive of this platform FROM THAT SERVER, check its SHA-256
// (also from that server), unpack exactly one file, run it once to see that it really is the new version, then swap it in — the old one stays next to it as `<name>.prev`.
package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const maxArchive = 200 << 20

var nameRe = regexp.MustCompile(`^aigentron-local_(\d+\.\d+\.\d+)_([a-z0-9]+)_([a-z0-9]+)\.(tar\.gz|zip)$`)

// Offer is what the server hands out for this platform.
type Offer struct {
	Version string
	Name    string
	SHA256  string
	Archive string // path of the downloaded archive ("" when only checked)
}

func get(ctx context.Context, hc *http.Client, u string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the server does not answer: %v", err)
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		if res.StatusCode == 404 || res.StatusCode == 503 || res.StatusCode == 502 {
			return nil, fmt.Errorf("the server has no package of the local agent for %s/%s yet (%d)", runtime.GOOS, runtime.GOARCH, res.StatusCode)
		}
		return nil, fmt.Errorf("the server answered %d", res.StatusCode)
	}
	return res, nil
}

// Fetch asks the server for the package of this platform. With dir != "" the archive is downloaded there and checked; with dir == "" only the offer (version, checksum) is read —
// the body is not downloaded.
func Fetch(ctx context.Context, hc *http.Client, server, goos, goarch, dir string) (Offer, error) {
	var o Offer
	if hc == nil {
		hc = &http.Client{Timeout: 5 * time.Minute}
	}
	q := "?os=" + url.QueryEscape(goos) + "&arch=" + url.QueryEscape(goarch)
	sres, err := get(ctx, hc, server+"/api/local-agent/package.sha256"+q)
	if err != nil {
		return o, err
	}
	sb, _ := io.ReadAll(io.LimitReader(sres.Body, 1024))
	sres.Body.Close()
	o.SHA256 = strings.ToLower(strings.TrimSpace(string(sb)))
	if len(o.SHA256) != 64 {
		return o, errors.New("the server's checksum could not be read")
	}
	res, err := get(ctx, hc, server+"/api/local-agent/package"+q)
	if err != nil {
		return o, err
	}
	defer res.Body.Close()
	cd := res.Header.Get("Content-Disposition")
	if i := strings.Index(cd, `filename="`); i >= 0 {
		o.Name = strings.TrimSuffix(cd[i+10:], `"`)
	}
	m := nameRe.FindStringSubmatch(o.Name)
	if m == nil || m[2] != goos || m[3] != goarch {
		return o, fmt.Errorf("the server sent an unexpected package name %q", o.Name)
	}
	o.Version = m[1]
	if dir == "" {
		return o, nil
	}
	f, err := os.CreateTemp(dir, ".aigentron-dl-*")
	if err != nil {
		return o, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(res.Body, maxArchive+1))
	f.Close()
	if err != nil || n > maxArchive {
		os.Remove(f.Name())
		return o, errors.New("the download failed or is too large")
	}
	if hex.EncodeToString(h.Sum(nil)) != o.SHA256 {
		os.Remove(f.Name())
		return o, errors.New("the checksum of the download does not match — nothing was changed")
	}
	o.Archive = f.Name()
	return o, nil
}

// Newer reports whether version a is newer than b (x.y.z). A version that cannot be read is never "newer".
func Newer(a, b string) bool {
	pa, pb := parse(a), parse(b)
	if pa == nil || pb == nil {
		return false
	}
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parse(v string) []int {
	p := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if len(p) != 3 {
		return nil
	}
	out := make([]int, 3)
	for i, s := range p {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			return nil
		}
		out[i] = n
	}
	return out
}

// Extract writes the program out of the archive to dst (mode 0755). Only the one file called `want` is read — nothing else in the archive is touched, whatever its path says.
func Extract(archive, want, dst string) error {
	if strings.HasSuffix(archive, ".zip") || zipMagic(archive) {
		r, err := zip.OpenReader(archive)
		if err != nil {
			return err
		}
		defer r.Close()
		for _, f := range r.File {
			if f.Name == want && f.Mode().IsRegular() && f.UncompressedSize64 <= maxArchive {
				rc, err := f.Open()
				if err != nil {
					return err
				}
				defer rc.Close()
				return writeExec(dst, rc)
			}
		}
		return fmt.Errorf("the archive has no %s", want)
	}
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("the archive has no %s", want)
		}
		if err != nil {
			return err
		}
		if h.Name == want && h.Typeflag == tar.TypeReg && h.Size <= maxArchive {
			return writeExec(dst, io.LimitReader(tr, maxArchive))
		}
	}
}

func zipMagic(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	b := make([]byte, 2)
	_, _ = io.ReadFull(f, b)
	return string(b) == "PK"
}

func writeExec(dst string, r io.Reader) error {
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// Swap puts newBin in place of exe: exe → exe.prev, newBin → exe. If the second step fails the first is undone.
func Swap(exe, newBin string) error {
	prev := exe + ".prev"
	_ = os.Remove(prev)
	if err := os.Rename(exe, prev); err != nil {
		return err
	}
	if err := os.Rename(newBin, exe); err != nil {
		_ = os.Rename(prev, exe)
		return err
	}
	return nil
}

// Apply installs an offer's archive over exe: unpack beside it, run the new program once (`version` must print the offered version), swap.
func Apply(o Offer, exe string) error {
	dir := filepath.Dir(exe)
	tmp := filepath.Join(dir, ".aigentron-new")
	_ = os.Remove(tmp)
	defer os.Remove(tmp)
	if err := Extract(o.Archive, "aigentron-local", tmp); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("no permission to write in %s — reinstall with the install command instead", dir)
		}
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, tmp, "version").Output()
	if err != nil || strings.TrimSpace(string(out)) != o.Version {
		return fmt.Errorf("the new program does not report version %s (got %q) — nothing was changed", o.Version, strings.TrimSpace(string(out)))
	}
	return Swap(exe, tmp)
}
