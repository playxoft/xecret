package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
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
  xecret secrets list     [--json]
  xecret secrets get      <NAME> [--version N] [--plain] [--json]
  xecret secrets set      <NAME> [--type TYPE] [--note TEXT] [--from-file PATH] [--generate[=BYTES]]
  xecret secrets annotate <NAME> [--note TEXT] [--type TYPE] [--rename NEW]
  xecret secrets versions <NAME> [--json]
  xecret secrets restore  <NAME> --version N
  xecret secrets delete   <NAME> [--yes]

All subcommands accept --project and --environment to override .xecret.yaml.
'xecret secrets' with no argument prints this; with a flag first — 'xecret
secrets --json' — it lists.

The value for 'set' is never taken from the command line — an argument would
land in shell history and 'ps' output. Pipe it in, read it from a file, have
one generated, or type it at the hidden prompt:

  printf '%s' "$VALUE" | xecret secrets set DATABASE_URL
  xecret secrets set SERVICE_ACCOUNT --from-file key.json
  xecret secrets set SESSION_SECRET --generate

'get' prints metadata; only 'get --plain' prints the value (audited server-side).

'set' appends a version; 'annotate' changes what is *said* about a secret — its
name, note or declared type — and appends none. Declaring PORT an integer is
not a rotation, and the version number has to keep meaning "when did this
credential last actually change?".

