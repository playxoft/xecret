// Package policy is the half of an organisation's secret naming and strength
// policy (P19 §8) that only a client can enforce.
//
// ── Who enforces which rule, stated plainly ──
//
// Names are plaintext (ADR 0009, trade-off 1), so the **name** rule is the
// server's: it runs on every write that introduces a name, and nothing here
// repeats it. A regular expression evaluated by two engines is two answers to
// one question, and the server's is the one that counts.
//
// Values are not plaintext anywhere but here. The server never sees one, so the
// **value** rules — minimum entropy, forbidden substrings — are enforced by the
// clients that hold the plaintext: the dashboard as you type, and this CLI
// before it encrypts. A client somebody has modified can skip them, and nothing
// on the server can tell. That is the same concession every value-shape check
// makes under end-to-end encryption, and the documentation says so rather than
// implying an enforcement that does not exist.
//
// This is a port of `checkValueAgainstPolicy`, `estimateEntropyBits` and
// `policyApplies` from `packages/core/src/policy/secret-policy.ts`, and
// `policy-fixtures.json` beside that file is the contract both suites read: a
// value the dashboard accepts is a value `xecret secrets set` accepts.
//
// ── What a violation may say ──
//
// The rule, never the value. Every message is assembled from fixed strings, the
// policy's own numbers and the secret's name; the forbidden-substring rule does
// not even name *which* word matched, because the word is a fragment of the
// value and an error message is the easiest place in a system for a credential
// to escape into a log.
package policy

import (
	"fmt"
	"math"
	"strings"

	"github.com/playxoft/xecret/cli/internal/references"
)

// SecretPolicy is the `secrets` half of `GET /api/orgs/{org}/policies`.
type SecretPolicy struct {
	// Enabled is off until an administrator turns it on.
	Enabled bool `json:"enabled"`
	// Scope is "all" or "production". Anything else governs production only,
	// which is what the TypeScript's `scope === 'all' || isProduction` does with
	// a value it does not know.
	Scope string `json:"scope"`
	// NamePattern is carried and never evaluated here — see the package header.
	NamePattern *string `json:"namePattern"`
	// MinValueEntropyBits is nil for no minimum.
	MinValueEntropyBits *int `json:"minValueEntropyBits"`
	// EntropyAppliesTo is which names the entropy rule applies to: any name
	// containing one of these, case-insensitively. Empty means every name.
	EntropyAppliesTo []string `json:"entropyAppliesTo"`
	// ForbiddenSubstrings may not appear in a value, case-insensitively.
	ForbiddenSubstrings []string `json:"forbiddenSubstrings"`
}

// Rule names, stable for a caller to branch on and the strings the fixtures
// carry.
const (
	RuleMinValueEntropyBits = "minValueEntropyBits"
	RuleForbiddenSubstrings = "forbiddenSubstrings"
)

// Violation is one broken rule. Rule is for code; Message is for people.
type Violation struct {
	Rule    string
	Message string
}

// PolicyApplies reports whether a policy governs an environment at all.
func PolicyApplies(policy SecretPolicy, isProduction bool) bool {
	return policy.Enabled && (policy.Scope == "all" || isProduction)
}

