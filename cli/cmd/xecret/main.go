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
	"flag"
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
  orgs         list | use — which organisation the other commands address

Project setup:
  init         Choose a project and environment; writes .xecret.yaml
  projects     list | create | delete
  environments list | create | delete

Working with secrets:
  secrets      list | get | set | annotate | versions | restore | delete
  import       Send a .env, JSON, YAML or shell file to the server
  pull         Print every secret in a chosen format   (env|json|yaml|shell|docker)
  export       Write every secret to a file            (same formats)
  run          Run a command with secrets injected:  xecret run -- npm run dev

Administration:
  audit        Read the organisation's audit log
  members      List who is in the organisation
  tokens       list | revoke — devices and CI service tokens

Housekeeping:
  cache        clear — remove the encrypted offline cache
  completion   Print a shell completion script  (bash|zsh|fish)
  doctor       Check this machine's setup and say what is wrong
  upgrade      Check whether a newer CLI has been published
  version      Print version information
  help         Show this help

Flags every command that reads secrets accepts:
  --project, --environment   Override .xecret.yaml
  --json                     Machine-readable output (where it applies)

CI:
  XECRET_TOKEN=xst_...       Authenticate with a service token — no login, no
                             keychain, no cache. The token's own scope fills in
                             the project and environment when no flags or
                             .xecret.yaml say otherwise.

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
	case "orgs", "organizations", "organisations":
		err = cmdOrgs(rest)
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
	case "export":
		err = cmdExport(rest)
	case "run":
		err = cmdRun(rest)
	case "audit":
		err = cmdAudit(rest)
	case "members":
		err = cmdMembers(rest)
	case "tokens":
		err = cmdTokens(rest)
	case "cache":
		err = cmdCache(rest)
	case "completion":
		err = cmdCompletion(rest)
	case "doctor":
		err = cmdDoctor(rest)
	case "upgrade":
		err = cmdUpgrade(rest)
	default:
		err = fmt.Errorf("unknown command %q\n\nRun 'xecret help' to see available commands", command)
	}

	if err == nil {
		return 0
	}

	// `xecret secrets get --help`: the flag package has already printed the
	// defaults to stderr, and its sentinel is not a failure. Without this the
	// documented way to see one command's flags ends in "flag: help requested"
	// and a non-zero exit.
	if errors.Is(err, flag.ErrHelp) {
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

// parseFlags parses a command's flags wherever they appear and returns the
// positional arguments.
//
// Go's flag package stops at the first argument that is not a flag, so
// `xecret secrets get API_KEY --plain` would leave `--plain` sitting in the
// positional list, unparsed and silently ignored — and every documented
// example in this CLI puts the name first. Rather than teach users an argument
// order nothing else in their shell requires, this walks the list: parse,
// take the one positional that stopped it, parse the rest, repeat. Values set
// on earlier passes survive, because a FlagSet accumulates.
//
// Anything after a bare `--` is positional by definition and is set aside
// before the walk begins, so a terminator still means what it means everywhere
// else. (`run` has its own, earlier split: everything after `--` there belongs
// to the child process, flags included.)
func parseFlags(flags *flag.FlagSet, args []string) ([]string, error) {
	var literal []string
	for i, arg := range args {
		if arg == "--" {
			literal = append(literal, args[i+1:]...)
			args = args[:i]
			break
		}
	}

	var positional []string
	for {
		if err := flags.Parse(args); err != nil {
			return nil, err
		}
		rest := flags.Args()
		if len(rest) == 0 {
			break
		}
		positional = append(positional, rest[0])
		args = rest[1:]
	}
	return append(positional, literal...), nil
}

// hintFor adds the "what to do next" line for the errors that have one.
func hintFor(err error) string {
	if errors.Is(err, cred.ErrNotLoggedIn) {
		return ""
	}
	if apiErr, ok := api.AsError(err); ok {
		// Under XECRET_TOKEN the stored-login hints would mislead: there is no
		// login to run and no device to re-authenticate.
		if serviceTokenFromEnv() != "" {
			switch apiErr.Status {
			case 401:
				return "XECRET_TOKEN was not accepted. Check the value, its expiry, and any IP allowlist."
			case 403:
				return "This service token cannot do that — it may be read-only, or the action may be reserved for people."
			}
		}
		return apiErr.Hint()
	}
	return ""
}
