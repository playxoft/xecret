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
	switch subcommand(args, "help") {
	case "clear":
		// Every argument after the verb is accounted for, because this is the
		// one destructive command in the CLI that takes none. Matching on
		// args[0] and discarding the rest meant `xecret cache clear --help`
		// erased the cache — the documented "show me what this does" idiom
		// doing the thing instead of describing it.
		for _, argument := range args[1:] {
			switch argument {
			case "help", "--help", "-h":
				fmt.Fprint(os.Stdout, cacheUsage)
				return nil
			default:
				return fmt.Errorf("'cache clear' takes no arguments, got %q", argument)
			}
		}

		a := newApp(false)
		if err := cache.Clear(a.store); err != nil {
			return err
		}
		a.printer.Successf("Offline cache cleared and its key destroyed.")
		return nil
	case "help":
		fmt.Fprint(os.Stdout, cacheUsage)
		return nil
	default:
		return fmt.Errorf("unknown cache subcommand %q\n\n%s", args[0], cacheUsage)
	}
}
