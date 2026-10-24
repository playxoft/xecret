// The cross-implementation contract for templates and inheritance.
//
// resolution-fixtures.json is read by this file and by
// packages/core/src/references/fixtures/fixtures.test.ts, so the dashboard's
// preview of a template and what `xecret run` injects for it cannot drift apart
// without one of the two suites failing. Nothing in it was written for Go: the
// cases are the TypeScript's, and this file builds each graph the way that suite
// does — a secret's id is `<environment>:<name>` — so a disagreement is a bug in
// one implementation, never a difference in how the fixture was read.
package references

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// fixturesPath resolves the one file both implementations read. It lives in
// packages/core so the TypeScript suite owns it; the Go side is a reader only.
const fixturesPath = "../../../packages/core/src/references/fixtures/resolution-fixtures.json"

type fixtureFile struct {
	MaxReferenceDepth   int           `json:"maxReferenceDepth"`
	MaxInheritanceDepth int           `json:"maxInheritanceDepth"`
	Parse               []parseCase   `json:"parse"`
	Resolve             []resolveCase `json:"resolve"`
}

type parseCase struct {
	Template string           `json:"template"`
	Segments []fixtureSegment `json:"segments"`
	Error    string           `json:"error"`
}

type fixtureSegment struct {
	Text      *string    `json:"text"`
	Reference *Reference `json:"reference"`
}

type resolveCase struct {
	Name         string               `json:"name"`
	Context      string               `json:"context"`
	Environments []fixtureEnvironment `json:"environments"`
	Expected     map[string]string    `json:"expected"`
	Error        string               `json:"error"`
}

type fixtureEnvironment struct {
	ID       string                   `json:"id"`
	ParentID *string                  `json:"parentId"`
	Secrets  map[string]fixtureSecret `json:"secrets"`
}

type fixtureSecret struct {
	Value      string             `json:"value"`
	Template   bool               `json:"template"`
	References []fixtureReference `json:"references"`
}

type fixtureReference struct {
	Project       string  `json:"project"`
	Environment   string  `json:"environment"`
	Name          string  `json:"name"`
	EnvironmentID *string `json:"environmentId"`
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
	// A section that silently drops to zero cases is a passing test that checks
	// nothing.
	if len(file.Parse) == 0 || len(file.Resolve) == 0 {
		t.Fatalf("the fixture file carries %d parse and %d resolve cases", len(file.Parse), len(file.Resolve))
	}
	return file
}

func TestTheFixturesStateTheLimitsThisPackageEnforces(t *testing.T) {
	file := loadFixtures(t)
	if file.MaxReferenceDepth != MaxReferenceDepth {
		t.Errorf("maxReferenceDepth = %d, this package enforces %d", file.MaxReferenceDepth, MaxReferenceDepth)
	}
	if file.MaxInheritanceDepth != MaxInheritanceDepth {
		t.Errorf("maxInheritanceDepth = %d, this package enforces %d", file.MaxInheritanceDepth, MaxInheritanceDepth)
	}
}

func TestParseFixtures(t *testing.T) {
	cases := loadFixtures(t).Parse
	for _, c := range cases {
		segments, err := ParseTemplate(c.Template)

		if c.Error != "" {
			var syntax *SyntaxError
			if !errors.As(err, &syntax) {
				t.Errorf("%q: want a syntax error, got segments %+v and %v", c.Template, segments, err)
			}
			if c.Error != string(KindSyntax) {
				t.Errorf("%q: the fixture names error %q, which a parse cannot produce", c.Template, c.Error)
			}
			continue
		}

		if err != nil {
			t.Errorf("%q: %v", c.Template, err)
			continue
		}
		if len(segments) != len(c.Segments) {
			t.Errorf("%q: %d segments, want %d (%+v)", c.Template, len(segments), len(c.Segments), segments)
			continue
		}
		for i, want := range c.Segments {
			got := segments[i]
			switch {
			case want.Text != nil:
				if got.Reference != nil || got.Text != *want.Text {
					t.Errorf("%q segment %d: got %+v, want text %q", c.Template, i, got, *want.Text)
				}
			case want.Reference != nil:
				if got.Reference == nil || *got.Reference != *want.Reference {
					t.Errorf("%q segment %d: got %+v, want reference %+v", c.Template, i, got, *want.Reference)
				}
			default:
				t.Fatalf("%q segment %d: the fixture names neither text nor a reference", c.Template, i)
			}
		}
	}
	t.Logf("checked %d parse cases", len(cases))
}

// graphOf builds a fixture graph exactly as fixtures.test.ts does.
func graphOf(environments []fixtureEnvironment) Graph {
	graph := Graph{}
	for _, environment := range environments {
		parent := ""
		if environment.ParentID != nil {
			parent = *environment.ParentID
		}
		secrets := map[string]*Secret{}
		for name, secret := range environment.Secrets {
			declared := make([]DeclaredReference, 0, len(secret.References))
			for _, reference := range secret.References {
				target := ""
				if reference.EnvironmentID != nil {
					target = *reference.EnvironmentID
				}
				declared = append(declared, DeclaredReference{
					Reference: Reference{
						Project: reference.Project, Environment: reference.Environment, Name: reference.Name,
					},
					EnvironmentID: target,
				})
			}
			secrets[name] = &Secret{
				ID:         environment.ID + ":" + name,
				Template:   secret.Template,
				References: declared,
				Value:      secret.Value,
			}
		}
		graph[environment.ID] = &Environment{ID: environment.ID, ParentID: parent, Secrets: secrets}
	}
	return graph
}

func TestResolveFixtures(t *testing.T) {
	cases := loadFixtures(t).Resolve
	for _, c := range cases {
		resolved, err := ResolveEnvironment(graphOf(c.Environments), c.Context)

		if c.Error != "" {
			var resolution *ResolutionError
			if !errors.As(err, &resolution) {
				t.Errorf("%s: want a %s error, got %v (resolved %d names)", c.Name, c.Error, err, len(resolved))
				continue
			}
			if string(resolution.Kind) != c.Error {
				t.Errorf("%s: kind = %s, want %s (%s)", c.Name, resolution.Kind, c.Error, resolution.Message)
			}
			continue
		}

		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		if !reflect.DeepEqual(resolved, c.Expected) {
			t.Errorf("%s:\n got %v\nwant %v", c.Name, resolved, c.Expected)
		}
	}
	t.Logf("checked %d resolve cases", len(cases))
}

// Every error kind the TypeScript can produce is exercised by at least one
// fixture. A kind that no case reaches is a refusal nobody has checked the two
// implementations agree on.
func TestEveryErrorKindHasAFixture(t *testing.T) {
	seen := map[string]bool{}
	file := loadFixtures(t)
	for _, c := range file.Resolve {
		seen[c.Error] = true
	}
	for _, c := range file.Parse {
		seen[c.Error] = true
	}
	for _, kind := range []ErrorKind{
		KindInheritanceCycle, KindInheritanceTooDeep, KindMissingEnvironment, KindUnresolved,
		KindCycle, KindTooDeep, KindUndeclared, KindSyntax,
	} {
		if !seen[string(kind)] {
			t.Errorf("no fixture produces %q", kind)
		}
	}
}
