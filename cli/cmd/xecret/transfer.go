package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/envkeys"
	"github.com/playxoft/xecret/cli/internal/ids"
	"github.com/playxoft/xecret/cli/internal/importer"
	"github.com/playxoft/xecret/cli/internal/output"
)

// maxImportBytes matches the server's request ceiling; refusing here saves an
// upload that would 413.
const maxImportBytes = 1 << 20

// cmdImport sends a configuration file to the server, which parses and plans
// it — the CLI deliberately has no second parser to disagree with the one the
// dashboard's import modal uses.
func cmdImport(args []string) error {
	flags := flag.NewFlagSet("import", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	format := flags.String("format", "", "dotenv | json | yaml | shell (default: detected)")
	strategy := flags.String("strategy", "skip", "conflicts: skip | overwrite | rename")
	dryRun := flags.Bool("dry-run", false, "show the plan without writing anything")
	projectFlag, envFlag := scopedFlags(flags)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}

	if len(positional) != 1 {
		return errors.New("usage: xecret import <file> [--strategy skip|overwrite|rename] [--dry-run]")
	}
	filePath := positional[0]

	switch *strategy {
	case "skip", "overwrite", "rename":
	default:
		return fmt.Errorf("unknown strategy %q — use skip, overwrite or rename", *strategy)
	}

	info, err := os.Stat(filePath)
	if err != nil {
		return fmt.Errorf("cannot read %s", filePath)
	}
	if info.Size() > maxImportBytes {
		return fmt.Errorf("%s is larger than the 1 MB import limit", filePath)
	}

	content, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("cannot read %s", filePath)
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

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// The mode decides who parses. A `server`-mode environment sends the file and
	// the server plans it — one parser, which is the arrangement this CLI has
	// always preferred. An `e2ee` one cannot: uploading a file full of plaintext
	// to an endpoint that must never see one is the whole thing the model
	// forbids, so the parse, the plan and the encryption all happen here.
	material, err := a.openKeys(ctx, client, credentials, resolved)
	if err != nil {
		return withE2eeHint(err)
	}
	if material != nil {
		defer material.Close()
		return importClientSide(ctx, a, client, material, resolved, importInput{
			content:  string(content),
			filename: filepath.Base(filePath),
			format:   *format,
			strategy: *strategy,
			dryRun:   *dryRun,
		})
	}

	result, err := client.Import(ctx, resolved.Org, resolved.Project, resolved.Environment, api.ImportRequest{
		Content:  string(content),
		Format:   *format,
		Filename: filepath.Base(filePath),
		Strategy: *strategy,
		DryRun:   *dryRun,
	})
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(result)
	}

	rows := make([][]string, len(result.Items))
	for i, item := range result.Items {
		note := ""
		if item.Note != nil {
			note = *item.Note
		}
		rows[i] = []string{item.Name, item.Status, note}
	}
	a.printer.Table([]string{"name", "status", "note"}, rows)

	for _, warning := range result.Warnings {
		a.printer.Warnf("%s", warning)
	}

	summary := fmt.Sprintf("%d created, %d overwritten, %d unchanged, %d skipped",
		result.Counts["create"], result.Counts["overwrite"], result.Counts["unchanged"], result.Counts["skip"])
	if result.DryRun {
		a.printer.Infof("Dry run — nothing written. Plan: %s.", summary)
		a.printer.Infof("Re-run without --dry-run to apply.")
	} else {
		a.printer.Successf("Imported into %s/%s: %s.", resolved.Project, resolved.Environment, summary)
	}
	return nil
}

// importInput is what the caller read off disk and off the flags.
type importInput struct {
	content  string
	filename string
	format   string
	strategy string
	dryRun   bool
}

