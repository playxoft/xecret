package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// Shell completion.
//
// The scripts are generated from one table rather than hand-written per shell,
// so a command added to `dispatch` and forgotten here is a missing completion
// in one place instead of three that disagree.
//
// Nothing here completes a *secret name*: that would mean an API call — and a
// listing request — on every press of the Tab key, against a server that
// rate-limits and audits. Commands, subcommands and flags are static, free,
// and the part people actually mistype.

const completionUsage = `Usage:
  xecret completion bash | zsh | fish

Install it for the current shell:

  # bash — for this session, or append to ~/.bashrc
  source <(xecret completion bash)

  # zsh — needs a directory on $fpath
  xecret completion zsh > "${fpath[1]}/_xecret"

  # fish
  xecret completion fish > ~/.config/fish/completions/xecret.fish
`

type completionCommand struct {
	Name string
	// Description is one short line. No colons: zsh's completion format uses
	// them as a separator, and no apostrophes, because the generated scripts
	// quote with single quotes.
	Description string
	// Flags are the ones *this* command defines, and nothing else. Every
	// command in this CLI builds its own FlagSet, so a flag offered where it is
	// not defined completes to `flag provided but not defined: -project` — a
	// completion that actively breaks the command it was helping to type.
	Flags       []string
	Subcommands []completionCommand
}

// withHelp adds --help, which the flag package answers for every command that
// parses flags at all.
func withHelp(names ...string) []string {
	return append(names, "--help")
}

// scoped adds the two flags that override .xecret.yaml, for the commands that
// read or write secrets in one environment.
func scoped(names ...string) []string {
	return withHelp(append(names, "--project", "--environment")...)
}

// completionTree mirrors `dispatch` and the subcommand switches beneath it —
// names, descriptions and each command's own flags.
var completionTree = []completionCommand{
	{Name: "login", Description: "Authenticate this device via the browser",
		Flags: withHelp("--api-url", "--name")},
	{Name: "logout", Description: "Revoke this device and wipe the offline cache",
		Flags: withHelp()},
	{Name: "whoami", Description: "Show which account and organisation this device uses",
		Flags: withHelp("--json")},
	{Name: "init", Description: "Choose a project and environment for this directory",
		Flags: withHelp("--project", "--environment", "--force")},
	{Name: "orgs", Description: "List your organisations, or switch between them",
		// The bare form is the listing, so the bare form takes the listing's flags.
		Flags: withHelp("--json"),
		Subcommands: []completionCommand{
			{Name: "list", Description: "List your organisations", Flags: withHelp("--json")},
			{Name: "use", Description: "Choose which organisation commands address", Flags: withHelp()},
		}},
	{Name: "projects", Description: "List, create and delete projects",
		Flags: withHelp("--json"),
		Subcommands: []completionCommand{
			{Name: "list", Description: "List projects", Flags: withHelp("--json")},
			{Name: "create", Description: "Create a project and its default environments",
				Flags: withHelp("--json", "--slug", "--description")},
			{Name: "delete", Description: "Soft-delete a project", Flags: withHelp("--yes")},
		}},
	{Name: "environments", Description: "List, create and delete environments",
		Flags: withHelp("--json", "--project"),
		Subcommands: []completionCommand{
			{Name: "list", Description: "List environments", Flags: withHelp("--json", "--project")},
			{Name: "create", Description: "Create an environment and its key",
				Flags: withHelp("--json", "--slug", "--production", "--project")},
			{Name: "delete", Description: "Soft-delete an environment",
				Flags: withHelp("--yes", "--project")},
		}},
	{Name: "secrets", Description: "Read and write secrets",
		// The bare form prints usage, but a leading flag means the listing —
		// so these are the listing's flags.
		Flags: scoped("--json"),
		Subcommands: []completionCommand{
			{Name: "list", Description: "Masked listing", Flags: scoped("--json")},
			{Name: "get", Description: "Show metadata, or reveal a value with --plain",
				Flags: scoped("--json", "--plain", "--version")},
			{Name: "set", Description: "Write a value as a new version",
				Flags: scoped("--type", "--note", "--from-file", "--generate")},
			{Name: "annotate", Description: "Change name, note or type without a new version",
				Flags: scoped("--note", "--type", "--rename")},
			{Name: "versions", Description: "Version history, metadata only", Flags: scoped("--json")},
			{Name: "restore", Description: "Re-append an earlier version as the current one",
				Flags: scoped("--version")},
			{Name: "delete", Description: "Soft-delete a secret", Flags: scoped("--yes")},
		}},
	{Name: "import", Description: "Send a .env, JSON, YAML or shell file to the server",
		Flags: scoped("--json", "--format", "--strategy", "--dry-run")},
	{Name: "pull", Description: "Print every secret in a chosen format",
		Flags: scoped("--format", "-o")},
	{Name: "export", Description: "Write every secret to a file",
		Flags: scoped("--format", "-o", "--force")},
	{Name: "run", Description: "Run a command with secrets injected",
		Flags: scoped("--offline", "--no-cache")},
	{Name: "audit", Description: "Read the organisation audit log",
		Flags: scoped("--json", "--action", "--outcome", "--since", "--until", "--limit")},
	{Name: "members", Description: "List who is in the organisation",
		Flags: withHelp("--json")},
	{Name: "tokens", Description: "List and revoke credentials",
		Flags: withHelp("--json", "--kind"),
		Subcommands: []completionCommand{
			{Name: "list", Description: "List devices and service tokens",
				Flags: withHelp("--json", "--kind")},
			{Name: "revoke", Description: "Revoke one credential", Flags: withHelp("--kind", "--yes")},
		}},
	{Name: "cache", Description: "Manage the encrypted offline cache",
		Flags: withHelp(),
		Subcommands: []completionCommand{
			{Name: "clear", Description: "Remove every offline copy and its key"},
		}},
	{Name: "doctor", Description: "Check this machine setup", Flags: withHelp("--json")},
	{Name: "upgrade", Description: "Check whether a newer CLI is published", Flags: withHelp("--json")},
	{Name: "completion", Description: "Print a shell completion script",
		Flags: withHelp(),
		Subcommands: []completionCommand{
			{Name: "bash", Description: "bash completion"},
			{Name: "zsh", Description: "zsh completion"},
			{Name: "fish", Description: "fish completion"},
		}},
	{Name: "version", Description: "Print version information"},
	{Name: "help", Description: "Show help"},
}

