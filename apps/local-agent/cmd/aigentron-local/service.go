package main

import (
	"errors"
	"fmt"
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/Arttron/aigentron/apps/local-agent/internal/config"
)

// serviceName tells the dev copy's service from the installed one's, so both can be set up on one computer.
func serviceName() string {
	if config.Dev() {
		return "aigentron-dev"
	}
	return "aigentron"
}

// plistLabel is the launchd label (reverse-DNS style).
func plistLabel() string { return "dev." + serviceName() }

func renderPlist(label, exe, logPath, home string) string {
	env := ""
	if home != "" {
		env = "\n  <key>EnvironmentVariables</key><dict><key>AIGENTRON_LOCAL_HOME</key><string>" + html.EscapeString(home) + "</string></dict>"
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>` + html.EscapeString(label) + `</string>
  <key>ProgramArguments</key><array><string>` + html.EscapeString(exe) + `</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>` + html.EscapeString(logPath) + `</string>
  <key>StandardErrorPath</key><string>` + html.EscapeString(logPath) + `</string>` + env + `
</dict></plist>
`
}

// systemdQuote quotes one word of ExecStart= (systemd splits on spaces and treats % and $ specially).
func systemdQuote(s string) string {
	s = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "$", "$$").Replace(s)
	return `"` + s + `"`
}

func renderUnit(exe, home string) string {
	env := ""
	if home != "" {
		env = "Environment=" + systemdQuote("AIGENTRON_LOCAL_HOME="+home) + "\n"
	}
	return "[Unit]\nDescription=Aigentron local agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=" + systemdQuote(exe) + " run\nRestart=always\nRestartSec=5\n" + env + "\n[Install]\nWantedBy=default.target\n"
}

func run(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// cmdService: `aigentron service install | uninstall | status` — keep `run` going in the background and start it at sign-in (launchd on macOS, a systemd user service on Linux). Nothing is
// started unless the person typed `install`.
func cmdService(args []string) error {
	if len(args) != 1 || (args[0] != "install" && args[0] != "uninstall" && args[0] != "status") {
		return errors.New("usage: " + progName() + " service install | uninstall | status")
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		return fmt.Errorf("a background service is set up for macOS and Linux only; on %s start `%s run` in a terminal", runtime.GOOS, progName())
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cfgHome := os.Getenv("AIGENTRON_LOCAL_HOME")
	if args[0] == "install" {
		if _, err := config.Load(); err != nil {
			return fmt.Errorf("%v — pair this computer first (`%s login --server <url>`)", err, progName())
		}
	}
	if runtime.GOOS == "darwin" {
		return serviceDarwin(args[0], home, exe, cfgHome)
	}
	return serviceLinux(args[0], home, exe, cfgHome)
}

func serviceDarwin(op, home, exe, cfgHome string) error {
	label := plistLabel()
	plist := filepath.Join(home, "Library", "LaunchAgents", label+".plist")
	logPath := filepath.Join(home, "Library", "Logs", serviceName()+".log")
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	switch op {
	case "install":
		if err := os.MkdirAll(filepath.Dir(plist), 0o755); err != nil {
			return err
		}
		_, _ = run("launchctl", "bootout", domain+"/"+label) // an older copy of this service, if any
		if err := os.WriteFile(plist, []byte(renderPlist(label, exe, logPath, cfgHome)), 0o644); err != nil {
			return err
		}
		if out, err := run("launchctl", "bootstrap", domain, plist); err != nil {
			return fmt.Errorf("launchctl could not start it: %s", out)
		}
		fmt.Printf("Installed: %s runs in the background and starts when you sign in.\n  program: %s\n  log:     %s\n  stop:    %s service uninstall\n", label, exe, logPath, progName())
	case "uninstall":
		_, _ = run("launchctl", "bootout", domain+"/"+label)
		if err := os.Remove(plist); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		fmt.Println("Stopped and removed", label)
	case "status":
		if _, err := os.Stat(plist); err != nil {
			fmt.Println("Not installed (", progName(), "service install )")
			return nil
		}
		out, err := run("launchctl", "print", domain+"/"+label)
		if err != nil {
			fmt.Println("Installed but not running:", plist)
			return nil
		}
		state := "loaded"
		for _, l := range strings.Split(out, "\n") {
			if t := strings.TrimSpace(l); strings.HasPrefix(t, "state =") || strings.HasPrefix(t, "pid =") {
				state += ", " + t
			}
		}
		fmt.Printf("Installed (%s). Log: %s\n", state, logPath)
	}
	return nil
}

func serviceLinux(op, home, exe, cfgHome string) error {
	name := serviceName() + ".service"
	unit := filepath.Join(home, ".config", "systemd", "user", name)
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errors.New("systemctl was not found — this computer does not use systemd; start `" + progName() + " run` with your own supervisor")
	}
	switch op {
	case "install":
		if err := os.MkdirAll(filepath.Dir(unit), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(unit, []byte(renderUnit(exe, cfgHome)), 0o644); err != nil {
			return err
		}
		if out, err := run("systemctl", "--user", "daemon-reload"); err != nil {
			return fmt.Errorf("systemctl --user is not available here: %s", out)
		}
		if out, err := run("systemctl", "--user", "enable", "--now", name); err != nil {
			return fmt.Errorf("could not start it: %s", out)
		}
		fmt.Printf("Installed: %s runs in the background and starts when you sign in.\n  log:  journalctl --user -u %s -f\n  stop: %s service uninstall\n  To keep it running when nobody is signed in: sudo loginctl enable-linger $USER\n", name, name, progName())
	case "uninstall":
		_, _ = run("systemctl", "--user", "disable", "--now", name)
		if err := os.Remove(unit); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		_, _ = run("systemctl", "--user", "daemon-reload")
		fmt.Println("Stopped and removed", name)
	case "status":
		if _, err := os.Stat(unit); err != nil {
			fmt.Println("Not installed (", progName(), "service install )")
			return nil
		}
		out, _ := run("systemctl", "--user", "is-active", name)
		fmt.Printf("Installed, %s. Log: journalctl --user -u %s\n", out, name)
	}
	return nil
}
