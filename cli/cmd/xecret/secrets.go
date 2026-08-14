package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/output"
)

// secretNamePattern mirrors the server's constraint, so an impossible name
// fails here with a sentence instead of there with a 404.
var secretNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

const secretsUsage = `Usage:
  xecret secrets list   [--json]
  xecret secrets get    <NAME> [--plain] [--json]
  xecret secrets set    <NAME> [--type TYPE] [--note TEXT]   (value from stdin or prompt)
  xecret secrets delete <NAME> [--yes]

All subcommands accept --project and --environment to override .xecret.yaml.

The value for 'set' is never taken from the command line — an argument would
land in shell history and 'ps' output. Pipe it in, or type it at the hidden
prompt:

  printf '%s' "$VALUE" | xecret secrets set DATABASE_URL

'get' prints metadata; only 'get --plain' prints the value (audited server-side).
`

func cmdSecrets(args []string) error {
	if len(args) == 0 {
		_, _ = io.WriteString(os.Stdout, secretsUsage)
		return nil
	}

	switch args[0] {
	case "list":
		return secretsList(args[1:])
	case "get":
		return secretsGet(args[1:])
	case "set":
		return secretsSet(args[1:])
	case "delete":
		return secretsDelete(args[1:])
	case "help", "--help", "-h":
		_, _ = io.WriteString(os.Stdout, secretsUsage)
		return nil
	default:
		return fmt.Errorf("unknown secrets subcommand %q — run 'xecret secrets help'", args[0])
	}
}

// scopedFlags declares the flags every secrets subcommand shares.
func scopedFlags(flags *flag.FlagSet) (project, environment *string) {
	project = flags.String("project", "", "project slug (default: .xecret.yaml)")
	environment = flags.String("environment", "", "environment slug (default: .xecret.yaml)")
	return project, environment
}

