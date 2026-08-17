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
	if err := flags.Parse(args); err != nil {
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

	document, err := client.Export(ctx, resolved.Org, resolved.Project, resolved.Environment, *format)
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
// The ordering is deliberate. O_TRUNC empties the file at open, so the moment
// between opening and the chmod holds nothing; the secrets are written only
// once 0600 is settled. If the chmod fails there is nothing to salvage — the
// old contents are already gone — so the empty file is removed rather than
// left behind as a permissive shell waiting to be filled.
func writeSecretDocument(path string, document []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("could not write %s", path)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return fmt.Errorf("could not restrict %s to mode 0600, so nothing was written to it", path)
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
	if err := flags.Parse(args); err != nil {
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

	document, err := client.Pull(ctx, resolved.Org, resolved.Project, resolved.Environment, *format)
	if err != nil {
		return err
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