'versions' is metadata only, deliberately: a rotated secret usually still works
at the provider it belongs to, so a history that handed back values would be a
page of live credentials. Reading the past is 'get --version N' or 'restore',
one at a time, each audited.
`

func cmdSecrets(args []string) error {
	switch subcommand(args, "help") {
	case "list":
		return secretsList(listArgs(args))
	case "get":
		return secretsGet(args[1:])
	case "set":
		return secretsSet(args[1:])
	case "annotate":
		return secretsAnnotate(args[1:])
	case "versions":
		return secretsVersions(args[1:])
	case "restore":
		return secretsRestore(args[1:])
	case "delete":
		return secretsDelete(args[1:])
	case "help":
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
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, *envFlag)
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
	version := flags.Int("version", 0, "reveal an earlier version instead of the current one")
	projectFlag, envFlag := scopedFlags(flags)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	name, err := oneName(positional)
	if err != nil {
		return err
	}
	if *version < 0 {
		return errors.New("a version is a positive number — 'xecret secrets versions NAME' lists them")
	}
	if *version > 0 && !*plain {
		// The metadata of every version is already in the history listing, so
		// the only thing this request could add is the value. Requiring --plain
		// keeps "I am about to reveal a live credential" an explicit act rather
		// than a side effect of adding a flag.
		return fmt.Errorf(
			"--version reveals a value, so it requires --plain; 'xecret secrets versions %s' lists the history", name)
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if *plain && *version > 0 {
		revealed, err := client.RevealVersion(
			ctx, resolved.Org, resolved.Project, resolved.Environment, name, *version)
		if err != nil {
			return err
		}
		if !revealed.Current {
			// Said before the value is printed, because it is the thing most
			// likely to be got wrong: an old version is usually still live at
			// the provider that issued it, and pasting one back into a config
			// is a rollback nobody recorded.
			a.printer.Warnf("v%d is not the current version — it may still be live at whoever issued it.", revealed.Version)
		}
		if a.printer.JSON {
			return a.printer.WriteJSON(map[string]any{
				"name": revealed.Name, "value": revealed.Value, "version": revealed.Version,
			})
		}
		fmt.Fprintln(a.printer.Out, revealed.Value)
		return nil
	}

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
	fromFile := flags.String("from-file", "", "read the value from a file instead of stdin")
	var generate optionalInt
	flags.Var(&generate, "generate", "generate a random value; --generate=BYTES sets the length (default 32)")
	projectFlag, envFlag := scopedFlags(flags)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	// `--generate 48` cannot bind, because IsBoolFlag makes `--generate` a
	// standalone flag — the number lands here as an extra positional instead.
	// Said plainly, rather than left to oneName's "expected exactly one secret
	// name", which names neither the flag nor the fix. Any position, because
	// parseFlags accepts flags anywhere and `set --generate 48 FOO` is as
	// natural an ordering as `set FOO --generate 48`.
	if generate.set && generate.value == 0 {
		for _, argument := range positional {
			// A secret name can never be all digits — secretNamePattern forbids
			// a leading one — so a numeric positional here is only ever the
			// length that failed to bind.
			if _, numeric := strconv.Atoi(argument); numeric == nil {
				return fmt.Errorf(
					"write --generate=%s; the length attaches with '=' because --generate also stands alone", argument)
			}
		}
	}
	name, err := oneName(positional)
	if err != nil {
		return err
	}
	if generate.set && *fromFile != "" {
		return errors.New("--generate and --from-file both supply the value; pass one")
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	value, err := secretValueFrom(a, name, *fromFile, generate)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Create, and on "already exists" append a version instead. Two calls in
	// the worst case, but the create path stays the same one the dashboard
	// uses, and the server's unique index remains the arbiter of the race.
	appended := false
	result, err := client.CreateSecret(ctx,
		resolved.Org, resolved.Project, resolved.Environment, name, value, *valueType, *note)
	if apiErr, ok := api.AsError(err); ok && apiErr.Code == "conflict" {
		appended = true
		result, err = client.UpdateSecret(ctx,
			resolved.Org, resolved.Project, resolved.Environment, name, value, *valueType)
	}
	if err != nil {
		return err
	}

	// A note travels with a *creation* and nowhere else: it lives on the secret
	// rather than on the version, so the server's version-append body has no
	// field for it and would discard one silently. Applying it through the
	// metadata route costs a second request on a path that already made two,
	// and the alternative is a note the user typed and never got.
	var noteErr error
	if appended && *note != "" {
		if _, metaErr := client.UpdateMetadata(ctx,
			resolved.Org, resolved.Project, resolved.Environment, name,
			api.MetadataUpdate{Note: note},
		); metaErr != nil {
			noteErr = metaErr
		}
	}

	switch result.Status {
	case "unchanged":
		a.printer.Successf("%s is already at that value (v%d) — nothing written.", name, result.Version)
	case "created":
		a.printer.Successf("Created %s (v%d) in %s/%s.", name, result.Version, resolved.Project, resolved.Environment)
	default:
		a.printer.Successf("Updated %s to v%d in %s/%s.", name, result.Version, resolved.Project, resolved.Environment)
	}

	if generate.set {
		// Nobody has seen this value, including the person who created it. Say
		// where it can be read from, once, rather than printing it here and
		// putting it in the terminal's scrollback for the sake of convenience.
		a.printer.Infof("The generated value was never printed — 'xecret secrets get %s --plain' reveals it.", name)
	}

	if noteErr != nil {
		// The value landed; only the note did not. Which is which is said above,
		// and the exit code has to carry it too: `xecret secrets set … --note …
		// && deploy` must not read a half-applied write as success.
		return fmt.Errorf("%s is at v%d, but the note was not applied: %w — retry with 'xecret secrets annotate %s --note …'",
			name, result.Version, noteErr, name)
	}
	return nil
}