// rootFlags are what `xecret --<TAB>` offers, before any command is named.
var rootFlags = []string{"--help", "--version"}

func cmdCompletion(args []string) error {
	flags := flag.NewFlagSet("completion", flag.ContinueOnError)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	if len(positional) == 0 {
		_, _ = io.WriteString(os.Stdout, completionUsage)
		return nil
	}

	switch positional[0] {
	case "bash":
		_, _ = io.WriteString(os.Stdout, bashCompletion())
	case "zsh":
		_, _ = io.WriteString(os.Stdout, zshCompletion())
	case "fish":
		_, _ = io.WriteString(os.Stdout, fishCompletion())
	case "help", "--help", "-h":
		_, _ = io.WriteString(os.Stdout, completionUsage)
	default:
		return fmt.Errorf("no completion for %q — xecret supports bash, zsh and fish", positional[0])
	}
	return nil
}

func topLevelNames() []string {
	names := make([]string, len(completionTree))
	for i, command := range completionTree {
		names[i] = command.Name
	}
	return names
}

func bashCompletion() string {
	var b strings.Builder
	b.WriteString("# bash completion for xecret. Generated by 'xecret completion bash'.\n")
	b.WriteString("_xecret_complete() {\n")
	b.WriteString("  local current=\"${COMP_WORDS[COMP_CWORD]}\"\n")
	b.WriteString("  local first=\"\" second=\"\"\n")
	b.WriteString("  (( COMP_CWORD >= 1 )) && first=\"${COMP_WORDS[1]}\"\n")
	b.WriteString("  (( COMP_CWORD >= 2 )) && second=\"${COMP_WORDS[2]}\"\n\n")

	// Flags are answered per (command, subcommand), most specific first. When
	// the current word *is* the second one — `xecret secrets --<TAB>` — the pair
	// matches nothing and the command's own list answers, which is right.
	b.WriteString("  if [[ \"$current\" == -* ]]; then\n")
	b.WriteString("    local flags=\"\"\n")
	b.WriteString("    if (( COMP_CWORD == 1 )); then\n")
	b.WriteString("      flags=\"" + strings.Join(rootFlags, " ") + "\"\n")
	b.WriteString("    else\n")
	b.WriteString("      case \"$first $second\" in\n")
	for _, command := range completionTree {
		for _, sub := range command.Subcommands {
			if len(sub.Flags) == 0 {
				continue
			}
			b.WriteString("        \"" + command.Name + " " + sub.Name + "\") flags=\"" +
				strings.Join(sub.Flags, " ") + "\" ;;\n")
		}
	}
	b.WriteString("      esac\n")
	b.WriteString("      if [[ -z \"$flags\" ]]; then\n")
	b.WriteString("        case \"$first\" in\n")
	for _, command := range completionTree {
		if len(command.Flags) == 0 {
			continue
		}
		b.WriteString("          " + command.Name + ") flags=\"" +
			strings.Join(command.Flags, " ") + "\" ;;\n")
	}
	b.WriteString("        esac\n")
	b.WriteString("      fi\n")
	b.WriteString("    fi\n")
	b.WriteString("    COMPREPLY=( $(compgen -W \"$flags\" -- \"$current\") )\n")
	b.WriteString("    return\n")
	b.WriteString("  fi\n\n")
	b.WriteString("  if [[ $COMP_CWORD -eq 1 ]]; then\n")
	b.WriteString("    COMPREPLY=( $(compgen -W \"" + strings.Join(topLevelNames(), " ") + "\" -- \"$current\") )\n")
	b.WriteString("    return\n")
	b.WriteString("  fi\n\n")
	b.WriteString("  if [[ $COMP_CWORD -eq 2 ]]; then\n")
	b.WriteString("    case \"${COMP_WORDS[1]}\" in\n")
	for _, command := range completionTree {
		if len(command.Subcommands) == 0 {
			continue
		}
		names := make([]string, len(command.Subcommands))
		for i, sub := range command.Subcommands {
			names[i] = sub.Name
		}
		b.WriteString("      " + command.Name + ") COMPREPLY=( $(compgen -W \"" +
			strings.Join(names, " ") + "\" -- \"$current\") ) ;;\n")
	}
	b.WriteString("    esac\n")
	b.WriteString("    return\n")
	b.WriteString("  fi\n")
	b.WriteString("}\n")
	b.WriteString("complete -F _xecret_complete xecret\n")
	return b.String()
}

