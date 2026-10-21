package policy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The value rules as both clients must apply them. policy-fixtures.json is read
// by this file and by packages/core/src/policy/fixtures/fixtures.test.ts, so a
// value the dashboard accepts is a value `xecret secrets set` accepts.
const fixturesPath = "../../../packages/core/src/policy/fixtures/policy-fixtures.json"

type fixtureFile struct {
	// NamePatterns is read only by this package's own backtracking-guard
	// port (review round 2, F2) — the name rule itself stays the server's
	// alone; see name_pattern.go.
	NamePatterns []struct {
		Name    string `json:"name"`
		Pattern string `json:"pattern"`
		Safe    bool   `json:"safe"`
	} `json:"namePatterns"`
	Entropy []struct {
		Value string `json:"value"`
		Bits  int    `json:"bits"`
	} `json:"entropy"`
	Values []struct {
		Name         string       `json:"name"`
		Policy       SecretPolicy `json:"policy"`
		SecretName   string       `json:"secretName"`
		Value        string       `json:"value"`
		ValueType    string       `json:"valueType"`
		IsProduction bool         `json:"isProduction"`
		Violations   []string     `json:"violations"`
	} `json:"values"`
}

func loadFixtures(t *testing.T) fixtureFile {
	t.Helper()
	data, err := os.ReadFile(filepath.FromSlash(fixturesPath))
	if err != nil {
		t.Fatalf("reading the fixture file: %v", err)
	}
	var file fixtureFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parsing the fixture file: %v", err)
	}
	if len(file.Entropy) == 0 || len(file.Values) == 0 {
		t.Fatalf("the fixture file carries %d entropy and %d value cases", len(file.Entropy), len(file.Values))
	}
	return file
}

func TestEntropyFixtures(t *testing.T) {
	cases := loadFixtures(t).Entropy
	for _, c := range cases {
		if got := EstimateEntropyBits(c.Value); got != c.Bits {
			t.Errorf("EstimateEntropyBits(%q) = %d, want %d", c.Value, got, c.Bits)
		}
	}
	t.Logf("checked %d entropy cases", len(cases))
}

// TestNamePatternFixtures checks this package's own port of the backtracking
// guard against the same patterns the TypeScript suite refuses or accepts
// (review round 2, F2). Go's regexp (RE2) is linear-time and never at risk
// from these shapes; what this proves is only that the port agrees with the
// TypeScript it was copied from, pattern for pattern.
func TestNamePatternFixtures(t *testing.T) {
	cases := loadFixtures(t).NamePatterns
	if len(cases) == 0 {
		t.Fatal("the fixture file carries no namePatterns cases")
	}
	for _, c := range cases {
		if got := NamePatternIsSafe(c.Pattern); got != c.Safe {
			t.Errorf("%s: NamePatternIsSafe(%q) = %v, want %v", c.Name, c.Pattern, got, c.Safe)
		}
	}
	t.Logf("checked %d name pattern cases", len(cases))
}

func TestValueFixtures(t *testing.T) {
	cases := loadFixtures(t).Values
	for _, c := range cases {
		rules := []string{}
		for _, violation := range CheckValueAgainstPolicy(c.Policy, c.SecretName, c.Value, c.IsProduction, c.ValueType) {
			rules = append(rules, violation.Rule)
		}
		if !reflect.DeepEqual(rules, c.Violations) {
			t.Errorf("%s: violations = %v, want %v", c.Name, rules, c.Violations)
		}
	}
	t.Logf("checked %d value cases", len(cases))
}

// The rule, never the value — and the forbidden-substring rule does not even
// name which word matched, because the word is a fragment of the value.
func TestAViolationNeverCarriesTheValueOrTheWord(t *testing.T) {
	minimum := 512
	policy := SecretPolicy{
		Enabled:             true,
		Scope:               "all",
		MinValueEntropyBits: &minimum,
		ForbiddenSubstrings: []string{"hunter2"},
	}
	const value = "my-HUNTER2-password"

	violations := CheckValueAgainstPolicy(policy, "DB_PASSWORD", value, false, "")
	if len(violations) != 2 {
		t.Fatalf("violations = %+v, want both rules", violations)
	}
	for _, violation := range violations {
		lowered := strings.ToLower(violation.Message)
		if strings.Contains(lowered, "hunter2") || strings.Contains(violation.Message, value) {
			t.Errorf("%s carries the value or the word: %s", violation.Rule, violation.Message)
		}
	}
	if !strings.Contains(violations[0].Message, "DB_PASSWORD") || !strings.Contains(violations[0].Message, "512") {
		t.Errorf("the entropy message should name the secret and the minimum: %s", violations[0].Message)
	}
}

// One violation per rule, however many forbidden words match.
func TestForbiddenWordsAreOneViolation(t *testing.T) {
	policy := SecretPolicy{Enabled: true, Scope: "all", ForbiddenSubstrings: []string{"a", "b", "c"}}
	if violations := CheckValueAgainstPolicy(policy, "X", "abc", false, ""); len(violations) != 1 {
		t.Fatalf("violations = %+v, want exactly one", violations)
	}
}

func TestAppliesHonoursTheScope(t *testing.T) {
	for _, c := range []struct {
		policy       SecretPolicy
		isProduction bool
		want         bool
	}{
		{SecretPolicy{Enabled: false, Scope: "all"}, true, false},
		{SecretPolicy{Enabled: true, Scope: "all"}, false, true},
		{SecretPolicy{Enabled: true, Scope: "production"}, false, false},
		{SecretPolicy{Enabled: true, Scope: "production"}, true, true},
		// A scope this build does not know governs production only, as the
		// TypeScript's comparison does.
		{SecretPolicy{Enabled: true, Scope: "staging"}, false, false},
	} {
		if got := PolicyApplies(c.policy, c.isProduction); got != c.want {
			t.Errorf("PolicyApplies(%+v, %v) = %v, want %v", c.policy, c.isProduction, got, c.want)
		}
	}
}
