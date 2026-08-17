package main

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
)

func TestResolveSinceReadsDurationsAndTimestamps(t *testing.T) {
	if value, err := resolveSince(""); err != nil || value != "" {
		t.Errorf("empty --since = %q, %v; want the server's own default", value, err)
	}

	within := func(value string, want time.Duration) bool {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return false
		}
		delta := time.Since(parsed) - want
		return delta > -time.Minute && delta < time.Minute
	}

	hours, err := resolveSince("24h")
	if err != nil || !within(hours, 24*time.Hour) {
		t.Errorf("24h = %q, %v", hours, err)
	}

	// A day is not a unit time.ParseDuration knows, and it is the one people
	// reach for when reading an audit log.
	days, err := resolveSince("7d")
	if err != nil || !within(days, 7*24*time.Hour) {
		t.Errorf("7d = %q, %v", days, err)
	}

	stamp, err := resolveSince("2026-01-02T03:04:05Z")
	if err != nil || stamp != "2026-01-02T03:04:05Z" {
		t.Errorf("RFC 3339 = %q, %v", stamp, err)
	}

	if _, err := resolveSince("last tuesday"); err == nil {
		t.Error("an unparseable --since must be refused, not silently ignored")
	}

	// A window edge that lands in the future returns nothing and is reported as
	// "no matching events", which reads as an answer rather than as the typo it
	// is. Both spellings of it are refused.
	if _, err := resolveSince("-24h"); err == nil {
		t.Error("a negative --since must be refused; it puts the window in the future")
	}
	if _, err := resolveSince("1000000d"); err == nil {
		t.Error("a day count that overflows time.Duration must be refused")
	}
}

// --until and --since have to accept the same spellings. --until used to reach
// the server verbatim, so a value --since normalises into RFC 3339 — "7d", or a
// timestamp with an offset — was a 400 from the same string that worked for the
// other half of the window.
func TestResolveUntilTakesTheSameSpellingsAsSince(t *testing.T) {
	for _, value := range []string{"24h", "7d", "2026-01-02T03:04:05Z"} {
		since, sinceErr := resolveSince(value)
		until, untilErr := resolveUntil(value)
		if sinceErr != nil || untilErr != nil {
			t.Errorf("%q: --since %v, --until %v", value, sinceErr, untilErr)
			continue
		}
		if _, err := time.Parse(time.RFC3339, until); err != nil {
			t.Errorf("--until %q produced %q, which is not RFC 3339", value, until)
		}
		// Both anchor at now, so a relative value gives the same instant to the
		// minute; an absolute one is identical.
		if len(since) != len(until) {
			t.Errorf("--since %q = %q but --until = %q", value, since, until)
		}
	}

	// An offset timestamp is normalised to UTC, which is all the server takes.
	offset, err := resolveUntil("2026-01-02T03:04:05+05:30")
	if err != nil {
		t.Fatal(err)
	}
	if offset != "2026-01-01T21:34:05Z" {
		t.Errorf("--until with an offset = %q, want the UTC equivalent", offset)
	}

	if _, err := resolveUntil("-1h"); err == nil {
		t.Error("a negative --until must be refused")
	}
	if _, err := resolveUntil("whenever"); err == nil {
		t.Error("an unparseable --until must be refused")
	}
}

