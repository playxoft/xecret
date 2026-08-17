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
	Subcommands []completionCommand
}

// completionTree mirrors `dispatch` and the subcommand switches beneath it.
var completionTree = []completionCommand{
	{Name: "login", Description: "Authenticate this device via the browser"},
	{Name: "logout", Description: "Revoke this device and wipe the offline cache"},
	{Name: "whoami", Description: "Show which account and organisation this device uses"},
	{Name: "init", Description: "Choose a project and environment for this directory"},
	{Name: "orgs", Description: "List your organisations, or switch between them", Subcommands: []completionCommand{
		{Name: "list", Description: "List your organisations"},
		{Name: "use", Description: "Choose which organisation commands address"},
	}},
	{Name: "projects", Description: "List, create and delete projects", Subcommands: []completionCommand{
		{Name: "list", Description: "List projects"},
		{Name: "create", Description: "Create a project and its default environments"},
		{Name: "delete", Description: "Soft-delete a project"},
	}},
	{Name: "environments", Description: "List, create and delete environments", Subcommands: []completionCommand{
		{Name: "list", Description: "List environments"},
		{Name: "create", Description: "Create an environment and its key"},
		{Name: "delete", Description: "Soft-delete an environment"},
	}},
	{Name: "secrets", Description: "Read and write secrets", Subcommands: []completionCommand{
		{Name: "list", Description: "Masked listing"},
		{Name: "get", Description: "Show metadata, or reveal a value with --plain"},
		{Name: "set", Description: "Write a value as a new version"},
		{Name: "annotate", Description: "Change name, note or type without a new version"},
		{Name: "versions", Description: "Version history, metadata only"},
		{Name: "restore", Description: "Re-append an earlier version as the current one"},
		{Name: "delete", Description: "Soft-delete a secret"},
	}},
	{Name: "import", Description: "Send a .env, JSON, YAML or shell file to the server"},
	{Name: "pull", Description: "Print every secret in a chosen format"},
	{Name: "export", Description: "Write every secret to a file"},
	{Name: "run", Description: "Run a command with secrets injected"},
	{Name: "audit", Description: "Read the organisation audit log"},
	{Name: "members", Description: "List who is in the organisation"},
	{Name: "tokens", Description: "List and revoke credentials", Subcommands: []completionCommand{
		{Name: "list", Description: "List devices and service tokens"},
		{Name: "revoke", Description: "Revoke one credential"},
	}},
	{Name: "cache", Description: "Manage the encrypted offline cache", Subcommands: []completionCommand{
		{Name: "clear", Description: "Remove every offline copy and its key"},
	}},
	{Name: "doctor", Description: "Check this machine setup"},
	{Name: "upgrade", Description: "Check whether a newer CLI is published"},
	{Name: "completion", Description: "Print a shell completion script", Subcommands: []completionCommand{
		{Name: "bash", Description: "bash completion"},
		{Name: "zsh", Description: "zsh completion"},
		{Name: "fish", Description: "fish completion"},
	}},
	{Name: "version", Description: "Print version information"},
	{Name: "help", Description: "Show help"},
}

// commonFlags are offered whenever the current word starts with a dash. Kept
// short deliberately: the flags every scoped command shares, plus the two that
// change what the output is for.
var commonFlags = []string{"--project", "--environment", "--json", "--help"}

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
	b.WriteString("  local flags=\"" + strings.Join(commonFlags, " ") + "\"\n\n")
	b.WriteString("  if [[ \"$current\" == -* ]]; then\n")
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
	b.WriteString("    _describe -t commands 'xecret command' commands\n")
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
	b.WriteString("  if (( CURRENT == 3 )) && (( ${#subcommands} )); then\n")
	b.WriteString("    _describe -t subcommands 'subcommand' subcommands\n")
	b.WriteString("    return\n")
	b.WriteString("  fi\n\n")
	b.WriteString("  _values 'flag' " + strings.Join(quoteAll(commonFlags), " ") + "\n")
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
	for _, flagName := range commonFlags {
		b.WriteString(fmt.Sprintf("complete -c xecret -l %s\n", strings.TrimPrefix(flagName, "--")))
	}
	return b.String()
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
