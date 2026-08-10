// Command xecret is the xecret command-line interface.
//
// Phase 1 provides the skeleton and the version command only. Commands land in
// Phase 6 (login, projects, secrets, pull, run) and Phase 8 (CI service tokens).
//
// Two rules govern everything in this binary, from the first commit:
//
//  1. A secret value is never written to stdout, stderr, a log, a temporary
//     file, or a process argument. Values go to the child process environment
//     and nowhere else.
//  2. Credentials live in the OS keychain, never in a dotfile the user might
//     commit or sync.
package main

import (
	"fmt"
	"os"

	"github.com/playxoft/xecret/cli/internal/buildinfo"
)

const usage = `xecret — open-source secret management

Usage:
  xecret <command> [flags]

Commands:
  version      Print version information
  help         Show this help

Coming in Phase 6:
  login        Authenticate this device
  logout       Revoke this device's credentials
  init         Create .xecret.yaml in the current directory
  projects     List projects
  environments List environments
  secrets      Manage secrets
  import       Import from .env, JSON or YAML
  pull         Fetch secrets in a chosen format
  run          Run a command with secrets injected

Learn more: https://xecret.playxoft.com/docs
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "xecret: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stdout, usage)
		return nil
	}

	switch args[0] {
	case "version", "--version", "-v":
		fmt.Fprintln(os.Stdout, buildinfo.String())
		return nil
	case "help", "--help", "-h":
		fmt.Fprint(os.Stdout, usage)
		return nil
	default:
		return fmt.Errorf("unknown command %q\n\nRun 'xecret help' to see available commands", args[0])
	}
}
