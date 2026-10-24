// Package references is how this process reads a template and resolves an
// environment that inherits from another (P19 §1).
//
// It is a port, line for line where that is possible, of
// `packages/core/src/references` — `template.ts` for the grammar and
// `resolve.ts` for the traversal. The dashboard previews a template with the
// TypeScript, and `xecret run` injects what this package produces, so the two
// have to agree on every case or the value somebody checked in the browser is
// not the value their process gets. `resolution-fixtures.json` beside the
// TypeScript is the contract both suites read; a case that passes there and
// fails here is a bug in one of them, never a difference of opinion.
//
// Nothing here touches a key or the network. It works on plaintext the caller
// has already decrypted, which is the reason for the rule every message below
// keeps: **an error names a secret, a reference or an offset, and never a
// value.** A template is somebody's connection string, and an error message is
// the easiest place in a system for one to escape into a log.
package references

import (
	"fmt"
	"regexp"
	"strings"
)

// MaxReferenceDepth is how many references one hop may follow before
// resolution gives up.
const MaxReferenceDepth = 5

// MaxInheritanceDepth is how many ancestors an environment may have.
//
// Five, like the reference depth: each ancestor is one more grant to open and
// one more layer of ciphertext on the hottest path in the product, and a chain
// past five is a configuration nobody can hold in their head.
const MaxInheritanceDepth = 5

// MaxReferencesPerSecret is how many distinct references one template may
// declare.
const MaxReferencesPerSecret = 50

// The identifier grammar, mirrored from `@xecret/core/validation` rather than
// imported from anywhere in this binary, because the reference syntax is the
// one place the CLI has to parse a slug and the rules are the server's.
const (
	secretNameMaxLength = 256
	slugMaxLength       = 63
)

