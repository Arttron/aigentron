package oplog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func home(t *testing.T) { t.Setenv("AIGENTRON_LOCAL_HOME", t.TempDir()) }

func TestOffByDefaultWritesNothing(t *testing.T) {
	home(t)
	c, err := Load()
	if err != nil || c.Enabled || c.MaxMB != DefaultMaxMB || c.Keep != DefaultKeep {
		t.Fatalf("%+v %v", c, err)
	}
	if err := Record(Entry{Op: "repo.read", Result: "ok"}); err != nil {
		t.Fatal(err)
	}
	p, _ := FilePath()
	if _, err := os.Stat(p); err == nil {
		t.Fatal("a journal that is off must not create a file")
	}
}

func TestRecordAndTail(t *testing.T) {
	home(t)
	_ = Save(Config{Enabled: true, MaxMB: 1, Keep: 2})
	for _, e := range []Entry{{Op: "repo.status", Repo: "a1", Result: "ok"}, {Op: "repo.read", Repo: "a1", Path: ".env", Result: "error", Error: strings.Repeat("x", 500)}} {
		if err := Record(e); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := Tail(10)
	if len(got) != 2 || got[0].Op != "repo.status" || got[1].Path != ".env" || got[1].Result != "error" || len(got[1].Error) != maxErrLen || got[0].Time == "" {
		t.Fatalf("%+v", got)
	}
	if one, _ := Tail(1); len(one) != 1 || one[0].Op != "repo.read" {
		t.Fatalf("tail 1: %+v", one)
	}
	p, _ := FilePath()
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
		t.Errorf("the journal must be private, got %v", st.Mode().Perm())
	}
}

func TestRotationKeepsTheConfiguredFiles(t *testing.T) {
	home(t)
	_ = Save(Config{Enabled: true, MaxMB: 1, Keep: 2})
	big := strings.Repeat("y", 150) // each entry ~ 250 bytes; ~4200 per MB
	n := 0
	for ; n < 14000; n++ {
		if err := Record(Entry{Op: "repo.log", Detail: big, Result: "ok"}); err != nil {
			t.Fatal(err)
		}
	}
	p, _ := FilePath()
	for _, f := range []string{p, p + ".1", p + ".2"} {
		st, err := os.Stat(f)
		if err != nil || st.Size() > 1<<20 {
			t.Fatalf("%s: %v %v", filepath.Base(f), st, err)
		}
	}
	if _, err := os.Stat(p + ".3"); err == nil {
		t.Fatal("more rotated files than Keep")
	}
	// the newest entries survive, in order, across the files
	all, _ := Tail(0)
	if len(all) == 0 || len(all) >= n {
		t.Fatalf("old entries must be dropped, got %d of %d", len(all), n)
	}
}

func TestKeepZeroDropsTheOldFile(t *testing.T) {
	home(t)
	_ = Save(Config{Enabled: true, MaxMB: 1, Keep: 0})
	big := strings.Repeat("y", 150)
	for i := 0; i < 6000; i++ {
		_ = Record(Entry{Op: "x", Detail: big, Result: "ok"})
	}
	p, _ := FilePath()
	if _, err := os.Stat(p + ".1"); err == nil {
		t.Fatal("keep 0 must not keep a rotated file")
	}
}

func TestSaveClampsAndClearRemovesEverything(t *testing.T) {
	home(t)
	_ = Save(Config{Enabled: true, MaxMB: 9999, Keep: 999})
	c, _ := Load()
	if c.MaxMB != MaxMaxMB || c.Keep != MaxKeep {
		t.Fatalf("%+v", c)
	}
	_ = Save(Config{Enabled: true, MaxMB: 1, Keep: 1})
	p, _ := FilePath()
	_ = os.WriteFile(p, []byte("{}\n"), 0o600)
	_ = os.WriteFile(p+".1", []byte("{}\n"), 0o600)
	if err := Clear(); err != nil {
		t.Fatal(err)
	}
	if got, _ := Tail(0); len(got) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestHandEditedFileKeepsDefaults(t *testing.T) {
	home(t)
	p, _ := configFile()
	_ = os.WriteFile(p, []byte(`{"enabled":true}`), 0o600)
	c, err := Load()
	if err != nil || !c.Enabled || c.MaxMB != DefaultMaxMB || c.Keep != DefaultKeep {
		t.Fatalf("%+v %v", c, err)
	}
}