// importClientSide parses, plans and encrypts an import for an end-to-end
// encrypted environment.
//
// ── Why the dry run still makes a request ──
// The plan decides create/overwrite/skip/rename, and this process can compute
// all four. It cannot compute `unchanged`, which is an HMAC comparison against a
// tag only the server holds. Sending the sealed entries with `dryRun: true`
// costs one request and keeps the preview identical to the outcome — which is
// the property the shared planner exists to protect, and which a locally-guessed
// summary would quietly break.
func importClientSide(
	ctx context.Context,
	a *app,
	client *api.Client,
	material *envkeys.Material,
	resolved scope,
	input importInput,
) error {
	format := importer.Format(input.format)
	if input.format == "" {
		format = importer.Detect(input.filename, input.content)
	} else if !importer.KnownFormat(input.format) {
		return fmt.Errorf("unknown format %q — use dotenv, json, yaml or shell", input.format)
	}

	parsed := importer.Parse(input.content, format)

	// Unpaginated and complete, exactly as the server's own path needs it: a plan
	// built against the first page of existing names would classify an existing
	// secret as a create and then fail against the unique index. The listing also
	// carries the ids and versions each ciphertext has to be sealed against.
	existing, err := client.Secrets(ctx, resolved.Org, resolved.Project, resolved.Environment)
	if err != nil {
		return err
	}

	names := make([]string, 0, len(existing))
	current := make(map[string]api.SecretListItem, len(existing))
	for _, secret := range existing {
		names = append(names, secret.Name)
		current[secret.Name] = secret
	}

	plan := importer.BuildPlan(parsed, names, importer.Strategy(input.strategy))

	entries := make([]api.ClientImportEntry, 0, len(plan.Items))
	localCounts := map[string]int{}
	for _, item := range plan.Items {
		if item.Status == importer.StatusInvalid || item.Status == importer.StatusSkip {
			localCounts[string(item.Status)]++
			continue
		}

		// A create seals against the id this process mints and version 1; an
		// overwrite seals against the stored id and the version the row is about
		// to become. Both travel with the entry, because both are in the AAD and
		// this listing can be stale by the time the request lands: the server
		// re-plans against the rows that exist now and refuses any entry whose id
		// or version it does not agree with, rather than writing it under the row
		// it resolved. Without that, an entry planned as a create for a name that
		// already exists is stored under the stored id — a ciphertext naming a
		// uuid the row does not have, unopenable for ever, reported as success.
		secretID, version := "", 1
		if target, exists := current[item.TargetName]; exists {
			secretID, version = target.ID, target.Version+1
		} else if secretID, err = ids.UUIDv7(); err != nil {
			return err
		}

		sealed, encryptErr := material.EncryptSecret(secretID, version, item.Value)
		if encryptErr != nil {
			return encryptErr
		}
		entries = append(entries, api.ClientImportEntry{
			ID: secretID, Name: item.TargetName, ExpectedVersion: version, Value: sealed,
		})
	}

	for _, warning := range plan.Warnings {
		a.printer.Warnf("line %d: %s", warning.Line, warning.Message)
	}

	if len(entries) == 0 {
		a.printer.Infof("Nothing to import: %d skipped, %d unusable.",
			localCounts[string(importer.StatusSkip)], localCounts[string(importer.StatusInvalid)])
		return nil
	}

	result, err := client.ImportClientEntries(
		ctx, resolved.Org, resolved.Project, resolved.Environment, entries, input.dryRun)
	if err != nil {
		return withWriteConflictHint(err)
	}

	// The server's outcome per name, joined to the local plan's note — which is
	// the only place a "renamed from" or "already exists" explanation lives.
	notes := make(map[string]string, len(plan.Items))
	for _, item := range plan.Items {
		notes[item.TargetName] = item.Note
	}

	rows := make([][]string, 0, len(result.Items)+len(plan.Items))
	for _, item := range result.Items {
		rows = append(rows, []string{item.Name, item.Status, notes[item.Name]})
	}
	for _, item := range plan.Items {
		if item.Status == importer.StatusInvalid || item.Status == importer.StatusSkip {
			rows = append(rows, []string{item.SourceKey, string(item.Status), item.Note})
		}
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(map[string]any{
			"dryRun": result.DryRun,
			"counts": result.Counts,
			"items":  rows,
		})
	}
	a.printer.Table([]string{"name", "status", "note"}, rows)

	summary := fmt.Sprintf("%d created, %d overwritten, %d unchanged, %d skipped",
		result.Counts["create"], result.Counts["overwrite"], result.Counts["unchanged"],
		localCounts[string(importer.StatusSkip)]+localCounts[string(importer.StatusInvalid)])
	if result.DryRun {
		a.printer.Infof("Dry run — nothing written. Plan: %s.", summary)
		a.printer.Infof("Re-run without --dry-run to apply.")
	} else {
		a.printer.Successf("Imported into %s/%s: %s.", resolved.Project, resolved.Environment, summary)
	}
	return nil
}

// cmdExport writes every current secret to a file.
//
// Writing secrets to a file is a deliberate downgrade in security posture, and
// this command exists anyway — the server's export route says the same thing at
// more length, and for the same reason: a team that cannot export will paste
// values into chat one at a time, which is strictly less safe and completely
// unaudited. So it is offered, it is audited exactly like a pull, and it warns.
//
// It is a separate command from `pull` rather than a flag on it because the two
// are separate endpoints server-side, and the request path is what tells
// "a build read its configuration" apart from "somebody took a copy" in the
// audit record. `pull` is the stdout path; `export` always produces a file.
func cmdExport(args []string) error {
	flags := flag.NewFlagSet("export", flag.ContinueOnError)
	format := flags.String("format", "env", "env | json | yaml | shell | docker")
	outPath := flags.String("o", "", "file to write (default: derived from the format)")
	force := flags.Bool("force", false, "overwrite the file if it already exists")
	projectFlag, envFlag := scopedFlags(flags)
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}

	if !knownFormat(*format) {
		return fmt.Errorf("unknown format %q — use env, json, yaml, shell or docker", *format)
	}

	path := *outPath
	if path == "" {
		path = defaultExportPath(*format)
	}

	// Checked before the request, so a refusal costs no decryption and writes
	// no audit record for a read that was never going to land anywhere.
	if _, err := os.Stat(path); err == nil && !*force {
		return fmt.Errorf("%s already exists — pass --force to overwrite it", path)
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

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	document, err := a.exportDocument(ctx, client, credentials, resolved, *format)
	if err != nil {
		return err
	}

	if err := writeSecretDocument(path, document); err != nil {
		return err
	}

	a.printer.Successf("Wrote %s/%s to %s (mode 0600).", resolved.Project, resolved.Environment, path)
	a.printer.Warnf("those secrets are now outside xecret's control: the file is not encrypted, it outlives")
	a.printer.Warnf("this session, backup and sync tools will copy it, and no grant can be revoked after the")
	a.printer.Warnf("fact. Add it to .gitignore, and delete it when you are done.")
	return nil
}

