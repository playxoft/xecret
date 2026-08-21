package main

import (
	"flag"
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
		//
		// That check was hand-written here for as long as it was the only one.
		// It goes through `parseFlagsOnly` now that every such command has it:
		// two spellings of one rule drift, and the command they would drift
		// apart on is the one that deletes something.
		flags := flag.NewFlagSet("cache clear", flag.ContinueOnError)
		flags.Usage = func() { fmt.Fprint(os.Stdout, cacheUsage) }
		if err := parseFlagsOnly(flags, args[1:]); err != nil {
			return err
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