func secretsList(args []string) error {
	flags := flag.NewFlagSet("secrets list", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	projectFlag, envFlag := scopedFlags(flags)
	if err := flags.Parse(args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	secrets, err := client.Secrets(ctx, resolved.Org, resolved.Project, resolved.Environment)
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(secrets)
	}

	if len(secrets) == 0 {
		a.printer.Infof("No secrets in %s/%s yet. Add one with 'xecret secrets set NAME' or 'xecret import .env'.",
			resolved.Project, resolved.Environment)
		return nil
	}

	rows := make([][]string, len(secrets))
	for i, secret := range secrets {
		rows[i] = []string{
			secret.Name,
			secret.ValueType,
			fmt.Sprintf("v%d", secret.Version),
			shortTime(secret.UpdatedAt),
		}
	}
	a.printer.Table([]string{"name", "type", "version", "updated"}, rows)
	return nil
}

// secretsGet prints metadata by default. `--plain` prints the value itself —
// the explicit, audited act; there is no way to do it by accident.
func secretsGet(args []string) error {
	flags := flag.NewFlagSet("secrets get", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	plain := flags.Bool("plain", false, "print the decrypted value to stdout (audited)")
	projectFlag, envFlag := scopedFlags(flags)
	if err := flags.Parse(args); err != nil {
		return err
	}
	name, err := oneName(flags.Args())
	if err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if *plain {
		revealed, err := client.Reveal(ctx, resolved.Org, resolved.Project, resolved.Environment, name)
		if err != nil {
			return err
		}
		if a.printer.JSON {
			return a.printer.WriteJSON(map[string]string{"name": revealed.Name, "value": revealed.Value})
		}
		// Raw, plus the trailing newline every POSIX tool emits; `$(…)`
		// substitution strips it. This is one of the two sanctioned places a
		// value reaches stdout.
		fmt.Fprintln(a.printer.Out, revealed.Value)
		return nil
	}

	// Metadata comes from the masked listing, so asking about a secret does
	// not decrypt it and writes no `secret.revealed` audit record.
	secrets, err := client.Secrets(ctx, resolved.Org, resolved.Project, resolved.Environment)
	if err != nil {
		return err
	}
	for _, secret := range secrets {
		if secret.Name != name {
			continue
		}
		if a.printer.JSON {
			return a.printer.WriteJSON(secret)
		}
		fmt.Fprintf(a.printer.Out, "Name      %s\n", secret.Name)
		fmt.Fprintf(a.printer.Out, "Type      %s\n", secret.ValueType)
		fmt.Fprintf(a.printer.Out, "Version   v%d\n", secret.Version)
		fmt.Fprintf(a.printer.Out, "Updated   %s\n", shortTime(secret.UpdatedAt))
		if secret.Note != nil && *secret.Note != "" {
			fmt.Fprintf(a.printer.Out, "Note      %s\n", *secret.Note)
		}
		a.printer.Infof("The value stays masked — 'xecret secrets get %s --plain' reveals it.", name)
		return nil
	}
	return fmt.Errorf("no secret named %q in %s/%s", name, resolved.Project, resolved.Environment)
}

func secretsSet(args []string) error {
	flags := flag.NewFlagSet("secrets set", flag.ContinueOnError)
	valueType := flags.String("type", "", "declared value type (string, int, url, …)")
	note := flags.String("note", "", "note shown beside the secret in the dashboard")
	projectFlag, envFlag := scopedFlags(flags)
	if err := flags.Parse(args); err != nil {
		return err
	}
	name, err := oneName(flags.Args())
	if err != nil {
		return err
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	value, err := readSecretValue(a, name)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Create, and on "already exists" append a version instead. Two calls in
	// the worst case, but the create path stays the same one the dashboard
	// uses, and the server's unique index remains the arbiter of the race.
	result, err := client.CreateSecret(ctx,
		resolved.Org, resolved.Project, resolved.Environment, name, value, *valueType, *note)
	if apiErr, ok := api.AsError(err); ok && apiErr.Code == "conflict" {
		result, err = client.UpdateSecret(ctx,
			resolved.Org, resolved.Project, resolved.Environment, name, value, *valueType)
	}
	if err != nil {
		return err
	}

	switch result.Status {
	case "unchanged":
		a.printer.Successf("%s is already at that value (v%d) — nothing written.", name, result.Version)
	case "created":
		a.printer.Successf("Created %s (v%d) in %s/%s.", name, result.Version, resolved.Project, resolved.Environment)
	default:
		a.printer.Successf("Updated %s to v%d in %s/%s.", name, result.Version, resolved.Project, resolved.Environment)
	}
	return nil
}

func secretsDelete(args []string) error {
	flags := flag.NewFlagSet("secrets delete", flag.ContinueOnError)
	yes := flags.Bool("yes", false, "skip the confirmation prompt")
	projectFlag, envFlag := scopedFlags(flags)
	if err := flags.Parse(args); err != nil {
		return err
	}
	name, err := oneName(flags.Args())
	if err != nil {
		return err
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	if !*yes {
		if !output.StdoutIsTerminal() {
			return errors.New("refusing to delete without confirmation — pass --yes in scripts")
		}
		fmt.Fprintf(a.printer.Err, "Delete %s from %s/%s? Type the secret name to confirm: ",
			name, resolved.Project, resolved.Environment)
		reader := bufio.NewReader(os.Stdin)
		line, readErr := reader.ReadString('\n')
		if readErr != nil || strings.TrimSpace(line) != name {
			return errors.New("confirmation did not match; nothing deleted")
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := client.DeleteSecret(ctx, resolved.Org, resolved.Project, resolved.Environment, name); err != nil {
		return err
	}
	a.printer.Successf("Deleted %s from %s/%s. Versions are retained; the dashboard can restore them.",
		name, resolved.Project, resolved.Environment)
	return nil
}

// readSecretValue takes the value from a pipe when stdin is one, otherwise
// from a hidden prompt. Never from an argument — see the usage text.
func readSecretValue(a *app, name string) (string, error) {
	stat, err := os.Stdin.Stat()
	if err == nil && stat.Mode()&os.ModeCharDevice == 0 {
		data, readErr := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
		if readErr != nil {
			return "", readErr
		}
		// One trailing newline is the pipe's framing, not the value. Exactly
		// one: stripping more would corrupt a value that ends in blank lines.
		value := strings.TrimSuffix(string(data), "\n")
		value = strings.TrimSuffix(value, "\r")
		if value == "" {
			return "", errors.New("stdin was empty — pipe the value in, or run interactively for a prompt")
		}
		return value, nil
	}

	fmt.Fprintf(a.printer.Err, "Value for %s (input hidden): ", name)
	raw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(a.printer.Err)
	if err != nil {
		return "", errors.New("could not read the value from the terminal")
	}
	if len(raw) == 0 {
		return "", errors.New("empty value; nothing written")
	}
	return string(raw), nil
}

func oneName(positional []string) (string, error) {
	if len(positional) != 1 {
		return "", errors.New("expected exactly one secret name")
	}
	name := positional[0]
	if !secretNamePattern.MatchString(name) || len(name) > 255 {
		return "", fmt.Errorf("%q is not a valid secret name (letters, digits and _, not starting with a digit)", name)
	}
	return name, nil
}

// shortTime renders an ISO timestamp as a compact local time.
func shortTime(iso string) string {
	parsed, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return iso
	}
	return parsed.Local().Format("2006-01-02 15:04")
}