// Every documented example in this CLI puts the name before the flags —
// `xecret secrets get API_KEY --plain` — and Go's flag package stops at the
// first non-flag argument, so without the walk in parseFlags those flags were
// silently dropped into the positional list and ignored.
func TestParseFlagsAcceptsFlagsAfterPositionals(t *testing.T) {
	flags := flag.NewFlagSet("secrets get", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	plain := flags.Bool("plain", false, "")
	project := flags.String("project", "", "")

	positional, err := parseFlags(flags, []string{"API_KEY", "--plain", "--project", "web"})
	if err != nil {
		t.Fatal(err)
	}
	if !*plain || *project != "web" {
		t.Errorf("flags after the name were dropped: plain=%v project=%q", *plain, *project)
	}
	if len(positional) != 1 || positional[0] != "API_KEY" {
		t.Errorf("positional = %v, want [API_KEY]", positional)
	}
}

func TestParseFlagsKeepsBothOrders(t *testing.T) {
	for _, args := range [][]string{
		{"--version", "3", "API_KEY"},
		{"API_KEY", "--version", "3"},
		{"--version=3", "API_KEY"},
	} {
		flags := flag.NewFlagSet("secrets restore", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		version := flags.Int("version", 0, "")

		positional, err := parseFlags(flags, args)
		if err != nil {
			t.Fatalf("parseFlags(%v): %v", args, err)
		}
		if *version != 3 || len(positional) != 1 || positional[0] != "API_KEY" {
			t.Errorf("parseFlags(%v) = %v, version %d", args, positional, *version)
		}
	}
}

// A bare `--` still ends the flags, so a positional that looks like one
// survives.
func TestParseFlagsHonoursTheTerminator(t *testing.T) {
	flags := flag.NewFlagSet("import", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dryRun := flags.Bool("dry-run", false, "")

	positional, err := parseFlags(flags, []string{"--dry-run", "--", "--weird-file-name"})
	if err != nil {
		t.Fatal(err)
	}
	if !*dryRun {
		t.Error("the flag before -- was not parsed")
	}
	if len(positional) != 1 || positional[0] != "--weird-file-name" {
		t.Errorf("positional = %v", positional)
	}
}

func TestParseFlagsStillRejectsUnknownFlags(t *testing.T) {
	flags := flag.NewFlagSet("secrets get", flag.ContinueOnError)
	flags.SetOutput(io.Discard)

	if _, err := parseFlags(flags, []string{"API_KEY", "--nonsense"}); err == nil {
		t.Error("an unknown flag must fail rather than be swallowed as a positional")
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.2.3", "1.2.3", 0},
		{"1.2.3", "1.2.4", -1},
		{"1.3.0", "1.2.9", 1},
		{"2.0.0", "10.0.0", -1},
		{"1.2.0-rc.1", "1.2.0", -1},
		{"1.2.0", "1.2.0-rc.1", 1},
		// An unparseable version sorts below a real one, so the failure mode is
		// "you are told to upgrade" rather than "you are told you are current".
		{"nonsense", "1.0.0", -1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestOptionalIntAcceptsBareAndValued(t *testing.T) {
	var bare optionalInt
	if err := bare.Set("true"); err != nil {
		t.Fatal(err)
	}
	if !bare.set || bare.valueOr(32) != 32 {
		t.Errorf("bare --generate = %+v, want the default length", bare)
	}

	var sized optionalInt
	if err := sized.Set("48"); err != nil {
		t.Fatal(err)
	}
	if sized.valueOr(32) != 48 {
		t.Errorf("--generate=48 = %d", sized.valueOr(32))
	}

	// IsBoolFlag advertises --generate as a boolean, so a wrapper built from
	// ${GENERATE:-false} writes --generate=false and means "do not generate".
	// Refusing it would abort a command that should have read stdin.
	var off optionalInt
	if err := off.Set("false"); err != nil {
		t.Fatalf("--generate=false must mean 'do not generate', not an error: %v", err)
	}
	if off.set {
		t.Error("--generate=false left generation switched on")
	}

	var bad optionalInt
	if err := bad.Set("0"); err == nil {
		t.Error("a zero-byte value must be refused")
	}
	if err := bad.Set("lots"); err == nil {
		t.Error("a non-numeric length must be refused")
	}
}

func TestGenerateValueIsRandomAndBounded(t *testing.T) {
	first, err := generateValue(32)
	if err != nil {
		t.Fatal(err)
	}
	second, err := generateValue(32)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("two generated values were identical")
	}
	// 32 bytes, base64url, unpadded.
	if len(first) != 43 {
		t.Errorf("length = %d, want 43", len(first))
	}
	if strings.ContainsAny(first, "+/=") {
		t.Errorf("%q is not url-safe", first)
	}
	if _, err := generateValue(4); err == nil {
		t.Error("a 4-byte secret must be refused")
	}
	if _, err := generateValue(4096); err == nil {
		t.Error("an absurd length must be refused")
	}
}

// A file's bytes are the value, trailing newline included — unlike a pipe,
// where the newline is the shell's framing. A PEM key ends in one.
func TestReadValueFileIsVerbatim(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key.pem")
	if err := os.WriteFile(path, []byte("-----BEGIN-----\nabc\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	value, err := readValueFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if value != "-----BEGIN-----\nabc\n" {
		t.Errorf("value = %q — the file's own bytes must survive", value)
	}

	empty := filepath.Join(t.TempDir(), "empty")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readValueFile(empty); err == nil {
		t.Error("an empty file must be refused rather than stored as an empty secret")
	}

	if _, err := readValueFile(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Error("a missing file must be refused")
	}
}

func TestSubcommandKeepsTheBareListing(t *testing.T) {
	cases := []struct {
		args []string
		bare string
		want string
	}{
		{nil, "list", "list"},
		{[]string{"--json"}, "list", "list"},
		{[]string{"list"}, "list", "list"},
		{[]string{"create"}, "list", "create"},
		{[]string{"delete"}, "list", "delete"},
		{[]string{"--help"}, "list", "help"},
		{[]string{"-h"}, "list", "help"},
		{[]string{"help"}, "list", "help"},
		{[]string{"nonsense"}, "list", "nonsense"},
		// `secrets` and `tokens` print usage when bare, but a leading flag still
		// means the listing — `xecret tokens --json` used to be an "unknown
		// subcommand" only because that command had its own dispatch.
		{nil, "help", "help"},
		{[]string{"--json"}, "help", "list"},
		{[]string{"--kind", "service"}, "help", "list"},
		{[]string{"revoke"}, "help", "revoke"},
	}
	for _, c := range cases {
		if got := subcommand(c.args, c.bare); got != c.want {
			t.Errorf("subcommand(%v, %q) = %q, want %q", c.args, c.bare, got, c.want)
		}
	}

	if got := listArgs([]string{"list", "--json"}); len(got) != 1 || got[0] != "--json" {
		t.Errorf("listArgs kept the verb: %v", got)
	}
	if got := listArgs([]string{"--json"}); len(got) != 1 || got[0] != "--json" {
		t.Errorf("listArgs(%v) changed a bare flag list", got)
	}
}

// os.WriteFile applies its permission argument only when it creates the file,
// so `export --force` over a .env already sitting at 0644 wrote every decrypted
// secret into a world-readable file while reporting "mode 0600".
func TestWriteSecretDocumentNarrowsAFileItOverwrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("OLD=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := writeSecretDocument(path, []byte("API_KEY=live\n")); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("mode = %04o after overwriting an existing file, want 0600", mode)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "API_KEY=live\n" {
		t.Errorf("contents = %q — the old file was not replaced", contents)
	}

	// And the create path is 0600 from the start, as it always was.
	fresh := filepath.Join(t.TempDir(), "secrets.json")
	if err := writeSecretDocument(fresh, []byte("{}")); err != nil {
		t.Fatal(err)
	}
	info, err = os.Stat(fresh)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("mode = %04o on a newly created file, want 0600", mode)
	}
}

func TestExportPathsAndFormats(t *testing.T) {
	for format, want := range map[string]string{
		"env":    ".env",
		"json":   "secrets.json",
		"yaml":   "secrets.yaml",
		"shell":  "secrets.sh",
		"docker": "docker.env",
	} {
		if got := defaultExportPath(format); got != want {
			t.Errorf("defaultExportPath(%q) = %q, want %q", format, got, want)
		}
		if !knownFormat(format) {
			t.Errorf("%q should be a known format", format)
		}
	}
	if knownFormat("toml") {
		t.Error("toml is not a format the server produces")
	}
}

func TestAuditRowFormatting(t *testing.T) {
	label := "ada@example.com"
	event := api.AuditEvent{
		ActorType:  "user",
		ActorLabel: &label,
		Action:     "secret.revealed",
		Metadata:   map[string]any{"projectSlug": "web", "environmentSlug": "production", "secretName": "API_KEY"},
	}
	if got := actorLabel(event); got != label {
		t.Errorf("actorLabel = %q", got)
	}
	if got := auditSubject(event); got != "web/production/API_KEY" {
		t.Errorf("auditSubject = %q", got)
	}

	// A deleted account leaves no label; the record still has to say something.
	anonymous := api.AuditEvent{ActorType: "serviceToken", Metadata: map[string]any{}}
	if got := actorLabel(anonymous); got != "serviceToken" {
		t.Errorf("actorLabel without a label = %q", got)
	}
	if got := auditSubject(anonymous); got != "—" {
		t.Errorf("auditSubject without metadata = %q", got)
	}
}

func TestTokenStateCollapsesTheTimestamps(t *testing.T) {
	past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)

	if got := tokenState(&past, nil, false); got != "revoked" {
		t.Errorf("revoked token = %q", got)
	}
	if got := tokenState(nil, &past, false); got != "expired" {
		t.Errorf("expired token = %q", got)
	}
	if got := tokenState(nil, &future, false); got != "active" {
		t.Errorf("live token = %q", got)
	}
	if got := tokenState(nil, nil, true); got != "active (this device)" {
		t.Errorf("current device = %q", got)
	}
}

func TestCheckKindRefusesAnAmbiguousRevocation(t *testing.T) {
	if err := checkKind("", true); err != nil {
		t.Error("the listing may default to both kinds")
	}
	if err := checkKind("", false); err == nil {
		t.Error("revocation must not guess which kind of token to kill")
	}
	if err := checkKind("both", true); err == nil {
		t.Error("an unknown kind must be refused")
	}
}

// The completion table is written by hand beside `dispatch`, so this is the
// check that stops the two drifting: every command the help text lists must be
// completable, and every completion must be a command the help text names.
func TestCompletionTableMatchesTheHelpText(t *testing.T) {
	for _, command := range completionTree {
		if !strings.Contains(usage, command.Name) {
			t.Errorf("%q is completable but absent from 'xecret help'", command.Name)
		}
	}

	scripts := map[string]string{
		"bash": bashCompletion(),
		"zsh":  zshCompletion(),
		"fish": fishCompletion(),
	}
	for shell, script := range scripts {
		for _, command := range completionTree {
			if !strings.Contains(script, command.Name) {
				t.Errorf("%s completion omits %q", shell, command.Name)
			}
			for _, sub := range command.Subcommands {
				if !strings.Contains(script, sub.Name) {
					t.Errorf("%s completion omits %q %q", shell, command.Name, sub.Name)
				}
			}
		}
	}

	// zsh reads a description up to the first colon, and the generated scripts
	// quote with single quotes.
	for _, command := range completionTree {
		for _, text := range append([]string{command.Description}, descriptions(command.Subcommands)...) {
			if strings.ContainsAny(text, ":'") {
				t.Errorf("description %q contains a character the generated scripts cannot quote", text)
			}
		}
	}
}

// A completion that offers a flag the command does not define completes to
// `flag provided but not defined: -project` — it breaks the very command it was
// invoked to help type. So the flag list hangs off each command, and this is
// the check that it stays that way.
func TestCompletionFlagsAreScopedToTheirCommand(t *testing.T) {
	flagsFor := func(path ...string) []string {
		for _, command := range completionTree {
			if command.Name != path[0] {
				continue
			}
			if len(path) == 1 {
				return command.Flags
			}
			for _, sub := range command.Subcommands {
				if sub.Name == path[1] {
					return sub.Flags
				}
			}
			t.Fatalf("no %q subcommand of %q in the completion tree", path[1], path[0])
		}
		t.Fatalf("no %q in the completion tree", path[0])
		return nil
	}
	holds := func(names []string, want string) bool {
		for _, name := range names {
			if name == want {
				return true
			}
		}
		return false
	}

	for _, c := range []struct {
		path []string
		flag string
		want bool
	}{
		{[]string{"secrets", "get"}, "--plain", true},
		{[]string{"secrets", "get"}, "--project", true},
		{[]string{"secrets", "annotate"}, "--rename", true},
		{[]string{"secrets", "annotate"}, "--json", false},
		{[]string{"secrets", "set"}, "--generate", true},
		{[]string{"orgs", "use"}, "--project", false},
		{[]string{"projects", "delete"}, "--project", false},
		{[]string{"projects", "create"}, "--slug", true},
		{[]string{"tokens", "revoke"}, "--json", false},
		{[]string{"tokens", "list"}, "--kind", true},
		{[]string{"doctor"}, "--project", false},
		{[]string{"upgrade"}, "--environment", false},
		{[]string{"members"}, "--project", false},
		{[]string{"export"}, "--force", true},
		{[]string{"run"}, "--offline", true},
	} {
		name := strings.Join(c.path, " ")
		if got := holds(flagsFor(c.path...), c.flag); got != c.want {
			t.Errorf("%q offers %s = %v, want %v", name, c.flag, got, c.want)
		}
	}

	// Every command that parses flags at all answers --help.
	for _, command := range completionTree {
		if len(command.Flags) > 0 && !holds(command.Flags, "--help") {
			t.Errorf("%q offers flags but not --help", command.Name)
		}
		for _, sub := range command.Subcommands {
			if len(sub.Flags) > 0 && !holds(sub.Flags, "--help") {
				t.Errorf("%q %q offers flags but not --help", command.Name, sub.Name)
			}
		}
	}

	// fish had one unconditional rule per common flag, which is exactly the
	// shape this test exists to prevent coming back.
	if strings.Contains(fishCompletion(), "\ncomplete -c xecret -l project\n") {
		t.Error("fish offers --project for every command, including those that do not define it")
	}
	if !strings.Contains(bashCompletion(), `"secrets get") flags=`) {
		t.Error("bash does not answer flags per subcommand")
	}
}

// `xecret <command> --help` is the documented way to see one command's flags,
// and the flag package reports it as an error. It is not one.
func TestSubcommandHelpExitsZero(t *testing.T) {
	for _, args := range [][]string{
		{"secrets", "get", "--help"},
		{"projects", "create", "-h"},
		{"audit", "--help"},
	} {
		if code := dispatch(args); code != 0 {
			t.Errorf("dispatch(%v) exited %d, want 0", args, code)
		}
	}
}

func TestCompletionDispatches(t *testing.T) {
	for _, shell := range []string{"bash", "zsh", "fish"} {
		if code := dispatch([]string{"completion", shell}); code != 0 {
			t.Errorf("completion %s exited %d", shell, code)
		}
	}
	if code := dispatch([]string{"completion", "powershell"}); code == 0 {
		t.Error("an unsupported shell must fail rather than print nothing")
	}
}

func descriptions(commands []completionCommand) []string {
	out := make([]string, len(commands))
	for i, command := range commands {
		out[i] = command.Description
	}
	return out
}