// writeSecretDocument writes plaintext secrets to a file that is mode 0600 by
// the time it holds anything — whether or not it already existed.
//
// os.WriteFile is not enough: it passes its permission argument to open(2),
// which applies it *only when the file is created*. An `export --force` over a
// .env left at 0644 by `xecret pull > .env` would therefore write every
// decrypted secret into a file readable by every account on the machine, under
// a message claiming mode 0600.
//
// The ordering is deliberate, and deliberately not O_TRUNC. Narrow first,
// destroy second, write third: if the chmod fails — the file belongs to another
// user, the filesystem does not carry modes — the old contents are still there
// and the caller is told nothing was written, which is then true. Truncating at
// open would have destroyed the file *before* learning we could not secure it,
// leaving the user with neither their old .env nor an error they could act on.
func writeSecretDocument(path string, document []byte) error {
	_, statErr := os.Stat(path)
	existed := statErr == nil

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("could not write %s", path)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		if !existed {
			// We made it and could not secure it. Nobody wants the empty file,
			// and leaving one behind means the next run refuses with "already
			// exists — pass --force".
			_ = os.Remove(path)
		}
		return fmt.Errorf("could not restrict %s to mode 0600, so nothing was written to it", path)
	}
	// Only now is the file both ours and unreadable by anybody else.
	if err := file.Truncate(0); err != nil {
		_ = file.Close()
		return fmt.Errorf("could not empty %s before writing to it", path)
	}
	if _, err := file.Write(document); err != nil {
		_ = file.Close()
		return fmt.Errorf("could not write %s", path)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("could not write %s", path)
	}
	return nil
}

// defaultExportPath names the file each format usually ends up as, so the
// common case needs no -o.
func defaultExportPath(format string) string {
	switch format {
	case "json":
		return "secrets.json"
	case "yaml":
		return "secrets.yaml"
	case "shell":
		return "secrets.sh"
	case "docker":
		// What `docker run --env-file` expects, kept distinct from .env so an
		// export cannot quietly replace a file a local tool is already reading.
		return "docker.env"
	default:
		return ".env"
	}
}

func knownFormat(format string) bool {
	switch format {
	case "env", "json", "yaml", "shell", "docker":
		return true
	}
	return false
}

// cmdPull prints every current secret in the chosen format. This is the other
// sanctioned place plaintext reaches stdout, and it says so on stderr, where
// the warning survives `> .env`.
func cmdPull(args []string) error {
	flags := flag.NewFlagSet("pull", flag.ContinueOnError)
	format := flags.String("format", "env", "env | json | yaml | shell | docker")
	outPath := flags.String("o", "", "write to a file (0600) instead of stdout")
	projectFlag, envFlag := scopedFlags(flags)
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}

	if !knownFormat(*format) {
		return fmt.Errorf("unknown format %q — use env, json, yaml, shell or docker", *format)
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

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pulled, err := client.Pull(ctx, resolved.Org, resolved.Project, resolved.Environment, *format)
	if err != nil {
		return err
	}

	document := pulled.Document
	if pulled.Bundle != nil {
		// The server rendered nothing, because it could not read anything. The
		// same five formats, produced here from values this process decrypted.
		secrets, openErr := a.openEnvironment(ctx, client, credentials, pulled)
		if openErr != nil {
			return withE2eeHint(openErr)
		}
		if document, err = formatSecrets(secrets, *format); err != nil {
			return err
		}
	}

	if *outPath != "" {
		if err := writeSecretDocument(*outPath, document); err != nil {
			return err
		}
		a.printer.Warnf("wrote plaintext secrets to %s (mode 0600) — they are now outside xecret's control. Delete the file when done.", *outPath)
		return nil
	}

	if output.StdoutIsTerminal() {
		a.printer.Warnf("printing plaintext secrets to your terminal (scrollback keeps them).")
	} else {
		a.printer.Warnf("pulled secrets now live wherever this output goes; prefer 'xecret run' where possible.")
	}

	_, err = a.printer.Out.Write(document)
	return err
}
