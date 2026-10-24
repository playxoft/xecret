package references

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// What a writer declares is the set of references in the text, deduplicated by
// key and in the order they first appear — the order is what makes two writers
// of the same template send the same body.
func TestTemplateReferencesDedupesInFirstAppearanceOrder(t *testing.T) {
	refs, err := TemplateReferences("${B}${staging.A}${B}${core.prod.A}${staging.A}$${NOT_ONE}")
	if err != nil {
		t.Fatal(err)
	}
	want := []Reference{
		{Name: "B"},
		{Environment: "staging", Name: "A"},
		{Project: "core", Environment: "prod", Name: "A"},
	}
	if len(refs) != len(want) {
		t.Fatalf("refs = %+v, want %+v", refs, want)
	}
	for i := range want {
		if refs[i] != want[i] {
			t.Errorf("refs[%d] = %+v, want %+v", i, refs[i], want[i])
		}
	}
}

// A template with no references declares an empty list, not an absent one: the
// server requires a template's write to say what it references, and "nothing"
// is an answer.
func TestATemplateWithNoReferencesDeclaresAnEmptyList(t *testing.T) {
	refs, err := TemplateReferences("plain text, $$ and $${ESCAPED}")
	if err != nil {
		t.Fatal(err)
	}
	if refs == nil || len(refs) != 0 {
		t.Fatalf("refs = %#v, want an empty, non-nil list", refs)
	}
}

func TestTemplateReferencesRefusesMoreThanTheLimit(t *testing.T) {
	var b strings.Builder
	for i := 0; i <= MaxReferencesPerSecret; i++ {
		fmt.Fprintf(&b, "${K%d}", i)
	}
	_, err := TemplateReferences(b.String())
	var syntax *SyntaxError
	if !errors.As(err, &syntax) {
		t.Fatalf("%d distinct references: err = %v, want a syntax error", MaxReferencesPerSecret+1, err)
	}

	// Repeats are one reference, so the limit counts distinct keys.
	b.Reset()
	for i := 0; i < 200; i++ {
		b.WriteString("${SAME}")
	}
	if _, err := TemplateReferences(b.String()); err != nil {
		t.Fatalf("200 copies of one reference: %v", err)
	}
}

// The error is the easiest place in a system for a credential to escape into a
// log, so neither syntax message may carry any part of the template.
func TestASyntaxErrorNeverCarriesTheValue(t *testing.T) {
	for _, template := range []string{
		"postgres://admin:hunter2-SECRET@db/${UNCLOSED",
		"postgres://admin:hunter2-SECRET@db/${not valid}",
	} {
		_, err := ParseTemplate(template)
		if err == nil {
			t.Fatalf("%q parsed", template)
		}
		for _, fragment := range []string{"hunter2", "SECRET", "postgres", "not valid", "UNCLOSED"} {
			if strings.Contains(err.Error(), fragment) {
				t.Errorf("the error for a malformed template echoes %q: %s", fragment, err)
			}
		}
	}
}

// The offset is the TypeScript's: UTF-16 code units, so a rune outside the
// Basic Multilingual Plane counts twice and the dashboard and the terminal point
// at the same character.
func TestTheSyntaxOffsetCountsUTF16CodeUnits(t *testing.T) {
	for _, c := range []struct {
		template string
		offset   int
	}{
		{"${", 0},
		{"abc${", 3},
		{"é${", 1},
		{"🔑${", 2},
		{"🔑é ${ bad }", 4},
	} {
		_, err := ParseTemplate(c.template)
		var syntax *SyntaxError
		if !errors.As(err, &syntax) {
			t.Fatalf("%q: err = %v", c.template, err)
		}
		if syntax.Offset != c.offset {
			t.Errorf("%q: offset = %d, want %d", c.template, syntax.Offset, c.offset)
		}
	}
}

// Text around and between references survives byte for byte, including runes
// that are not ASCII — the walk is over bytes, and this is what proves it never
// splits one.
func TestTextSurvivesTheByteWalk(t *testing.T) {
	segments, err := ParseTemplate("café→${A}🔑$")
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 3 || segments[0].Text != "café→" || segments[2].Text != "🔑$" {
		t.Fatalf("segments = %+v", segments)
	}
	if segments[1].Reference == nil || segments[1].Reference.Name != "A" {
		t.Fatalf("segment 1 = %+v", segments[1])
	}
}

