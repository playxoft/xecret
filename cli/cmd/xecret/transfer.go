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
	if err := flags.Parse(args); err != nil {
		return err
	}

	if len(flags.Args()) != 1 {
		return errors.New("usage: xecret import <file> [--strategy skip|overwrite|rename] [--dry-run]")
	}
	filePath := flags.Args()[0]

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

	switch *format {
	case "env", "json", "yaml", "shell", "docker":
	default:
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
		if err := os.WriteFile(*outPath, document, 0o600); err != nil {
			return fmt.Errorf("could not write %s", *outPath)
		}
		a.printer.Warnf("wrote plaintext secrets to %s — they are now outside xecret's control. Delete the file when done.", *outPath)
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
