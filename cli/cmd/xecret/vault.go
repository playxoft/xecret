package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/term"
	"gopkg.in/yaml.v3"

	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/vaultarchive"
)

// `xecret vault open-archive` — opening a vault escape archive, offline.
//
// An archive is emailed to an account when its vault is reset: every secret it
// could read, still encrypted, openable with the old master passphrase or one of
// the old recovery codes (docs/security/e2ee-crypto-spec.md §14). This command
// is what makes that credible in ten years. It reads a file, asks for a
// credential without echoing it, and prints or writes the plaintext. It makes no
// network request, reads no configuration, touches no keychain, and needs no
// account — nothing here can stop working because a server did.
//
// It is the third place this binary writes plaintext to stdout, beside `pull`
// and `secrets get --plain`, and for the same reason: producing it is the stated
// purpose. The same warning goes to stderr, where it survives `> secrets.env`.

const vaultUsage = `Usage:
  xecret vault open-archive <file> [flags]

Opens a vault archive offline: the .zip emailed when a vault was reset, or the
archive.json inside it. Needs the old vault's master passphrase or one of its
unused recovery codes. Makes no network request and needs no account.

Flags:
  --recovery-code      Ask for a recovery code instead of the passphrase
  --passphrase-stdin   Read the passphrase (or code) from stdin instead of a prompt
  --format FORMAT      env | json | yaml | shell | docker   (default env)
  --environment NAME   Only this environment: <org>/<project>/<env>, or <env>
  --out-dir DIR        Write one file per environment under DIR (mode 0600)
                       instead of printing to stdout
  --force              Overwrite files that already exist in --out-dir
  --list               Show what the archive holds, without opening it
`

func cmdVault(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stdout, vaultUsage)
		return nil
	}
	switch args[0] {
	case "open-archive":
		return newArchiveOpener().run(args[1:])
	case "help", "--help", "-h":
		fmt.Fprint(os.Stdout, vaultUsage)
		return nil
	}
	return fmt.Errorf("unknown vault command %q\n\n%s", args[0], vaultUsage)
}

// archiveOpener carries its I/O so a test can drive it without a terminal.
type archiveOpener struct {
	stdin        io.Reader
	stdout       io.Writer
	stderr       io.Writer
	stdinIsTTY   func() bool
	readPassword func() ([]byte, error)
}

func newArchiveOpener() *archiveOpener {
	return &archiveOpener{
		stdin:        os.Stdin,
		stdout:       os.Stdout,
		stderr:       os.Stderr,
		stdinIsTTY:   func() bool { return term.IsTerminal(int(os.Stdin.Fd())) },
		readPassword: func() ([]byte, error) { return term.ReadPassword(int(os.Stdin.Fd())) },
	}
}

func (o *archiveOpener) run(args []string) error {
	flags := flag.NewFlagSet("vault open-archive", flag.ContinueOnError)
	flags.SetOutput(o.stderr)
	recoveryCode := flags.Bool("recovery-code", false, "ask for a recovery code instead of the passphrase")
	fromStdin := flags.Bool("passphrase-stdin", false, "read the passphrase or code from stdin")
	format := flags.String("format", "env", "env | json | yaml | shell | docker")
	only := flags.String("environment", "", "only this environment: <org>/<project>/<env>, or <env>")
	outDir := flags.String("out-dir", "", "write one file per environment under this directory")
	force := flags.Bool("force", false, "overwrite files that already exist in --out-dir")
	list := flags.Bool("list", false, "show what the archive holds without opening it")

	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return errors.New("name one archive file: xecret vault open-archive <file>")
	}
	if !knownFormat(*format) {
		return fmt.Errorf("unknown format %q — use env, json, yaml, shell or docker", *format)
	}

	data, err := readArchiveBytes(positional[0])
	if err != nil {
		return err
	}
	doc, err := vaultarchive.ReadFile(data)
	if err != nil {
		return err
	}

	environments, err := selectEnvironments(doc.Environments, *only)
	if err != nil {
		return err
	}

	if *list {
		o.describe(doc, environments)
		return nil
	}

	kind := vaultarchive.CredentialPassphrase
	prompt := "Master passphrase of the old vault (input hidden): "
	if *recoveryCode {
		kind = vaultarchive.CredentialRecoveryCode
		prompt = "Recovery code of the old vault (input hidden): "
	}
	secret, err := o.readSecret(prompt, *fromStdin)
	if err != nil {
		return err
	}

	opened, err := vaultarchive.Open(&vaultarchive.Document{
		ArchiveID: doc.ArchiveID, Part: doc.Part, Parts: doc.Parts, CreatedAt: doc.CreatedAt,
		UserID: doc.UserID, Vault: doc.Vault, Environments: environments,
	}, vaultarchive.Credential{Kind: kind, Secret: secret})
	if err != nil {
		return describeOpenFailure(err, *recoveryCode)
	}

	if *outDir != "" {
		err = o.writeFiles(opened, *outDir, *format, *force)
	} else {
		err = o.print(opened, *format)
	}
	if err != nil {
		return err
	}

	return o.report(opened)
}