// CheckValueAgainstPolicy applies the value rules, entropy first, before a
// value is encrypted. See the package header for why that is a concession and
// not a guarantee.
//
// valueType is the type the secret will hold once the write lands. A template's
// text is not its value — `postgres://${DB_USER}@${DB_HOST}` carries no
// credential of its own, and the secrets it names are held to these rules where
// they are written — so a template that actually holds a reference is not asked
// the entropy rule. A template that parses to no reference at all is a plain
// value wearing the template type, so it is held to the entropy rule exactly as
// a plain value is (review round 2, F3); a template that does not parse is
// checked whole, because it is about to be refused for its syntax anyway.
// Either way the forbidden-word rule reads its literal text only, each piece on
// a line of its own, so a reference named DB_PASSWORD is not taken for the word
// "password". This is the TypeScript's rule, pinned by the template cases in
// policy-fixtures.json (review round 1, M5; review round 2, F3).
//
// One violation per rule, however many forbidden words match: the message for
// the second rule is the same sentence whichever word it was, by design.
func CheckValueAgainstPolicy(policy SecretPolicy, name, value string, isProduction bool, valueType string) []Violation {
	if !PolicyApplies(policy, isProduction) {
		return nil
	}
	var violations []Violation
	template := valueType == templateValueType
	text := value
	referenceFree := false
	if template {
		text, referenceFree = literalText(value)
	}

	// Exempt only a template that actually holds a reference — one that
	// parses to none is a plain value in every way the entropy rule can see.
	entropyExempt := template && !referenceFree

	if !entropyExempt && policy.MinValueEntropyBits != nil && entropyRuleApplies(policy, name) {
		if EstimateEntropyBits(text) < *policy.MinValueEntropyBits {
			violations = append(violations, Violation{
				Rule: RuleMinValueEntropyBits,
				Message: fmt.Sprintf(
					"This organisation requires values of secrets like %s to carry at least "+
						"%d bits of entropy. Generate a longer, more random value.",
					name, *policy.MinValueEntropyBits),
			})
		}
	}

	lowered := strings.ToLower(text)
	for _, entry := range policy.ForbiddenSubstrings {
		if strings.Contains(lowered, strings.ToLower(entry)) {
			violations = append(violations, Violation{
				Rule:    RuleForbiddenSubstrings,
				Message: "This value contains one of the organisation's forbidden words.",
			})
			break
		}
	}

	return violations
}

// templateValueType is the declared type whose values are read for references.
const templateValueType = "template"

// literalText is a template's literal text, each piece on a line of its own so
// a word cannot be assembled across a reference, and whether it parsed to no
// reference at all (review round 2, F3). A template that does not parse is
// returned whole, and never reference-free: it is about to be refused for its
// syntax anyway, so it is checked as plainly as possible rather than leniently.
func literalText(value string) (string, bool) {
	segments, err := references.ParseTemplate(value)
	if err != nil {
		return value, false
	}
	pieces := make([]string, 0, len(segments))
	referenceFree := true
	for _, segment := range segments {
		if segment.Reference == nil {
			pieces = append(pieces, segment.Text)
		} else {
			referenceFree = false
		}
	}
	return strings.Join(pieces, "\n"), referenceFree
}

func entropyRuleApplies(policy SecretPolicy, name string) bool {
	if len(policy.EntropyAppliesTo) == 0 {
		return true
	}
	upper := strings.ToUpper(name)
	for _, entry := range policy.EntropyAppliesTo {
		if strings.Contains(upper, strings.ToUpper(entry)) {
			return true
		}
	}
	return false
}

// EstimateEntropyBits is an estimate of a value's entropy, in bits: its length
// in code points times the Shannon entropy of its own code-point distribution,
// rounded half up.
//
// An estimate, and a conservative one for random strings — a 32-character
// base64 token scores about 150 bits, `password1` about 28 — which is the
// direction a strength rule should err in. It does not know about dictionaries
// or keyboard walks; the forbidden-substring rule is the tool for those.
//
// ── Bit for bit with the TypeScript ──
//
// The sum is taken in the order each code point first appears, which is the
// order a JavaScript Map iterates in. Floating-point addition is not
// associative, so summing in Go's randomised map order could move a value that
// sits a hair from x.5 to the other side of it on one run in a million and not
// the next. Rounding is `floor(x + 0.5)`, which is `Math.round` for every
// non-negative input — and an entropy is never negative.
func EstimateEntropyBits(value string) int {
	characters := []rune(value)
	if len(characters) == 0 {
		return 0
	}

	counts := map[rune]int{}
	var order []rune
	for _, character := range characters {
		if counts[character] == 0 {
			order = append(order, character)
		}
		counts[character]++
	}

	total := float64(len(characters))
	perCharacter := 0.0
	for _, character := range order {
		probability := float64(counts[character]) / total
		perCharacter -= probability * math.Log2(probability)
	}
	return int(math.Floor(perCharacter*total + 0.5))
}
