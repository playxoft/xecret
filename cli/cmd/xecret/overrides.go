package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/e2ee"
)

// Personal overrides (P19 §2): one person's own value for one secret in one
// environment, which `xecret run` uses on their machine in place of the shared
// one — a local database instead of staging's, a personal API key instead of
// the team's — without anybody else's environment changing.
//
// ── Whose they are, and where they go ──
//
// An override is encrypted under its owner's override key — derived from their
// own X25519 private key (spec §2.2 type 13) — not under the environment's EDK:
// everybody who reads the environment holds the EDK, and an override must not be
// readable by another member as a property of the ciphertext, not merely of the
// route. Symmetric, so it also proves its owner made it: nobody else, the server
// included, can produce one `run` will accept. So every command here is a
// person's. Under XECRET_TOKEN each one refuses before it makes a request — a
// CI credential has no overrides, and the server would refuse it anyway.
//
// Only `run` applies them. `pull` and `export` produce documents that get
// committed, shared and pasted, which is the wrong place for one person's
// values; each says so when the person pulling has overrides.

const overridesUsage = `Usage:
  xecret overrides list   [--json]
  xecret overrides set    <NAME> [-] [--from-file PATH]
  xecret overrides unset  <NAME>

All subcommands accept --project and --environment to override .xecret.yaml.

A personal override is your own value for one secret in one environment.
'xecret run' uses it on your machine in place of the shared value; nobody
else's environment changes, and nobody else — no other member, no
administrator, not the server — can read it, or make one in its place: it is
encrypted under a key only your own vault can derive.

'pull' and 'export' never include overrides; each tells you when you have any.

The value for 'set' is never taken from the command line, for the reason
'xecret secrets help' gives. Pipe it in ('-' says so explicitly), read it from a
file, or type it at the hidden prompt:

  printf '%s' "postgres://localhost/dev" | xecret overrides set DATABASE_URL -
  xecret overrides set SERVICE_ACCOUNT --from-file my-key.json

'list' shows names and when each was set, never values.

An override set before a vault reset no longer opens. 'xecret run' stops
rather than quietly using the shared value in its place, and names each one;
'xecret overrides unset NAME' removes it.
`

func cmdOverrides(args []string) error {
	switch subcommand(args, "help") {
	case "list":
		return overridesList(listArgs(args))
	case "set":
		return overridesSet(args[1:])
	case "unset":
		return overridesUnset(args[1:])
	case "help":
		_, _ = io.WriteString(os.Stdout, overridesUsage)
		return nil
	default:
		return fmt.Errorf("unknown overrides subcommand %q — run 'xecret overrides help'", args[0])
	}
}

// errOverridesNeedAPerson is the refusal every subcommand gives under
// XECRET_TOKEN, before it parses a credential or makes a request.
var errOverridesNeedAPerson = errors.New(
	"personal overrides belong to a person, and XECRET_TOKEN is a service token — " +
		"unset it and use your own login ('xecret login')")