// selectEnvironments narrows the archive to --environment, by full path or by
// environment slug alone when that is unambiguous.
func selectEnvironments(all []vaultarchive.Environment, only string) ([]vaultarchive.Environment, error) {
	if only == "" {
		return all, nil
	}
	var matched []vaultarchive.Environment
	for _, environment := range all {
		if environmentPath(environment.OrgSlug, environment.ProjectSlug, environment.EnvironmentSlug) == only ||
			environment.EnvironmentSlug == only {
			matched = append(matched, environment)
		}
	}
	if len(matched) == 0 {
		return nil, fmt.Errorf("the archive has no environment %q — run with --list to see what it holds", printable(only))
	}
	return matched, nil
}

func environmentPath(org, project, environment string) string {
	return printable(org + "/" + project + "/" + environment)
}

// maxArchiveFileBytes bounds what is read into memory before anything is
// parsed: the largest archive.json a reader accepts (§14.1), plus room for the
// ZIP around it and a README.
const maxArchiveFileBytes = vaultarchive.MaxDocumentBytes + 16*1024*1024

// readArchiveBytes reads at most maxArchiveFileBytes, and refuses a larger file
// rather than reading it whole: a file of any size can be named here.
func readArchiveBytes(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("could not read %s", printable(path))
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxArchiveFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("could not read %s", printable(path))
	}
	if len(data) > maxArchiveFileBytes {
		return nil, fmt.Errorf("%s is larger than any vault archive", printable(path))
	}
	return data, nil
}

