//go:build !windows

package run

import (
	"os"
	"syscall"
)

// forwardedSignals is every signal a supervisor plausibly sends that a child
// can act on. SIGKILL and SIGSTOP cannot be caught and are absent by nature.
func forwardedSignals() []os.Signal {
	return []os.Signal{
		syscall.SIGINT,
		syscall.SIGTERM,
		syscall.SIGHUP,
		syscall.SIGQUIT,
		syscall.SIGUSR1,
		syscall.SIGUSR2,
		syscall.SIGWINCH,
	}
}
