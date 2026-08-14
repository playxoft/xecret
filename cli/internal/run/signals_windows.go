//go:build windows

package run

import "os"

// forwardedSignals on Windows is the one signal the runtime can deliver.
func forwardedSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}
