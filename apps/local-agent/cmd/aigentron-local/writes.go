package main

import (
	"errors"
	"fmt"
	"time"

	"github.com/Arttron/aigentron/apps/local-agent/internal/writes"
)

func cmdWrites(args []string) error {
	c, err := writes.Load()
	if err != nil {
		return err
	}
	if len(args) == 1 && (args[0] == "on" || args[0] == "off") {
		c.Write = args[0] == "on"
		if err := writes.Save(c); err != nil {
			return err
		}
	} else if len(args) != 0 {
		return errors.New("usage: aigentron writes [on|off]")
	}
	if c.Write {
		fmt.Println("Writes are ON: agents of the projects you shared a folder with may, with your approval in the dashboard, edit and create files there, commit, and run commands (a command is NOT confined to the folder: it can reach whatever your account can). Secrets are never read or written by the file tools. Stop it any time with: aigentron stop. Turn off with: aigentron writes off")
	} else {
		fmt.Println("Writes are OFF (the default): the server can only look at your folders. Allow changes with: aigentron writes on")
	}
	return nil
}

// cmdStop is the person's Stop on this computer: nothing is changed or run for a while, and what is running is cut off.
func cmdStop(args []string) error {
	if len(args) > 1 {
		return errors.New("usage: aigentron stop [10m|1h|off]")
	}
	if len(args) == 1 && args[0] == "off" {
		if err := writes.Resume(); err != nil {
			return err
		}
		fmt.Println("Stop lifted: changes are allowed again (if writes are on).")
		return nil
	}
	d := 10 * time.Minute
	if len(args) == 1 {
		var err error
		if d, err = time.ParseDuration(args[0]); err != nil || d < time.Minute || d > 24*time.Hour {
			return errors.New("give a time between 1m and 24h, for example 30m")
		}
	}
	if err := writes.Stop(d); err != nil {
		return err
	}
	fmt.Printf("Stopped for %s: no change and no command is accepted from the server, and what is running is cut off within a second. Lift it with: aigentron stop off\n", d)
	return nil
}
