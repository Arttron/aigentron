package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func targz(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for n, c := range files {
		tw.WriteHeader(&tar.Header{Name: n, Mode: 0o755, Size: int64(len(c)), Typeflag: tar.TypeReg})
		tw.Write([]byte(c))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func serve(t *testing.T, ver string, archive []byte, lie bool) *httptest.Server {
	sum := sha256.Sum256(archive)
	hexs := hex.EncodeToString(sum[:])
	if lie {
		hexs = strings.Repeat("0", 64)
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/local-agent/package.sha256":
			w.Write([]byte(hexs + "\n"))
		case "/api/local-agent/package":
			w.Header().Set("Content-Disposition", `attachment; filename="aigentron-local_`+ver+`_`+runtime.GOOS+`_`+runtime.GOARCH+`.tar.gz"`)
			w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))
}

func script(ver string) string { return "#!/bin/sh\necho " + ver + "\n" }

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"0.2.6", "0.2.5", true}, {"0.2.5", "0.2.5", false}, {"0.2.4", "0.2.5", false}, {"0.10.0", "0.9.9", true}, {"dev-abc", "0.2.5", false}, {"1.0.0", "0.99.99", true}} {
		if Newer(c.a, c.b) != c.want {
			t.Errorf("Newer(%s,%s)", c.a, c.b)
		}
	}
}

func TestFetchCheckOnlyAndDownload(t *testing.T) {
	arc := targz(t, map[string]string{"aigentron-local": script("0.9.0")})
	srv := serve(t, "0.9.0", arc, false)
	defer srv.Close()
	o, err := Fetch(context.Background(), nil, srv.URL, runtime.GOOS, runtime.GOARCH, "")
	if err != nil || o.Version != "0.9.0" || o.Archive != "" {
		t.Fatalf("%+v %v", o, err)
	}
	dir := t.TempDir()
	o, err = Fetch(context.Background(), nil, srv.URL, runtime.GOOS, runtime.GOARCH, dir)
	if err != nil || o.Archive == "" {
		t.Fatalf("%+v %v", o, err)
	}
}

func TestChecksumMismatchChangesNothing(t *testing.T) {
	arc := targz(t, map[string]string{"aigentron-local": script("0.9.0")})
	srv := serve(t, "0.9.0", arc, true)
	defer srv.Close()
	dir := t.TempDir()
	if _, err := Fetch(context.Background(), nil, srv.URL, runtime.GOOS, runtime.GOARCH, dir); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("must refuse: %v", err)
	}
	if es, _ := os.ReadDir(dir); len(es) != 0 {
		t.Error("the bad download must be removed")
	}
}

func TestApplySwapsAndKeepsPrev(t *testing.T) {
	arc := targz(t, map[string]string{"aigentron-local": script("0.9.0")})
	srv := serve(t, "0.9.0", arc, false)
	defer srv.Close()
	dir := t.TempDir()
	exe := filepath.Join(dir, "aigentron")
	os.WriteFile(exe, []byte(script("0.1.0")), 0o755)
	o, err := Fetch(context.Background(), nil, srv.URL, runtime.GOOS, runtime.GOARCH, dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(o, exe); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); !strings.Contains(string(b), "0.9.0") {
		t.Error("not replaced")
	}
	if b, _ := os.ReadFile(exe + ".prev"); !strings.Contains(string(b), "0.1.0") {
		t.Error("the old program must stay as .prev")
	}
}

func TestApplyRefusesAProgramThatLiesAboutItsVersion(t *testing.T) {
	arc := targz(t, map[string]string{"aigentron-local": script("0.0.1")}) // says 0.0.1 although the server offers 0.9.0
	srv := serve(t, "0.9.0", arc, false)
	defer srv.Close()
	dir := t.TempDir()
	exe := filepath.Join(dir, "aigentron")
	os.WriteFile(exe, []byte(script("0.1.0")), 0o755)
	o, _ := Fetch(context.Background(), nil, srv.URL, runtime.GOOS, runtime.GOARCH, dir)
	if err := Apply(o, exe); err == nil {
		t.Fatal("must refuse")
	}
	if b, _ := os.ReadFile(exe); !strings.Contains(string(b), "0.1.0") {
		t.Error("the program must stay as it was")
	}
}

func TestExtractReadsOnlyTheProgram(t *testing.T) {
	arc := filepath.Join(t.TempDir(), "a.tar.gz")
	os.WriteFile(arc, targz(t, map[string]string{"../evil": "x", "/abs/evil": "x", "other": "y"}), 0o644)
	if err := Extract(arc, "aigentron-local", filepath.Join(t.TempDir(), "o")); err == nil {
		t.Fatal("an archive without the program must be refused")
	}
}