func zshCompletion() string {
	var b strings.Builder
	b.WriteString("#compdef xecret\n")
	b.WriteString("# zsh completion for xecret. Generated by 'xecret completion zsh'.\n\n")
	b.WriteString("_xecret() {\n")
	b.WriteString("  local -a commands\n")
	b.WriteString("  commands=(\n")
	for _, command := range completionTree {
		b.WriteString(fmt.Sprintf("    '%s:%s'\n", command.Name, command.Description))
	}
	b.WriteString("  )\n\n")
	b.WriteString("  if (( CURRENT == 2 )); then\n")
	b.WriteString("    if [[ ${words[2]} == -* ]]; then\n")
	b.WriteString("      _values 'flag' " + strings.Join(quoteAll(rootFlags), " ") + "\n")
	b.WriteString("    else\n")
	b.WriteString("      _describe -t commands 'xecret command' commands\n")
	b.WriteString("    fi\n")
	b.WriteString("    return\n")
	b.WriteString("  fi\n\n")
	b.WriteString("  local -a subcommands\n")
	b.WriteString("  case ${words[2]} in\n")
	for _, command := range completionTree {
		if len(command.Subcommands) == 0 {
			continue
		}
		b.WriteString("    " + command.Name + ")\n      subcommands=(\n")
		for _, sub := range command.Subcommands {
			b.WriteString(fmt.Sprintf("        '%s:%s'\n", sub.Name, sub.Description))
		}
		b.WriteString("      )\n      ;;\n")
	}
	b.WriteString("  esac\n\n")
	// A word already starting with a dash is a flag, not a subcommand, however
	// early in the line it appears.
	b.WriteString("  if (( CURRENT == 3 )) && (( ${#subcommands} )) && [[ ${words[3]} != -* ]]; then\n")
	b.WriteString("    _describe -t subcommands 'subcommand' subcommands\n")
	b.WriteString("    return\n")
	b.WriteString("  fi\n\n")

	b.WriteString("  local -a flags\n")
	b.WriteString("  flags=()\n")
	b.WriteString("  case \"${words[2]} ${words[3]}\" in\n")
	for _, command := range completionTree {
		for _, sub := range command.Subcommands {
			if len(sub.Flags) == 0 {
				continue
			}
			b.WriteString("    '" + command.Name + " " + sub.Name + "') flags=( " +
				strings.Join(quoteAll(sub.Flags), " ") + " ) ;;\n")
		}
	}
	b.WriteString("  esac\n")
	b.WriteString("  if (( ! ${#flags} )); then\n")
	b.WriteString("    case ${words[2]} in\n")
	for _, command := range completionTree {
		if len(command.Flags) == 0 {
			continue
		}
		b.WriteString("      " + command.Name + ") flags=( " +
			strings.Join(quoteAll(command.Flags), " ") + " ) ;;\n")
	}
	b.WriteString("    esac\n")
	b.WriteString("  fi\n")
	b.WriteString("  (( ${#flags} )) && _values 'flag' $flags\n")
	b.WriteString("}\n\n")
	b.WriteString("compdef _xecret xecret\n")
	return b.String()
}