func secretsDelete(args []string) error {
	flags := flag.NewFlagSet("secrets delete", flag.ContinueOnError)
	yes := flags.Bool("yes", false, "skip the confirmation prompt")
	projectFlag, envFlag := scopedFlags(flags)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	name, err := oneName(positional)
	if err != nil {
		return err
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	if err := confirmDestructive(a, *yes, name,
		fmt.Sprintf("Delete %s from %s/%s?", name, resolved.Project, resolved.Environment)); err != nil {
		return err
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

// readSecretValue prompts when there is a terminal to prompt, and otherwise
// reads whatever stdin is. Never from an argument — see the usage text.
//
// The test is term.IsTerminal, not the ModeCharDevice one it used to be:
// /dev/null is a character device, so under `docker run` without -i, under
// cron, and under a systemd unit this printed a hidden prompt into the void and
// then reported "could not read the value from the terminal". Reading /dev/null
// instead reaches the empty-stdin message, which is the true one.
func readSecretValue(a *app, name string) (string, error) {
	if !output.StdinIsTerminal() {
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

// maxSecretValueBytes mirrors MAX_SECRET_VALUE_BYTES in @xecret/core/crypto.
// Refusing here turns a 64 KB ceiling into a sentence instead of a 400 after
// the whole file has been uploaded.
const maxSecretValueBytes = 64 * 1024

// defaultGeneratedBytes is 32 bytes of entropy — 256 bits, the length of every
// key this product's own cryptography uses, rendered as 43 base64url
// characters. Long enough that nothing is gained by asking for more, short
// enough to paste into a provider's console when one has to be mirrored there.
const defaultGeneratedBytes = 32

// optionalInt is a flag that may be given bare (`--generate`) or with a value
// (`--generate=48`). Go's flag package supports this only through IsBoolFlag,
// which is why this type exists rather than a plain Int.
type optionalInt struct {
	set   bool
	value int
}

func (o *optionalInt) String() string {
	if !o.set {
		return ""
	}
	return fmt.Sprint(o.value)
}

func (o *optionalInt) Set(raw string) error {
	switch raw {
	case "true":
		// What IsBoolFlag delivers for the bare form. "Present, no number."
		o.set, o.value = true, 0
		return nil
	case "false":
		// IsBoolFlag advertises this as a boolean, so `--generate=false` is
		// what a wrapper built from `${GENERATE:-false}` produces, and it means
		// "do not generate" — not "generate zero bytes". Refusing it would abort
		// a command that should simply have read the value from stdin.
		o.set, o.value = false, 0
		return nil
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return fmt.Errorf("expected a positive number of bytes, got %q", raw)
	}
	o.set, o.value = true, parsed
	return nil
}

// IsBoolFlag lets `--generate` stand alone. Note the consequence, which the
// usage text states: the space-separated form `--generate 48` does not bind,
// so the length is given as `--generate=48`.
func (o *optionalInt) IsBoolFlag() bool { return true }

// valueOr answers the requested length, or fallback for the bare `--generate`,
// which carries no number. Set never stores a non-positive length, so a zero
// here means exactly "given, without one".
func (o *optionalInt) valueOr(fallback int) int {
	if o.value <= 0 {
		return fallback
	}
	return o.value
}

// secretValueFrom resolves where the value comes from. Never from an argument
// — see the usage text.
func secretValueFrom(a *app, name, fromFile string, generate optionalInt) (string, error) {
	switch {
	case generate.set:
		return generateValue(generate.valueOr(defaultGeneratedBytes))
	case fromFile != "":
		return readValueFile(fromFile)
	default:
		return readSecretValue(a, name)
	}
}

// generateValue mints a random value with crypto/rand. base64url so it survives
// every place a secret ends up — a shell, a URL, a YAML file — without quoting.
func generateValue(bytes int) (string, error) {
	if bytes < 16 || bytes > 1024 {
		return "", errors.New("--generate takes between 16 and 1024 bytes")
	}
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", errors.New("could not read randomness from the operating system")
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

// readValueFile takes a file's bytes as the value, verbatim.
//
// Deliberately unlike the pipe path, which strips one trailing newline: there
// the newline is the shell's framing, here it is part of the file. A PEM key
// ends in one, and a service-account JSON that lost its final byte fails to
// parse at whichever provider it belongs to, weeks later.
func readValueFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("cannot read %s", path)
	}
	if info.Size() > maxSecretValueBytes {
		return "", fmt.Errorf("%s is larger than the %d KB limit on one secret", path, maxSecretValueBytes/1024)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read %s", path)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("%s is empty; nothing written", path)
	}
	return string(data), nil
}

// secretsAnnotate changes what is said about a secret and appends no version.
func secretsAnnotate(args []string) error {
	flags := flag.NewFlagSet("secrets annotate", flag.ContinueOnError)
	note := flags.String("note", "", "note shown beside the secret (empty clears it)")
	valueType := flags.String("type", "", "declared value type (string, int, url, …)")
	rename := flags.String("rename", "", "give the secret a new name; the history follows it")
	projectFlag, envFlag := scopedFlags(flags)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	name, err := oneName(positional)
	if err != nil {
		return err
	}

	// Which flags were *given*, not which are non-empty: `--note ""` clears a
	// note, and that is a different request from omitting the flag.
	given := map[string]bool{}
	flags.Visit(func(f *flag.Flag) { given[f.Name] = true })

	update := api.MetadataUpdate{}
	if given["note"] {
		update.Note = note
	}
	if given["type"] {
		update.ValueType = valueType
	}
	if given["rename"] {
		if _, err := oneName([]string{*rename}); err != nil {
			return err
		}
		update.Name = rename
	}
	if update.Note == nil && update.ValueType == nil && update.Name == nil {
		return errors.New("nothing to change — pass --note, --type or --rename")
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	updated, err := client.UpdateMetadata(ctx,
		resolved.Org, resolved.Project, resolved.Environment, name, update)
	if err != nil {
		return err
	}

	if update.Name != nil {
		a.printer.Successf("Renamed %s to %s — the version history follows the secret.", name, updated.Name)
		a.printer.Warnf("everything that reads %s by name stops finding it. Update your code and CI.", name)
	} else {
		a.printer.Successf("Updated %s — no new version; the value is untouched.", updated.Name)
	}
	return nil
}

// secretsVersions prints the history. Metadata only, because that is all the
// server will produce — see the note in the usage text.
func secretsVersions(args []string) error {
	flags := flag.NewFlagSet("secrets versions", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	projectFlag, envFlag := scopedFlags(flags)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	name, err := oneName(positional)
	if err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	versions, err := client.SecretVersions(ctx, resolved.Org, resolved.Project, resolved.Environment, name)
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(versions)
	}

	rows := make([][]string, len(versions))
	for i, version := range versions {
		current := ""
		if version.Current {
			current = "current"
		}
		rows[i] = []string{
			fmt.Sprintf("v%d", version.Version),
			current,
			shortTime(version.CreatedAt),
			versionActor(version),
		}
	}
	a.printer.Table([]string{"version", "", "written", "by"}, rows)
	a.printer.Infof("Values are not shown here. 'xecret secrets get %s --version N --plain' reveals one, and is audited.", name)
	return nil
}

// versionActor says what kind of credential wrote a version. The ids stay in
// --json, where they are worth cross-referencing against the audit log; a
// column of UUIDs at a terminal is noise.
func versionActor(version api.SecretVersion) string {
	switch {
	case version.CreatedByServiceTokenID != nil:
		return "service token"
	case version.CreatedBy != nil:
		return "user"
	default:
		return "—"
	}
}

// secretsRestore re-appends an earlier value as the current one.
func secretsRestore(args []string) error {
	flags := flag.NewFlagSet("secrets restore", flag.ContinueOnError)
	version := flags.Int("version", 0, "the version to restore")
	projectFlag, envFlag := scopedFlags(flags)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	name, err := oneName(positional)
	if err != nil {
		return err
	}
	if *version < 1 {
		return fmt.Errorf("pass --version N; 'xecret secrets versions %s' lists them", name)
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.RestoreSecret(ctx,
		resolved.Org, resolved.Project, resolved.Environment, name, *version)
	if err != nil {
		return err
	}

	if result.Status == "unchanged" {
		a.printer.Successf("%s already held the value from v%d — nothing written.", name, result.RestoredFrom)
		return nil
	}
	a.printer.Successf("Restored %s from v%d as v%d in %s/%s.",
		name, result.RestoredFrom, result.Version, resolved.Project, resolved.Environment)
	a.printer.Infof("History was not rewritten — v%d is still there.", result.RestoredFrom)
	return nil
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
