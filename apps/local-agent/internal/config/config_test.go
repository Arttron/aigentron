package config

import (
	"errors"
	"os"
	"runtime"
	"testing"
)

func TestSaveLoadClear(t *testing.T) {
	t.Setenv("AIGENTRON_LOCAL_HOME", t.TempDir())
	if _, err := Load(); !errors.Is(err, ErrNotPaired) {
		t.Fatalf("want ErrNotPaired, got %v", err)
	}
	want := Config{Server: "http://localhost:3001", Token: "lag_a_b", Device: "laptop"}
	if err := Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := Load()
	if err != nil || got != want {
		t.Fatalf("got %+v, %v", got, err)
	}
	if runtime.GOOS != "windows" {
		p, _ := path()
		if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
			t.Fatalf("config mode %v, want 0600", st.Mode().Perm())
		}
	}
	if err := Clear(); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); !errors.Is(err, ErrNotPaired) {
		t.Fatalf("after Clear: %v", err)
	}
}
