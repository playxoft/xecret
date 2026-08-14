// Command xecret is the xecret command-line interface.
//
// Two rules govern everything in this binary:
//
//  1. A secret value is never written to stdout, stderr, a log, a temporary
//     file, or a process argument — except by `pull` and `secrets get
//     --plain`, whose stated purpose is producing one, and which write it to
//     stdout raw and nowhere else.
//  2. Credentials live in the OS keychain, never in a dotfile the user might
//     commit or sync. The file fallback is 0600 and announces itself.
package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/buildinfo"
	"github.com/playxoft/xecret/cli/internal/cred"
)

const usage = `xecret — open-source secret management

Usage:
  xecret <command> [flags]

Authentication:
  login        Authenticate this device via the browser
  logout       Revoke this device's credential and wipe the offline cache
  whoami       Show which account and organisation this device uses

Project setup:
  init         Choose a project and environment; writes .xecret.yaml

Working with secrets:
  projects     List projects
  environments List environments of the current project
  secrets      list | get | set | delete
  import       Send a .env, JSON, YAML or shell file to the server
  pull         Print every secret in a chosen format   (env|json|yaml|shell|docker)
  run          Run a command with secrets injected:  xecret run -- npm run dev

Housekeeping:
  cache        clear — remove the encrypted offline cache
  version      Print version information
  help         Show this help

Flags every command that reads secrets accepts:
  --project, --environment   Override .xecret.yaml
  --json                     Machine-readable output (where it applies)

Learn more: ` + buildinfo.DefaultAPIURL + `/docs
`

func main() {
	os.Exit(dispatch(os.Args[1:]))
}

// exitCodeError carries a child process's exit code through the error path
// without attaching a message nobody should print.
type exitCodeError struct{ code int }

func (e exitCodeError) Error() string { return fmt.Sprintf("exit status %d", e.code) }

func dispatch(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stdout, usage)
		return 0
	}

	command, rest := args[0], args[1:]

	var err error
	switch command {
	case "version", "--version", "-v":
		fmt.Fprintln(os.Stdout, buildinfo.String())
	case "help", "--help", "-h":
		fmt.Fprint(os.Stdout, usage)
	case "login":
		err = cmdLogin(rest)
	case "logout":
		err = cmdLogout(rest)
	case "whoami":
		err = cmdWhoami(rest)
	case "init":
		err = cmdInit(rest)
	case "projects":
		err = cmdProjects(rest)
	case "environments":
		err = cmdEnvironments(rest)
	case "secrets":
		err = cmdSecrets(rest)
	case "import":
		err = cmdImport(rest)
	case "pull":
		err = cmdPull(rest)
	case "run":
		err = cmdRun(rest)
	case "cache":
		err = cmdCache(rest)
	default:
		err = fmt.Errorf("unknown command %q\n\nRun 'xecret help' to see available commands", command)
	}

	if err == nil {
		return 0
	}

	var exit exitCodeError
	if errors.As(err, &exit) {
		// The child already said whatever it had to say.
		return exit.code
	}

	fmt.Fprintf(os.Stderr, "xecret: %v\n", err)
	if hint := hintFor(err); hint != "" {
		fmt.Fprintf(os.Stderr, "        %s\n", hint)
	}
	return 1
}

// hintFor adds the "what to do next" line for the errors that have one.
func hintFor(err error) string {
	if errors.Is(err, cred.ErrNotLoggedIn) {
		return ""
	}
	if apiErr, ok := api.AsError(err); ok {
		return apiErr.Hint()
	}
	return ""
}