var (
	secretNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	// An environment's slug may hold an underscore; a project's may not. Neither
	// may hold a dot, which is what keeps the split below unambiguous.
	environmentSlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:[-_][a-z0-9]+)*$`)
	projectSlugPattern     = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
)

// Reference is one reference, as written in a template:
//
//	${KEY}                 KEY, as the environment being read sees it
//	${env.KEY}             KEY in environment `env` of the same project
//	${project.env.KEY}     KEY in environment `env` of project `project`
//
// An empty Project or Environment is an absent one. That is unambiguous —
// neither grammar admits an empty slug — and it is why the JSON tags omit them:
// the wire form a writer declares is exactly `{name}`, `{environment, name}` or
// `{project, environment, name}`, and a Project without an Environment is a
// shape the parser cannot produce.
type Reference struct {
	// Project is the project's slug. Empty means "the project of the secret
	// holding this".
	Project string `json:"project,omitempty"`
	// Environment is the environment's slug. Empty means "the environment being
	// read".
	Environment string `json:"environment,omitempty"`
	// Name is the secret's name.
	Name string `json:"name"`
}

// Segment is one piece of a parsed template: literal text, or a reference.
type Segment struct {
	// Text is the literal text, with every `$${` already turned back into `${`.
	// Empty for a reference.
	Text string
	// Reference is nil for a text segment.
	Reference *Reference
}

// SyntaxError is why a template could not be parsed. It never carries any part
// of the value — the message is one of two fixed sentences, and the offset is a
// number.
type SyntaxError struct {
	Message string
	// Offset is where the `${` that could not be read begins, counted in UTF-16
	// code units — the unit `template.ts` reports, so a dashboard and a terminal
	// asked about the same template point at the same place.
	Offset int
}

func (e *SyntaxError) Error() string { return e.Message }

const (
	unterminatedMessage = `A reference is opened with "${" and never closed with "}". Write "$${" for a literal "${".`
	malformedMessage    = `A reference must be ${KEY}, ${environment.KEY} or ${project.environment.KEY}, using ` +
		`slugs and a secret name with no spaces. Write "$${" for a literal "${".`
)

// ParseTemplate splits a template into literal text and references.
//
// Adjacent text is merged, so a template with no references parses to at most
// one text segment — which is what lets a renderer treat "no references" and
// "all text" as the same case.
//
// ── Bytes, where the TypeScript walks UTF-16 ──
//
// Every character this grammar reacts to — `$`, `{`, `}`, `.` — is ASCII, and in
// UTF-8 an ASCII byte never occurs inside the encoding of anything else. Walking
// bytes therefore finds exactly the delimiters a UTF-16 walk finds, and copies
// everything between them through untouched; only the reported offset has to be
// converted back.
//
// The grammar is deliberately strict — no whitespace, no defaults, no nesting —
// because a template is read by three implementations and every convenience is
// one more thing the three can disagree about.
func ParseTemplate(value string) ([]Segment, error) {
	var segments []Segment
	var text strings.Builder

	flushText := func() {
		if text.Len() > 0 {
			segments = append(segments, Segment{Text: text.String()})
			text.Reset()
		}
	}

	for index := 0; index < len(value); {
		// `$${` is the escape for a literal `${`. Checked before the reference
		// case so that `$${KEY}` is the text `${KEY}` rather than `$` followed by
		// a reference — the one ordering in which the escape means anything.
		if value[index] == '$' && index+2 < len(value) && value[index+1] == '$' && value[index+2] == '{' {
			text.WriteString("${")
			index += 3
			continue
		}

		if value[index] == '$' && index+1 < len(value) && value[index+1] == '{' {
			closing := strings.IndexByte(value[index+2:], '}')
			if closing < 0 {
				return nil, &SyntaxError{Message: unterminatedMessage, Offset: utf16Offset(value, index)}
			}

			end := index + 2 + closing
			reference, err := parseReferenceBody(value[index+2:end], utf16Offset(value, index))
			if err != nil {
				return nil, err
			}
			flushText()
			segments = append(segments, Segment{Reference: &reference})
			index = end + 1
			continue
		}

		text.WriteByte(value[index])
		index++
	}

	flushText()
	return segments, nil
}

func parseReferenceBody(body string, offset int) (Reference, error) {
	invalid := &SyntaxError{Message: malformedMessage, Offset: offset}

	// strings.Split, like String.prototype.split, answers [""] for an empty body,
	// so `${}` is one part whose name fails the pattern — the same refusal.
	parts := strings.Split(body, ".")
	if len(parts) < 1 || len(parts) > 3 {
		return Reference{}, invalid
	}

	name := parts[len(parts)-1]
	if len(name) > secretNameMaxLength || !secretNamePattern.MatchString(name) {
		return Reference{}, invalid
	}

	// The last slug is an environment's, which may hold an underscore; one before
	// it is a project's, which may not.
	slugs := parts[:len(parts)-1]
	environment, project := "", ""
	if len(slugs) > 0 {
		environment = slugs[len(slugs)-1]
		if len(environment) > slugMaxLength || !environmentSlugPattern.MatchString(environment) {
			return Reference{}, invalid
		}
	}
	if len(slugs) == 2 {
		project = slugs[0]
		if len(project) > slugMaxLength || !projectSlugPattern.MatchString(project) {
			return Reference{}, invalid
		}
	}

	return Reference{Project: project, Environment: environment, Name: name}, nil
}

// utf16Offset converts a byte offset into the UTF-16 count `template.ts`
// reports. A rune outside the Basic Multilingual Plane is two code units there
// and one rune here; everything else is one of each.
func utf16Offset(value string, byteOffset int) int {
	units := 0
	for _, r := range value[:byteOffset] {
		if r >= 0x10000 {
			units += 2
		} else {
			units++
		}
	}
	return units
}

// TemplateReferences is every distinct reference in a template, in order of
// first appearance.
//
// What a writer declares beside the ciphertext, and what a reader checks the
// decrypted template against: the two lists must be the same set, or the
// template is refused at read time rather than resolved against a graph the
// server never validated.
func TemplateReferences(value string) ([]Reference, error) {
	segments, err := ParseTemplate(value)
	if err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	references := []Reference{}
	for _, segment := range segments {
		if segment.Reference == nil {
			continue
		}
		key := ReferenceKey(*segment.Reference)
		if seen[key] {
			continue
		}
		seen[key] = true
		references = append(references, *segment.Reference)
	}

	if len(references) > MaxReferencesPerSecret {
		return nil, &SyntaxError{
			Message: fmt.Sprintf("A template may hold at most %d distinct references.", MaxReferencesPerSecret),
			Offset:  0,
		}
	}
	return references, nil
}

// ReferenceKey is a reference's identity: `project.environment.NAME`,
// `environment.NAME` or `NAME` — exactly the text between the braces, which is
// unambiguous because neither a slug nor a name may contain a dot.
func ReferenceKey(reference Reference) string {
	if reference.Project != "" && reference.Environment != "" {
		return reference.Project + "." + reference.Environment + "." + reference.Name
	}
	if reference.Environment != "" {
		return reference.Environment + "." + reference.Name
	}
	return reference.Name
}

// FormatReference is the reference as it is written in a template, braces and
// all.
func FormatReference(reference Reference) string {
	return "${" + ReferenceKey(reference) + "}"
}
