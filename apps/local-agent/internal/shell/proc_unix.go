//go:build !windows

package shell

import (
	"os/exec"
	"syscall"
)

// own puts the command in its own process group, so that cutting it off takes its children with it.
func own(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

func killGroup(c *exec.Cmd) {
	if c.Process != nil {
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
	}
}
