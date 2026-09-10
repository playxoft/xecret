// Package importer parses the configuration files `xecret import` accepts, on
// this side of the wire.
//
// ── Why this exists at all ──
//
// It should not. `cmd/xecret/transfer.go` says the CLI "deliberately has no
// second parser to disagree with the one the dashboard's import modal uses", and
// that was true and right for as long as the server could read a file. Under
// end-to-end encryption it cannot: sending a `.env` full of plaintext to an
// endpoint that must never see one is the whole thing the model forbids. So the
// parse has to happen wherever the plaintext already is, and for `xecret import`
// that is here.
//
// This is therefore a port of `packages/core/src/importer/**`, not a second
// design. Every grammar rule, every warning message, and every planning decision
// is the one that file makes, and the two are pinned together by
// `fixtures/import-fixtures.json` — the same arrangement the crypto vectors use,
// and for the same reason: two implementations of one format agree only if
// something checks that they do.
//
// Where the two knowingly differ, the divergence is named in a comment and
// covered by the fixture. There is exactly one, in `tree.go`, over how a huge
// integer literal is rendered.
//
// ── Two rules inherited verbatim ──
//
// **No parser here ever fails on its input.** The input is a file somebody
// dragged in. Every malformed construct produces a warning and the parse
// continues, because a hard failure is an import that stops with no way to see
// what was wrong.
//
// **`${VAR}` interpolation is deliberately not implemented.** Resolving a
// reference at import time would bake a value from whichever shell or CI runner
// ran the import into a stored secret. `$` is stored as written.
package importer

import "strings"

// Format is the source format of an import.
type Format string

const (
	FormatDotenv Format = "dotenv"
	FormatJSON   Format = "json"
	FormatYAML   Format = "yaml"
	FormatShell  Format = "shell"
)

// Entry is one key/value pair as it appeared in the source, before any
// normalisation.
type Entry struct {
	Key string `json:"key"`
	// Value is plaintext. Nothing in this package logs one.
	Value string `json:"value"`
	// Line is 1-based, for pointing at the problem in the source.
	Line int `json:"line"`
}

// Warning is a problem that did not stop the import.
//
// A message may name a key, a line, or a type — **never a value**. Warnings are
// printed to a terminal, pasted into issue reports, and attached to support
// tickets, so anything that reaches this string has effectively been published.
type Warning struct {
	Line    int    `json:"line"`
	Message string `json:"message"`
}

// Result is what a parser produces.
type Result struct {
	Entries  []Entry   `json:"entries"`
	Warnings []Warning `json:"warnings"`
}

// Parse dispatches to the parser for a format.
func Parse(content string, format Format) Result {
	switch format {
	case FormatJSON:
		return ParseJSON(content)
	case FormatYAML:
		return ParseYAML(content)
	case FormatShell:
		return ParseShell(content)
	default:
		return ParseDotenv(content)
	}
}

// KnownFormat reports whether a string names a format this package parses.
func KnownFormat(value string) bool {
	switch Format(value) {
	case FormatDotenv, FormatJSON, FormatYAML, FormatShell:
		return true
	}
	return false
}

// Detect guesses the format of a file.
//
// Extension first, because a filename is a statement of intent: somebody who
// named a file `config.yaml` knows what is in it, and sniffing a YAML file that
// happens to open with `{` would overrule them for no reason.
func Detect(filename, content string) Format {
	if byName := detectByFilename(filename); byName != "" {
		return byName
	}

	var meaningful []string
	for _, line := range splitSourceLines(content) {
		if !isBlankOrComment(line) {
			meaningful = append(meaningful, strings.TrimSpace(line))
		}
	}
	if len(meaningful) == 0 {
		return FormatDotenv
	}

	if strings.HasPrefix(meaningful[0], "{") || strings.HasPrefix(meaningful[0], "[") {
		return FormatJSON
	}
	for _, line := range meaningful {
		if exportAssignmentPattern.MatchString(line) {
			return FormatShell
		}
	}
	for _, line := range meaningful {
		if yamlKeyPattern.MatchString(line) {
			return FormatYAML
		}
	}
	return FormatDotenv
}

func detectByFilename(filename string) Format {
	name := filename
	if index := strings.LastIndexAny(name, `/\`); index >= 0 {
		name = name[index+1:]
	}
	name = strings.ToLower(name)

	switch {
	case strings.HasSuffix(name, ".json"):
		return FormatJSON
	case strings.HasSuffix(name, ".yaml"), strings.HasSuffix(name, ".yml"):
		return FormatYAML
	// `.envrc` is direnv, which is a shell script, so it is tested before the
	// `.env` rule below claims it.
	case name == ".envrc",
		strings.HasSuffix(name, ".sh"),
		strings.HasSuffix(name, ".bash"),
		strings.HasSuffix(name, ".zsh"):
		return FormatShell
	case name == ".env", strings.HasPrefix(name, ".env."), envNamePattern.MatchString(name):
		return FormatDotenv
	}
	return ""
}