func fishCompletion() string {
	var b strings.Builder
	b.WriteString("# fish completion for xecret. Generated by 'xecret completion fish'.\n")
	// -f: no file completion by default. A command taking a path (import,
	// secrets set --from-file) re-enables it below.
	b.WriteString("complete -c xecret -f\n")

	for _, command := range completionTree {
		b.WriteString(fmt.Sprintf("complete -c xecret -n '__fish_use_subcommand' -a %s -d '%s'\n",
			command.Name, command.Description))
	}
	for _, command := range completionTree {
		for _, sub := range command.Subcommands {
			b.WriteString(fmt.Sprintf(
				"complete -c xecret -n '__fish_seen_subcommand_from %s; and not __fish_seen_subcommand_from %s' -a %s -d '%s'\n",
				command.Name, strings.Join(subcommandNames(command), " "), sub.Name, sub.Description))
		}
	}
	b.WriteString("complete -c xecret -n '__fish_seen_subcommand_from import' -F\n")

	// One condition per command, so no command is offered a flag it does not
	// define.
	//
	// The parent's rule has to exclude its own subcommands. `__fish_seen_subcommand_from`
	// matches anywhere on the line, so a bare `-n '…from secrets'` stays true
	// inside `secrets set` too — and would go on offering `--json`, which
	// `secrets set` does not define. bash and zsh get this for free because
	// their most-specific case arm wins; fish evaluates every rule.
	for _, command := range completionTree {
		notASubcommand := ""
		if names := subcommandNames(command); len(names) > 0 {
			notASubcommand = "; and not __fish_seen_subcommand_from " + strings.Join(names, " ")
		}
		for _, flagName := range command.Flags {
			b.WriteString(fmt.Sprintf("complete -c xecret -n '__fish_seen_subcommand_from %s%s' %s\n",
				command.Name, notASubcommand, fishFlag(flagName)))
		}
		for _, sub := range command.Subcommands {
			for _, flagName := range sub.Flags {
				b.WriteString(fmt.Sprintf(
					"complete -c xecret -n '__fish_seen_subcommand_from %s; and __fish_seen_subcommand_from %s' %s\n",
					command.Name, sub.Name, fishFlag(flagName)))
			}
		}
	}
	// Before any command is named, the root flags.
	for _, flagName := range rootFlags {
		b.WriteString(fmt.Sprintf("complete -c xecret -n '__fish_use_subcommand' %s\n", fishFlag(flagName)))
	}
	return b.String()
}

// fishFlag spells one flag the way `complete` wants it: -l for a long name,
// -s for the single-character ones (`pull -o`), which Go's flag package
// accepts with one dash.
func fishFlag(name string) string {
	if long, found := strings.CutPrefix(name, "--"); found {
		return "-l " + long
	}
	return "-s " + strings.TrimPrefix(name, "-")
}

func subcommandNames(command completionCommand) []string {
	names := make([]string, len(command.Subcommands))
	for i, sub := range command.Subcommands {
		names[i] = sub.Name
	}
	return names
}

func quoteAll(values []string) []string {
	quoted := make([]string, len(values))
	for i, value := range values {
		quoted[i] = "'" + value + "'"
	}
	return quoted
}
