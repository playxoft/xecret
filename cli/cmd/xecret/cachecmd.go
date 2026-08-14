package main

import (
	"fmt"
	"os"

	"github.com/playxoft/xecret/cli/internal/cache"
)

const cacheUsage = `Usage:
  xecret cache clear    Remove every encrypted offline copy and its key
`

// cmdCache manages the offline cache. Clearing removes the files *and* the
// encryption key from the OS keychain — cryptographic erasure, the same
// design the server uses for environment deletion.
func cmdCache(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stdout, cacheUsage)
		return nil
	}

	switch args[0] {
	case "clear":
		a := newApp(false)
		if err := cache.Clear(a.store); err != nil {
			return err
		}
		a.printer.Successf("Offline cache cleared and its key destroyed.")
		return nil
	case "help", "--help", "-h":
		fmt.Fprint(os.Stdout, cacheUsage)
		return nil
	default:
		return fmt.Errorf("unknown cache subcommand %q\n\n%s", args[0], cacheUsage)
	}
}
