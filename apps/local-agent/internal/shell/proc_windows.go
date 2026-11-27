//go:build windows

package shell

import "os/exec"

func own(c *exec.Cmd) {}

func killGroup(c *exec.Cmd) {
	if c.Process != nil {
		_ = c.Process.Kill()
	}
}
