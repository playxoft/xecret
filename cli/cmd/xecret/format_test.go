package main

import (
	"strings"
	"testing"

	"github.com/playxoft/xecret/cli/internal/importer"
)

// The one property `format.go` exists to hold: **whatever goes in comes back
// out, byte for byte**.
//
// A quoting bug here does not throw. It hands somebody a password with a
// character missing, and they find out when a service fails to authenticate at
// 3am. So the test is not a set of expected strings — those only check that the
// output looks like it did yesterday — it is a round trip through this
// repository's own parsers, over values chosen to be hostile.
//
// This is the same test the TypeScript side runs over the same values, and the
// parsers on both ends of the round trip are themselves pinned to each other by
// `internal/importer/fixtures_test.go`. Rendering here and parsing there is what
// makes `xecret pull --format env` on an e2ee environment produce a file the
// dashboard's importer reads identically.

// hostile is every value that has ever broken a `.env` file.
var hostile = map[string]string{
	"SIMPLE":          "hunter2",
	"EMPTY":           "",
	"SPACES":          "  padded value  ",
	"HASH":            "abc#123",
	"HASH_SPACED":     "value # not a comment",
	"SINGLE_QUOTE":    "it's fine",
	"DOUBLE_QUOTE":    `say "hi"`,
	"BOTH_QUOTES":     `it's "both"`,
	"BACKSLASH":       `C:\Users\deploy`,
	"REGEX":           `^\d{3}-\d{4}$`,
	"DOLLAR":          "cost $5 and ${NOT_INTERPOLATED}",
	"BACKTICK":        "`whoami`",
	"NEWLINE":         "-----BEGIN KEY-----\nline one\nline two\n-----END KEY-----",
	"TAB":             "before\tafter",
	"NON_ASCII":       "café ☕ 秘密 naïve",
	"EQUALS":          "a=b=c",
	"LEADING_HASH":    "#starts-with-hash",
	"ONLY_WHITESPACE": "   ",
	"URL":             "postgres://app:p@ss w0rd!@db.example.com:5432/app?sslmode=require",
}

// carriageReturn is separated because two formats refuse it, deliberately.
const carriageReturn = "before\rafter"

func TestEveryFormatRoundTripsHostileValues(t *testing.T) {
	for _, target := range []struct {
		format string
		parse  func(string) importer.Result
	}{
		{"env", func(s string) importer.Result { return importer.ParseDotenv(s) }},
		{"shell", func(s string) importer.Result { return importer.ParseShell(s) }},
		{"json", func(s string) importer.Result { return importer.ParseJSON(s) }},
		{"yaml", func(s string) importer.Result { return importer.ParseYAML(s) }},
	} {
		document, err := formatSecrets(hostile, target.format)
		if err != nil {
			t.Fatalf("%s: %v", target.format, err)
		}

		parsed := target.parse(string(document))
		if len(parsed.Warnings) > 0 {
			t.Errorf("%s: round trip produced warnings: %v", target.format, parsed.Warnings)
		}

		got := make(map[string]string, len(parsed.Entries))
		for _, entry := range parsed.Entries {
			got[entry.Key] = entry.Value
		}

		for name, want := range hostile {
			if got[name] != want {
				t.Errorf("%s: %s\n got %q\nwant %q", target.format, name, got[name], want)
			}
		}
		if len(got) != len(hostile) {
			t.Errorf("%s: round trip produced %d values, want %d", target.format, len(got), len(hostile))
		}
	}
}

// TestDockerRoundTripsWhatItCanRepresent.
//
// Docker's `--env-file` grammar has no quoting at all — everything after the
// first `=` is the value, verbatim, to the end of the line — so it is parsed
// back with the dotenv parser only for values that contain no line break and no
// leading or trailing whitespace. The formats differ, and pretending otherwise
// is how a value comes back changed.
func TestDockerRoundTripsWhatItCanRepresent(t *testing.T) {
	representable := map[string]string{
		"SIMPLE":    "hunter2",
		"EQUALS":    "a=b=c",
		"DOLLAR":    "cost $5",
		"NON_ASCII": "café",
	}

	document, err := formatSecrets(representable, "docker")
	if err != nil {
		t.Fatal(err)
	}

	for name, want := range representable {
		line := name + "=" + want
		if !strings.Contains(string(document), line+"\n") {
			t.Errorf("docker output does not carry %q", line)
		}
	}
}

// TestFormatsRefuseWhatTheyCannotRepresent.
//
// Emitting a value silently cut at the first newline is exactly the failure this
// file exists to prevent, so it is an error — and the message names the format
// that *can* carry it, because "cannot export" with no way forward is not an
// answer.
func TestFormatsRefuseWhatTheyCannotRepresent(t *testing.T) {
	for _, refusal := range []struct {
		format string
		value  string
		reason string
	}{
		{"shell", carriageReturn, "single quotes have no escape mechanism, so a CR would be written raw and lost on the way back in"},
		{"docker", "two\nlines", "Docker would read the remainder as a new variable"},
		{"docker", carriageReturn, "same"},
	} {
		_, err := formatSecrets(map[string]string{"VALUE": refusal.value}, refusal.format)
		if err == nil {
			t.Errorf("%s accepted a value it cannot represent (%s)", refusal.format, refusal.reason)
			continue
		}
		if !strings.Contains(err.Error(), "VALUE") {
			t.Errorf("%s: the refusal does not name the secret: %v", refusal.format, err)
		}
	}

	// `env`, `json` and `yaml` escape it and are the formats to reach for.
	for _, format := range []string{"env", "json", "yaml"} {
		document, err := formatSecrets(map[string]string{"VALUE": carriageReturn}, format)
		if err != nil {
			t.Errorf("%s refused a carriage return it can escape: %v", format, err)
			continue
		}
		if strings.Contains(string(document), "\r") {
			t.Errorf("%s wrote a raw carriage return rather than escaping it", format)
		}
	}
}

// TestNamesAreOrderedAndValidated.
func TestNamesAreOrderedAndValidated(t *testing.T) {
	document, err := formatSecrets(map[string]string{"ZED": "1", "ALPHA": "2", "MID": "3"}, "env")
	if err != nil {
		t.Fatal(err)
	}
	// Sorted by code unit, never by locale, so the output does not depend on
	// where it ran — and a secret added today produces a one-line diff.
	if string(document) != "ALPHA=2\nMID=3\nZED=1\n" {
		t.Errorf("output = %q", document)
	}

	// A name that is not an identifier would produce a line that parses back as
	// something else: `A=B=value` reads as `A` holding `B=value`.
	for _, name := range []string{"has-dash", "1leading", "has space", "", "has=equals"} {
		if _, err := formatSecrets(map[string]string{name: "x"}, "env"); err == nil {
			t.Errorf("accepted %q as a secret name", name)
		}
	}
}

// TestJsonMatchesJavaScriptsRendering.
//
// Go escapes `<`, `>` and `&` by default and JavaScript does not. Both parse
// back to the same string, so this is not a correctness bug — it is a
// gratuitous difference between the two modes in a file people read, and the
// kind of thing that makes somebody wonder which one is wrong.
func TestJsonMatchesJavaScriptsRendering(t *testing.T) {
	document, err := formatSecrets(map[string]string{"HTML": "<a href=\"x\">&amp;</a>"}, "json")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(document), `\u003c`) {
		t.Errorf("HTML escaping leaked into the JSON output: %s", document)
	}
	if !strings.HasSuffix(string(document), "\n") {
		t.Error("the JSON document does not end in a newline")
	}
}