func overridesList(args []string) error {
	flags := flag.NewFlagSet("overrides list", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	projectFlag, envFlag := scopedFlags(flags)
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	if a.usingServiceToken() {
		return errOverridesNeedAPerson
	}
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

	overrides, err := client.Overrides(ctx, resolved.Org, resolved.Project, resolved.Environment)
	if err != nil {
		return err
	}

	if a.printer.JSON {
		// Names and times. The ciphertext is not a value, but it is nothing a
		// script can use either — only its owner's key opens it, and `run` is
		// the one place that does.
		listing := make([]map[string]string, len(overrides))
		for i, override := range overrides {
			listing[i] = map[string]string{"name": override.Name, "updatedAt": override.UpdatedAt}
		}
		return a.printer.WriteJSON(listing)
	}

	if len(overrides) == 0 {
		a.printer.Infof("You have no personal overrides in %s/%s. 'xecret overrides set NAME' adds one.",
			resolved.Project, resolved.Environment)
		return nil
	}

	rows := make([][]string, len(overrides))
	for i, override := range overrides {
		rows[i] = []string{override.Name, shortTime(override.UpdatedAt)}
	}
	a.printer.Table([]string{"name", "updated"}, rows)
	a.printer.Infof("Values are not shown. 'xecret run' applies them on this machine; 'pull' and 'export' do not.")
	return nil
}

func overridesSet(args []string) error {
	flags := flag.NewFlagSet("overrides set", flag.ContinueOnError)
	fromFile := flags.String("from-file", "", "read the value from a file instead of stdin")
	projectFlag, envFlag := scopedFlags(flags)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}

	// `-` is the explicit spelling of "read stdin", which is also what happens
	// without it. Anything else in that position is a value typed on the command
	// line, and refusing it is the one rule this whole binary is built on:
	// an argument lands in shell history and in every `ps` listing on the
	// machine, and a personal override is still somebody's credential.
	if len(positional) == 2 {
		if positional[1] != "-" {
			return fmt.Errorf(
				"the value is never taken from the command line — pipe it in instead: "+
					"printf '%%s' \"$VALUE\" | xecret overrides set %s -", positional[0])
		}
		if *fromFile != "" {
			return errors.New("'-' and --from-file both supply the value; pass one")
		}
		positional = positional[:1]
	}
	name, err := oneName(positional)
	if err != nil {
		return err
	}

	a := newApp(false)
	if a.usingServiceToken() {
		return errOverridesNeedAPerson
	}
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	value, err := secretValueFrom(a, name, *fromFile, optionalInt{})
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// The environment's id is a component of the override's AAD, and the key
	// state is where it is read from — through keyState, so the mode pin is
	// consulted on the way past as it is for every other write.
	keys, err := a.keyState(ctx, client, credentials, resolved)
	if err != nil {
		return err
	}
	if keys.EncryptionMode != "e2ee" {
		return fmt.Errorf(
			"%s/%s uses server-side encryption, and personal overrides need an end-to-end encrypted environment",
			resolved.Project, resolved.Environment)
	}

	principal, err := a.principal(ctx, client, credentials)
	if err != nil {
		return withE2eeHint(err)
	}
	defer principal.Close()

	// Under the owner's override key, derived from their own private key — never
	// from anything the server supplied, so the server can neither read this
	// value nor make one `xecret run` would accept in its place.
	ciphertext, err := e2ee.SealOverrideValue(principal.PrivateKey, e2ee.OverrideContext{
		OrgID:         principal.OrgID,
		EnvironmentID: keys.EnvironmentID,
		UserID:        principal.ID,
		Name:          name,
	}, value)
	if err != nil {
		return err
	}

	written, err := client.SetOverride(ctx, resolved.Org, resolved.Project, resolved.Environment, name, ciphertext)
	if err != nil {
		return err
	}

	verb := "Replaced"
	if written.Created {
		verb = "Set"
	}
	a.printer.Successf("%s your personal override for %s in %s/%s.",
		verb, name, resolved.Project, resolved.Environment)
	a.printer.Infof("'xecret run' uses it on this machine in place of the shared value; nobody else's environment changed.")
	return nil
}

func overridesUnset(args []string) error {
	flags := flag.NewFlagSet("overrides unset", flag.ContinueOnError)
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
	if a.usingServiceToken() {
		return errOverridesNeedAPerson
	}
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

	if err := client.DeleteOverride(ctx, resolved.Org, resolved.Project, resolved.Environment, name); err != nil {
		if apiErr, ok := api.AsError(err); ok && apiErr.Status == 404 {
			return fmt.Errorf("you have no personal override for %s in %s/%s — 'xecret overrides list' shows the ones you do",
				name, resolved.Project, resolved.Environment)
		}
		return err
	}
	a.printer.Successf("Removed your personal override for %s in %s/%s — 'xecret run' uses the shared value again.",
		name, resolved.Project, resolved.Environment)
	return nil
}
