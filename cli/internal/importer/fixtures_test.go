// The cross-implementation contract for the import parsers.
//
// Every expectation in `import-fixtures.json` was produced by the TypeScript
// parsers under `packages/core/src/importer`. This file reproduces them from the
// Go port, which is the only thing that makes two parsers for one unspecified
// format survivable: a `.env` file has no standard, so every rule either
// implementation follows is a decision somebody could reasonably have made
// differently, and the file is where the two agree on which decision it was.
//
// It is the importer's equivalent of `e2ee/vectors_test.go`, and it is read the
// same way: a failure names the case, and the case names the construct.
package importer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const fixturesPath = "../../../packages/core/src/importer/fixtures/import-fixtures.json"

type fixtureFile struct {
	Cases []fixture `json:"cases"`
}

type fixture struct {
	ID          string `json:"id"`
	Format      string `json:"format"`
	Description string `json:"description"`
	Source      string `json:"source"`
	Expected    struct {
		Entries  []Entry          `json:"entries"`
		Warnings []fixtureWarning `json:"warnings"`
	} `json:"expected"`
	Plan *fixturePlan `json:"plan"`
}

// fixtureWarning's fields are nil where they belong to a parsing library rather
// than to this repository.
//
// Message is nil for a JSON or YAML document error, whose prose is the
// library's. Line is nil for a YAML *syntax* error alone, because the two
// libraries disagree about where a broken flow sequence went wrong — one reports
// where it opened, the other where it was detected — and neither is wrong.
// Every other position here is one both implementations compute and must agree
// on.
type fixtureWarning struct {
	Line    *int    `json:"line"`
	Message *string `json:"message"`
}

type fixturePlan struct {
	Strategy      string   `json:"strategy"`
	ExistingNames []string `json:"existingNames"`
	Items         []struct {
		SourceKey  string  `json:"sourceKey"`
		TargetName string  `json:"targetName"`
		Status     string  `json:"status"`
		Note       *string `json:"note"`
	} `json:"items"`
}

func loadFixtures(t *testing.T) []fixture {
	t.Helper()

	data, err := os.ReadFile(filepath.FromSlash(fixturesPath))
	if err != nil {
		t.Fatalf("reading the fixture file: %v", err)
	}

	var file fixtureFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parsing the fixture file: %v", err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("the fixture file carries no cases")
	}
	return file.Cases
}

// TestParserFixtures is the contract itself.
func TestParserFixtures(t *testing.T) {
	for _, entry := range loadFixtures(t) {
		result := Parse(entry.Source, Format(entry.Format))

		if len(result.Entries) != len(entry.Expected.Entries) {
			t.Errorf("%s: parsed %d entries, want %d\n got %v\nwant %v",
				entry.ID, len(result.Entries), len(entry.Expected.Entries),
				result.Entries, entry.Expected.Entries)
			continue
		}

		// Order is compared, not just membership. The planner's first-seen-wins
		// rule for two keys that normalise to one name depends on it, so a
		// parser that returned the right set in the wrong order would import a
		// different value under a contested name.
		for i, want := range entry.Expected.Entries {
			got := result.Entries[i]
			if got.Key != want.Key {
				t.Errorf("%s: entry %d key\n got %q\nwant %q", entry.ID, i, got.Key, want.Key)
			}
			if got.Value != want.Value {
				t.Errorf("%s: %q value\n got %q\nwant %q", entry.ID, want.Key, got.Value, want.Value)
			}
			if got.Line != want.Line {
				t.Errorf("%s: %q line got %d want %d", entry.ID, want.Key, got.Line, want.Line)
			}
		}

		if len(result.Warnings) != len(entry.Expected.Warnings) {
			t.Errorf("%s: produced %d warnings, want %d\n got %v",
				entry.ID, len(result.Warnings), len(entry.Expected.Warnings), result.Warnings)
			continue
		}
		for i, want := range entry.Expected.Warnings {
			got := result.Warnings[i]
			if want.Line != nil && got.Line != *want.Line {
				t.Errorf("%s: warning %d line got %d want %d", entry.ID, i, got.Line, *want.Line)
			}
			if want.Line == nil && got.Line < 1 {
				t.Errorf("%s: warning %d points at no line at all", entry.ID, i)
			}
			if want.Message == nil {
				// The wording is this implementation's own; only its presence is
				// contractual. It must still say something.
				if got.Message == "" {
					t.Errorf("%s: warning %d carries no message", entry.ID, i)
				}
				continue
			}
			if got.Message != *want.Message {
				t.Errorf("%s: warning %d message\n got %q\nwant %q",
					entry.ID, i, got.Message, *want.Message)
			}
		}
	}
}

// TestPlanFixtures covers the half of the import that turns a source key into a
// secret name — where a disagreement stores a value under a name the user did
// not choose, which is worse than a parse that fails.
func TestPlanFixtures(t *testing.T) {
	planned := 0

	for _, entry := range loadFixtures(t) {
		if entry.Plan == nil {
			continue
		}
		planned++

		parsed := Parse(entry.Source, Format(entry.Format))
		plan := BuildPlan(parsed, entry.Plan.ExistingNames, Strategy(entry.Plan.Strategy))

		if len(plan.Items) != len(entry.Plan.Items) {
			t.Errorf("%s: planned %d items, want %d", entry.ID, len(plan.Items), len(entry.Plan.Items))
			continue
		}

		for i, want := range entry.Plan.Items {
			got := plan.Items[i]
			if got.SourceKey != want.SourceKey {
				t.Errorf("%s: item %d sourceKey\n got %q\nwant %q",
					entry.ID, i, got.SourceKey, want.SourceKey)
			}
			if got.TargetName != want.TargetName {
				t.Errorf("%s: %q targetName\n got %q\nwant %q",
					entry.ID, want.SourceKey, got.TargetName, want.TargetName)
			}
			if string(got.Status) != want.Status {
				t.Errorf("%s: %q status got %q want %q",
					entry.ID, want.SourceKey, got.Status, want.Status)
			}

			wantNote := ""
			if want.Note != nil {
				wantNote = *want.Note
			}
			if got.Note != wantNote {
				t.Errorf("%s: %q note\n got %q\nwant %q",
					entry.ID, want.SourceKey, got.Note, wantNote)
			}
		}
	}

	if planned == 0 {
		t.Fatal("no fixture exercises the planner")
	}
	t.Logf("validated %d planning fixtures", planned)
}

// TestEveryFormatIsCovered fails when the fixture file grows a format this
// package does not parse — the same guard the crypto vectors keep over kinds.
func TestEveryFormatIsCovered(t *testing.T) {
	counts := map[string]int{}
	for _, entry := range loadFixtures(t) {
		counts[entry.Format]++
		if !KnownFormat(entry.Format) {
			t.Errorf("fixture %s uses format %q, which this package does not parse",
				entry.ID, entry.Format)
		}
	}

	for _, format := range []Format{FormatDotenv, FormatJSON, FormatYAML, FormatShell} {
		if counts[string(format)] == 0 {
			t.Errorf("no %q fixtures; this package's coverage claim is stale", format)
		}
	}
	t.Logf("validated %d fixtures across %d formats", len(loadFixtures(t)), len(counts))
}
