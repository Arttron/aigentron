package writes

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOffByDefaultAndBrokenFileMeansOff(t *testing.T) {
	t.Setenv("AIGENTRON_LOCAL_HOME", t.TempDir())
	if Allowed() {
		t.Fatal("writes must be off by default")
	}
	_ = Save(Config{Write: true})
	if !Allowed() {
		t.Fatal("on")
	}
	_ = os.WriteFile(filepath.Join(os.Getenv("AIGENTRON_LOCAL_HOME"), "writes.json"), []byte("{broken"), 0o600)
	if Allowed() {
		t.Fatal("a broken file must not allow writes")
	}
}

func TestStopExpiresAndResumes(t *testing.T) {
	t.Setenv("AIGENTRON_LOCAL_HOME", t.TempDir())
	if Stopped() {
		t.Fatal("no Stop yet")
	}
	_ = Stop(time.Hour)
	if !Stopped() || time.Until(StoppedUntil()) < 50*time.Minute {
		t.Fatal("a Stop must be in force")
	}
	_ = Resume()
	if Stopped() {
		t.Fatal("Resume must lift it")
	}
	_ = Resume() // twice is fine
	// an unreadable Stop file is a Stop (the safe side)
	_ = os.WriteFile(filepath.Join(os.Getenv("AIGENTRON_LOCAL_HOME"), "stop.json"), []byte("garbage"), 0o600)
	if !Stopped() {
		t.Fatal("a broken Stop file must count as a Stop")
	}
	// an old Stop is over
	_ = os.WriteFile(filepath.Join(os.Getenv("AIGENTRON_LOCAL_HOME"), "stop.json"), []byte(`{"until":1000}`), 0o600)
	if Stopped() {
		t.Fatal("an expired Stop must not hold")
	}
}