// printable renders a label from an archive so it can be printed safely: every
// rune that is not a printable, ordinary character — control characters, line
// and paragraph separators, bidirectional overrides, invisible format
// characters — is written as \u{XXXX} instead of being sent to the terminal.
// The reader's grammar already refuses most of these (§14.4); this is the
// second wall, applied to every label this command prints wherever it came from.
func printable(value string) string {
	var out strings.Builder
	for _, r := range value {
		if r == utf8.RuneError || !unicode.IsPrint(r) || unicode.Is(unicode.Cf, r) || r == 0x2028 || r == 0x2029 {
			fmt.Fprintf(&out, "\\u{%04X}", r)
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}

// readSecret takes the passphrase or code without echoing it, and never from a
// flag — a flag would put it in shell history and the process table.
//
// --passphrase-stdin reads a pipe; when stdin turns out to be a terminal after
// all, it is read the hidden way, so the flag never makes typing echo. The
// bytes read are overwritten once the string is made — Go strings cannot be
// wiped, but the buffer behind them can.
func (o *archiveOpener) readSecret(prompt string, fromStdin bool) (string, error) {
	if fromStdin && !o.stdinIsTTY() {
		data, err := io.ReadAll(o.stdin)
		if err != nil {
			return "", errors.New("could not read from stdin")
		}
		defer wipe(data)
		value := strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r")
		if value == "" {
			return "", errors.New("stdin was empty")
		}
		return value, nil
	}
	if !o.stdinIsTTY() {
		return "", errors.New("there is no terminal to ask on — pipe the passphrase in with --passphrase-stdin")
	}
	fmt.Fprint(o.stderr, prompt)
	raw, err := o.readPassword()
	fmt.Fprintln(o.stderr)
	defer wipe(raw)
	if err != nil {
		return "", errors.New("could not read from the terminal")
	}
	if len(raw) == 0 {
		return "", errors.New("nothing was entered")
	}
	return string(raw), nil
}

// wipe overwrites a buffer that held a passphrase or a recovery code.
func wipe(buffer []byte) {
	for i := range buffer {
		buffer[i] = 0
	}
}

func describeOpenFailure(err error, recoveryCode bool) error {
	switch {
	case errors.Is(err, e2ee.ErrDecrypt):
		if recoveryCode {
			return errors.New("that recovery code does not open this archive — it may be a code from another vault, or one already used")
		}
		return errors.New("that passphrase does not open this archive")
	case errors.Is(err, e2ee.ErrRecoveryChecksum):
		return errors.New("that recovery code has a typo — check each character against your Emergency Kit")
	case errors.Is(err, e2ee.ErrRecoveryFormat):
		return errors.New("that is not a recovery code — they look like XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X")
	}
	return err
}

func (o *archiveOpener) describe(doc *vaultarchive.Document, environments []vaultarchive.Environment) {
	fmt.Fprintf(o.stdout, "Vault archive made %s for account %s", printable(doc.CreatedAt), printable(doc.UserID))
	if doc.Parts > 1 {
		fmt.Fprintf(o.stdout, " (part %d of %d)", doc.Part, doc.Parts)
	}
	fmt.Fprintf(o.stdout, "\nOpens with the master passphrase or one of %d recovery code(s).\n\n", len(doc.Vault.RecoveryWraps))
	for _, environment := range environments {
		production := ""
		if environment.IsProduction {
			production = "  [production]"
		}
		fmt.Fprintf(o.stdout, "%s / %s / %s%s\n", printable(environment.OrgName), printable(environment.ProjectName), printable(environment.EnvironmentName), production)
		fmt.Fprintf(o.stdout, "  %s — %d secret(s)\n", environmentPath(environment.OrgSlug, environment.ProjectSlug, environment.EnvironmentSlug), len(environment.Secrets))
		for _, secret := range environment.Secrets {
			fmt.Fprintf(o.stdout, "    %s\n", printable(secret.Name))
		}
	}
}

// opened values of one environment, by name.
func values(environment vaultarchive.OpenedEnvironment) map[string]string {
	out := map[string]string{}
	for _, secret := range environment.Secrets {
		if secret.Outcome == vaultarchive.OutcomeOK {
			out[secret.Name] = secret.Value
		}
	}
	return out
}

// lineFormat reports whether a format is line-oriented and takes # comments.
func lineFormat(format string) bool {
	return format == "env" || format == "shell" || format == "docker"
}

// notesBlock renders an environment's notes as comment lines, for the
// line-oriented formats. A note is free text and may span lines; every line is
// commented, so no note can ever be read as an assignment, and each is passed
// through printable, so none can carry a control sequence to a terminal. A
// value is printed exactly as it is — producing it is the command's purpose —
// but a note is commentary beside it.
func notesBlock(environment vaultarchive.OpenedEnvironment) string {
	var out strings.Builder
	for _, secret := range environment.Secrets {
		if !secret.HasNote {
			continue
		}
		if out.Len() == 0 {
			out.WriteString("# Notes\n")
		}
		for index, line := range strings.Split(secret.Note, "\n") {
			label := secret.Name + ": "
			if index > 0 {
				label = strings.Repeat(" ", len(label))
			}
			fmt.Fprintf(&out, "#   %s%s\n", label, printable(strings.TrimSuffix(line, "\r")))
		}
	}
	return out.String()
}

func (o *archiveOpener) print(opened *vaultarchive.Opened, format string) error {
	fmt.Fprintln(o.stderr, "warning: these are plaintext secrets. Anything that captures this output now holds them.")

	if lineFormat(format) {
		for index, environment := range opened.Environments {
			if index > 0 {
				fmt.Fprintln(o.stdout)
			}
			fmt.Fprintf(o.stdout, "# %s\n", environmentPath(environment.OrgSlug, environment.ProjectSlug, environment.EnvironmentSlug))
			document, err := formatSecrets(values(environment), format)
			if err != nil {
				return err
			}
			if _, err := o.stdout.Write(document); err != nil {
				return err
			}
			fmt.Fprint(o.stdout, notesBlock(environment))
		}
		return nil
	}

	// json and yaml: one document, keyed by environment path, so the output is
	// one valid document however many environments the archive holds.
	nested := map[string]map[string]string{}
	for _, environment := range opened.Environments {
		nested[environmentPath(environment.OrgSlug, environment.ProjectSlug, environment.EnvironmentSlug)] = values(environment)
	}
	var document []byte
	var err error
	if format == "json" {
		document, err = json.MarshalIndent(nested, "", "  ")
		document = append(document, '\n')
	} else {
		document, err = yaml.Marshal(nested)
	}
	if err != nil {
		return err
	}
	_, err = o.stdout.Write(document)
	return err
}

var unsafePathSegment = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// pathSegment makes a slug safe to use as one directory or file name: no
// separators, no traversal, nothing a filesystem would read as anything else.
func pathSegment(value string) string {
	cleaned := unsafePathSegment.ReplaceAllString(value, "_")
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return "_"
	}
	return cleaned
}

// A split archive's parts are opened one run at a time, and each holds
// different secrets of the same environments. So a part's files are named for
// the part — production.part-2-of-3.env — and two parts never write one file:
// the second run would otherwise refuse, or with --force replace, the first.
func (o *archiveOpener) writeFiles(opened *vaultarchive.Opened, dir, format string, force bool) error {
	extension := map[string]string{"env": ".env", "json": ".json", "yaml": ".yaml", "shell": ".sh", "docker": ".docker.env"}[format]
	written := map[string]bool{}

	for _, environment := range opened.Environments {
		folder := filepath.Join(dir, pathSegment(environment.OrgSlug), pathSegment(environment.ProjectSlug))
		stem := pathSegment(environment.EnvironmentSlug)
		if opened.Parts > 1 {
			stem = fmt.Sprintf("%s.part-%d-of-%d", stem, opened.Part, opened.Parts)
		}
		path := filepath.Join(folder, stem+extension)
		if written[path] {
			return fmt.Errorf("two environments in this archive would both be written to %s", printable(path))
		}
		written[path] = true

		if _, err := os.Stat(path); err == nil && !force {
			return fmt.Errorf("%s already exists — pass --force to overwrite it", printable(path))
		}
		if err := os.MkdirAll(folder, 0o700); err != nil {
			return fmt.Errorf("could not create %s", printable(folder))
		}

		document, err := formatSecrets(values(environment), format)
		if err != nil {
			return err
		}
		if lineFormat(format) {
			document = append(document, []byte(notesBlock(environment))...)
		}
		if err := writeSecretDocument(path, document); err != nil {
			return err
		}
		fmt.Fprintf(o.stderr, "Wrote %s (mode 0600).\n", printable(path))
	}

	fmt.Fprintln(o.stderr, "warning: those files hold plaintext secrets. Delete them when you have moved the values somewhere safe.")
	return nil
}

// report says what did not come out, and fails the command when anything was
// damaged rather than merely absent.
func (o *archiveOpener) report(opened *vaultarchive.Opened) error {
	var noKey, damaged, notes []string
	for _, environment := range opened.Environments {
		where := environmentPath(environment.OrgSlug, environment.ProjectSlug, environment.EnvironmentSlug)
		for _, secret := range environment.Secrets {
			switch secret.Outcome {
			case vaultarchive.OutcomeNoKey:
				noKey = append(noKey, where+" "+printable(secret.Name))
			case vaultarchive.OutcomeDamaged:
				damaged = append(damaged, where+" "+printable(secret.Name))
			}
			if secret.NoteUnavailable {
				notes = append(notes, where+" "+printable(secret.Name))
			}
		}
	}
	sort.Strings(noKey)
	sort.Strings(damaged)
	sort.Strings(notes)

	var summary bytes.Buffer
	if len(noKey) > 0 {
		fmt.Fprintf(&summary, "%d value(s) were written under a key this account never held, so they are not in the archive's reach:\n  %s\n",
			len(noKey), strings.Join(noKey, "\n  "))
	}
	if len(notes) > 0 {
		fmt.Fprintf(&summary, "%d note(s) could not be opened with any key this account held:\n  %s\n",
			len(notes), strings.Join(notes, "\n  "))
	}
	if len(damaged) > 0 {
		fmt.Fprintf(&summary, "%d value(s) are damaged and did not open:\n  %s\n", len(damaged), strings.Join(damaged, "\n  "))
	}
	if summary.Len() > 0 {
		fmt.Fprint(o.stderr, summary.String())
	}
	if len(damaged) > 0 {
		return fmt.Errorf("%d value(s) in this archive are damaged", len(damaged))
	}
	return nil
}