func TestReferenceKeyAndFormat(t *testing.T) {
	for _, c := range []struct {
		reference Reference
		key       string
	}{
		{Reference{Name: "A"}, "A"},
		{Reference{Environment: "eu_west", Name: "A"}, "eu_west.A"},
		{Reference{Project: "core", Environment: "prod", Name: "A"}, "core.prod.A"},
	} {
		if got := ReferenceKey(c.reference); got != c.key {
			t.Errorf("ReferenceKey(%+v) = %q, want %q", c.reference, got, c.key)
		}
		formatted := FormatReference(c.reference)
		parsed, err := TemplateReferences(formatted)
		if err != nil || len(parsed) != 1 || parsed[0] != c.reference {
			t.Errorf("%q did not round-trip: %+v, %v", formatted, parsed, err)
		}
	}
}

// A resolution error names secrets and references and never a value, whatever
// the kind — the values in this graph are distinctive so any leak is visible.
func TestResolutionErrorsNeverCarryAValue(t *testing.T) {
	graphs := map[string]Graph{
		"cycle": {"e": {ID: "e", Secrets: map[string]*Secret{
			"A": {ID: "a", Template: true, Value: "LEAK-A ${B}",
				References: []DeclaredReference{{Reference: Reference{Name: "B"}}}},
			"B": {ID: "b", Template: true, Value: "LEAK-B ${A}",
				References: []DeclaredReference{{Reference: Reference{Name: "A"}}}},
		}}},
		"undeclared": {"e": {ID: "e", Secrets: map[string]*Secret{
			"A": {ID: "a", Template: true, Value: "LEAK-A ${B}"},
			"B": {ID: "b", Value: "LEAK-B"},
		}}},
		"syntax": {"e": {ID: "e", Secrets: map[string]*Secret{
			"A": {ID: "a", Template: true, Value: "LEAK-A ${B",
				References: []DeclaredReference{{Reference: Reference{Name: "B"}}}},
			"B": {ID: "b", Value: "LEAK-B"},
		}}},
	}
	for kind, graph := range graphs {
		_, err := ResolveEnvironment(graph, "e")
		var resolution *ResolutionError
		if !errors.As(err, &resolution) || string(resolution.Kind) != kind {
			t.Fatalf("%s: err = %v", kind, err)
		}
		if strings.Contains(err.Error(), "LEAK") {
			t.Errorf("%s: the message carries a value: %s", kind, err)
		}
		if !strings.Contains(err.Error(), "A") {
			t.Errorf("%s: the message does not name the secret: %s", kind, err)
		}
	}
}

// The memo makes a diamond cheap; it must not make a shared subtree look
// shallower than it is when it is reached a second time from further down.
func TestTheMemoStillCountsDepthThroughAFinishedNode(t *testing.T) {
	chain := func(names ...string) map[string]*Secret {
		secrets := map[string]*Secret{}
		for i, name := range names {
			if i == len(names)-1 {
				secrets[name] = &Secret{ID: name, Value: "end"}
				continue
			}
			next := names[i+1]
			secrets[name] = &Secret{ID: name, Template: true, Value: "${" + next + "}",
				References: []DeclaredReference{{Reference: Reference{Name: next}}}}
		}
		return secrets
	}

	// AA reaches K0 at depth 1 and K0 is four hops tall: fine. ZZ reaches it at
	// depth 2 through Y: six hops, one too many — and only the memo's height can
	// say so, because K0 is already finished by then.
	secrets := chain("K0", "K1", "K2", "K3", "K4")
	secrets["AA"] = &Secret{ID: "AA", Template: true, Value: "${K0}",
		References: []DeclaredReference{{Reference: Reference{Name: "K0"}}}}
	secrets["Y"] = &Secret{ID: "Y", Template: true, Value: "${K0}",
		References: []DeclaredReference{{Reference: Reference{Name: "K0"}}}}
	secrets["ZZ"] = &Secret{ID: "ZZ", Template: true, Value: "${Y}",
		References: []DeclaredReference{{Reference: Reference{Name: "Y"}}}}

	_, err := ResolveEnvironment(Graph{"e": {ID: "e", Secrets: secrets}}, "e")
	var resolution *ResolutionError
	if !errors.As(err, &resolution) || resolution.Kind != KindTooDeep {
		t.Fatalf("err = %v, want tooDeep", err)
	}
}
