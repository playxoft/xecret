package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `xecret vault open-archive`, end to end, against the archive in the shared
// vector file: the same bytes the TypeScript writer produced and the
// vaultarchive package opens.

const archiveVectorsPath = "../../../packages/core/src/vault-archive/vectors/vault-archive-vectors.json"

type archiveFixture struct {
	path          string
	passphrase    string
	recoveryCodes []string
}

func loadArchiveFixture(t *testing.T) archiveFixture {
	t.Helper()
	data, err := os.ReadFile(filepath.FromSlash(archiveVectorsPath))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Passphrase    string   `json:"passphrase"`
		RecoveryCodes []string `json:"recoveryCodes"`
		Vectors       []struct {
			ID       string `json:"id"`
			Expected struct {
				FileHex string `json:"fileHex"`
			} `json:"expected"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	for _, v := range file.Vectors {
		if v.ID != "vault-archive/file/single" {
			continue
		}
		archive, err := hex.DecodeString(v.Expected.FileHex)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "xecret-vault-archive-2026-10-12.zip")
		if err := os.WriteFile(path, archive, 0o600); err != nil {
			t.Fatal(err)
		}
		return archiveFixture{path: path, passphrase: file.Passphrase, recoveryCodes: file.RecoveryCodes}
	}
	t.Fatal("no single-part archive vector")
	return archiveFixture{}
}

type openerRun struct {
	stdout, stderr string
	err            error
}

func runOpener(t *testing.T, stdin string, tty bool, args ...string) openerRun {
	t.Helper()
	var stdout, stderr bytes.Buffer
	opener := &archiveOpener{
		stdin:        strings.NewReader(stdin),
		stdout:       &stdout,
		stderr:       &stderr,
		stdinIsTTY:   func() bool { return tty },
		readPassword: func() ([]byte, error) { return []byte(stdin), nil },
	}
	err := opener.run(args)
	return openerRun{stdout: stdout.String(), stderr: stderr.String(), err: err}
}

func TestOpenArchivePrintsTheValuesAndFailsOnDamage(t *testing.T) {
	fixture := loadArchiveFixture(t)
	// No account, no configuration, and an API that does not answer: nothing
	// in this command may need any of them.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XECRET_API_URL", "http://127.0.0.1:1")

	run := runOpener(t, fixture.passphrase+"\n", false, fixture.path, "--passphrase-stdin")

	for _, want := range []string{
		"# acme/payments-api/production",
		"DATABASE_URL=postgres://app:example-not-a-real-key@db.internal:5432/payments?sslmode=require",
		"LEGACY_TOKEN=legacy-token-example-not-a-real-key",
		"EMPTY_FLAG=",
		"#   NOTE_UNDER_OLD_KEY: This note was written under key version 1.",
		"# acme/web/staging",
		"API_URL=https://staging.example.com/api",
	} {
		if !strings.Contains(run.stdout, want) {
			t.Errorf("stdout lacks %q:\n%s", want, run.stdout)
		}
	}
	for _, absent := range []string{"this value must not be returned", "bot-token-example-not-a-real-key"} {
		if strings.Contains(run.stdout, absent) {
			t.Errorf("a damaged value reached stdout: %q", absent)
		}
	}
	if !strings.Contains(run.stderr, "plaintext secrets") {
		t.Error("the plaintext warning must go to stderr")
	}
	if !strings.Contains(run.stderr, "acme/payments-api/production NEVER_HELD") {
		t.Errorf("a no-key value must be reported:\n%s", run.stderr)
	}
	if run.err == nil || !strings.Contains(run.err.Error(), "2 value(s) in this archive are damaged") {
		t.Errorf("damage must fail the command, got %v", run.err)
	}
}

func TestOpenArchiveForOneCleanEnvironmentSucceeds(t *testing.T) {
	fixture := loadArchiveFixture(t)
	code := strings.ToLower(strings.ReplaceAll(fixture.recoveryCodes[0], "-", ""))

	run := runOpener(t, code, false, fixture.path, "--recovery-code", "--passphrase-stdin",
		"--environment", "acme/web/staging", "--format", "json")

	if run.err != nil {
		t.Fatalf("got %v\n%s", run.err, run.stderr)
	}
	var document map[string]map[string]string
	if err := json.Unmarshal([]byte(run.stdout), &document); err != nil {
		t.Fatalf("json output is not one document: %v\n%s", err, run.stdout)
	}
	staging := document["acme/web/staging"]
	if staging["API_URL"] != "https://staging.example.com/api" ||
		staging["MULTILINE"] != "line one\nline two\n\ttabbed \"quoted\" \\ backslash" {
		t.Errorf("unexpected values: %#v", staging)
	}
	if len(document) != 1 {
		t.Errorf("--environment must narrow the output to one environment, got %d", len(document))
	}
}

func TestOpenArchiveListsWithoutACredential(t *testing.T) {
	fixture := loadArchiveFixture(t)
	run := runOpener(t, "", false, fixture.path, "--list")
	if run.err != nil {
		t.Fatal(run.err)
	}
	for _, want := range []string{"Acme Corp / Payments API / Production  [production]", "acme/web/staging", "DATABASE_URL", "2 recovery code(s)"} {
		if !strings.Contains(run.stdout, want) {
			t.Errorf("--list lacks %q:\n%s", want, run.stdout)
		}
	}
	if strings.Contains(run.stdout, "example-not-a-real-key") {
		t.Error("--list must not open anything")
	}
}

func TestOpenArchiveWritesFilesUnderOutDir(t *testing.T) {
	fixture := loadArchiveFixture(t)
	dir := t.TempDir()

	run := runOpener(t, fixture.passphrase, true, fixture.path, "--environment", "staging", "--out-dir", dir)
	if run.err != nil {
		t.Fatalf("got %v", run.err)
	}
	if !strings.Contains(run.stderr, "input hidden") {
		t.Error("a terminal must be prompted on stderr")
	}
	written, err := os.ReadFile(filepath.Join(dir, "acme", "web", "staging.env"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), "API_URL=https://staging.example.com/api") {
		t.Errorf("unexpected file:\n%s", written)
	}
	if run.stdout != "" {
		t.Errorf("--out-dir must keep plaintext off stdout, got %q", run.stdout)
	}

	again := runOpener(t, fixture.passphrase, true, fixture.path, "--environment", "staging", "--out-dir", dir)
	if again.err == nil || !strings.Contains(again.err.Error(), "already exists") {
		t.Errorf("an existing file must not be overwritten without --force, got %v", again.err)
	}
}

func TestOpenArchiveRefusals(t *testing.T) {
	fixture := loadArchiveFixture(t)
	typo := "Z" + fixture.recoveryCodes[0][1:]
	if typo == fixture.recoveryCodes[0] {
		typo = "Y" + fixture.recoveryCodes[0][1:]
	}

	cases := []struct {
		name  string
		stdin string
		tty   bool
		args  []string
		want  string
	}{
		{"a wrong passphrase", "not it", false, []string{fixture.path, "--passphrase-stdin"}, "that passphrase does not open this archive"},
		{"a mistyped code", typo, false, []string{fixture.path, "--recovery-code", "--passphrase-stdin"}, "typo"},
		{"no terminal to ask on", "", false, []string{fixture.path}, "no terminal to ask on"},
		{"an unknown environment", "", false, []string{fixture.path, "--environment", "nope", "--list"}, "no environment"},
		{"an unknown format", "", false, []string{fixture.path, "--format", "xml"}, "unknown format"},
		{"no file", "", false, []string{}, "name one archive file"},
		{"a missing file", "", false, []string{filepath.Join(t.TempDir(), "absent.zip")}, "could not read"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			run := runOpener(t, c.stdin, c.tty, c.args...)
			if run.err == nil || !strings.Contains(run.err.Error(), c.want) {
				t.Errorf("got %v, want an error containing %q", run.err, c.want)
			}
			if strings.Contains(run.stdout, "example-not-a-real-key") {
				t.Error("a refused open must print nothing")
			}
		})
	}
}

func TestOpenArchiveRefusesANonArchive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	run := runOpener(t, "", false, path, "--list")
	if run.err == nil || !strings.Contains(run.err.Error(), "not a valid vault archive") {
		t.Errorf("got %v", run.err)
	}
}

func TestPathSegmentCannotEscapeTheDirectory(t *testing.T) {
	for input, want := range map[string]string{
		"..":            "_",
		".":             "_",
		"":              "_",
		"../../etc":     ".._.._etc",
		`a\b/c`:         "a_b_c",
		"production-eu": "production-eu",
	} {
		if got := pathSegment(input); got != want {
			t.Errorf("pathSegment(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestVaultCommandUsage(t *testing.T) {
	if err := cmdVault([]string{"nonsense"}); err == nil || !strings.Contains(err.Error(), "unknown vault command") {
		t.Errorf("got %v", err)
	}
}
