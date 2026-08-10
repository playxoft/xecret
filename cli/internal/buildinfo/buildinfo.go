// Package buildinfo carries version metadata stamped in at link time.
package buildinfo

import (
	"fmt"
	"runtime"
)

// These are set via -ldflags at release time by GoReleaser. The defaults are
// what a local `go build` produces.
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// DefaultAPIURL is the xecret instance the CLI talks to unless overridden by
// the XECRET_API_URL environment variable or a .xecret.yaml file.
//
// This value is compiled into every distributed binary. Changing it after
// release breaks every installed CLI, so it is deliberately a constant rather
// than something to edit casually. See docs/adr/0004-cli-language-go.md.
const DefaultAPIURL = "https://xecret.playxoft.com"

// String returns a human-readable version line.
func String() string {
	return fmt.Sprintf("xecret %s (commit %s, built %s, %s/%s, %s)",
		Version, Commit, Date, runtime.GOOS, runtime.GOARCH, runtime.Version())
}
