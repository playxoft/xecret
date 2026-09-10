package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Rendering secrets into the file formats people export them to — on this side
// of the wire, because for an end-to-end encrypted environment there is no other
// side that could.
//
// This is a port of `packages/core/src/format/format.ts`, and it holds the same
// single property: **whatever goes in comes back out byte for byte**. A quoting
// bug here does not throw, it hands somebody a password with a character
// missing, and they find out when a service fails to authenticate at 3am. Where
// a format cannot represent a value this refuses, because a truncated secret
// that looks fine is worse than an error.
//
// The two implementations exist because the two modes render in different
// places, not because anybody wanted two. The escaping rules are stated once, in
// that file's comments, and reproduced here; `format_test.go` asserts the
// round-trip that keeps them honest.

// envNeedsQuoting is what forces quoting in a .env file.
//
// Whitespace and `#` change where the value ends. Quotes and backslashes change
// how it is read. `$` and backtick do not matter to a parser that never
// interpolates, but they do to python-dotenv, Docker Compose, and anything that
// sources the file.
var envNeedsQuoting = regexp.MustCompile("[\\s#\"'$`\\\\]")

// formatSecrets renders a decrypted environment.
//
// `env`, `shell` and `docker` are line-oriented and keep name order; `json` and
// `yaml` are documents whose key order carries no meaning, so they are sorted so
// that a secret added today produces a one-line diff. Sorting is by code unit,
// never by locale, so the output does not depend on where it ran.
func formatSecrets(secrets map[string]string, format string) ([]byte, error) {
	names := make([]string, 0, len(secrets))
	for name := range secrets {
		// A name that is not an identifier would produce a line that parses back
		// as something else — `A=B=value` reads as `A` holding `B=value`. Names
		// come from the database and are already constrained, so this guards
		// against a future caller rather than validating one.
		if !secretNamePattern.MatchString(name) {
			return nil, fmt.Errorf("cannot export %q: it is not a valid secret name", name)
		}
		names = append(names, name)
	}
	sort.Strings(names)

	var out bytes.Buffer
	switch format {
	case "env":
		for _, name := range names {
			fmt.Fprintf(&out, "%s=%s\n", name, quoteEnvValue(secrets[name]))
		}

	case "shell":
		for _, name := range names {
			quoted, err := quoteSingle(name, secrets[name])
			if err != nil {
				return nil, err
			}
			fmt.Fprintf(&out, "export %s=%s\n", name, quoted)
		}

	case "docker":
		for _, name := range names {
			value, err := dockerValue(name, secrets[name])
			if err != nil {
				return nil, err
			}
			fmt.Fprintf(&out, "%s=%s\n", name, value)
		}

	case "json":
		encoder := json.NewEncoder(&out)
		// Matching JSON.stringify: two-space indent, and no HTML escaping, which
		// Go does by default and JavaScript does not. A value containing `<`
		// would otherwise come back as `<` — still correct JSON, still the
		// same string after parsing, but a gratuitous difference between the two
		// modes in a file people read.
		encoder.SetIndent("", "  ")
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(secrets); err != nil {
			return nil, err
		}

	case "yaml":
		for _, name := range names {
			// Every value is quoted, always. An unquoted `yes`, `NO`, `null`,
			// `1.10` or `08:00` is a string under YAML 1.2 and something else
			// entirely under YAML 1.1 — which PyYAML and much of the Ruby and PHP
			// world still implement. `PASSWORD: yes` reaching Python as the
			// boolean True is a real failure mode, and quoting costs two
			// characters. Keys are validated names and need none.
			fmt.Fprintf(&out, "%s: %s\n", name, quoteYamlValue(secrets[name]))
		}

	default:
		return nil, fmt.Errorf("unknown format %q — use env, json, yaml, shell or docker", format)
	}

	return out.Bytes(), nil
}

// quoteEnvValue quotes a .env value, and only when something requires it.
//
// Single quotes are preferred because they are literal in every dialect: no
// escapes to get wrong, and no interpolation even in readers that perform it.
// Double quotes are used only for a value single quotes cannot express — one
// containing a `'`, since the literal form cannot escape its own delimiter — or
// a newline, which is escaped rather than written literally so that one line of
// output stays one secret.
func quoteEnvValue(value string) string {
	if value == "" || !envNeedsQuoting.MatchString(value) {
		return value
	}
	if !strings.ContainsAny(value, "'\n\r") {
		return "'" + value + "'"
	}

	escaped := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		"\n", `\n`,
		"\r", `\r`,
		"\t", `\t`,
	).Replace(value)
	return `"` + escaped + `"`
}

// quoteSingle is the only generally safe way to quote for a shell: single
// quotes, with the `'\”` idiom for an embedded quote — close the string, emit
// an escaped quote, reopen it. Nothing inside single quotes is expanded, so a
// value containing `$(rm -rf …)` is inert when the file is sourced.
//
// A newline needs no escaping; a carriage return is refused. Single quotes have
// no escape mechanism, so the CR would be written raw, and every reader of the
// file normalises line endings before looking at the content — the byte would be
// silently lost on the way back in.
func quoteSingle(name, value string) (string, error) {
	if strings.Contains(value, "\r") {
		return "", fmt.Errorf(
			"cannot export %q: shell output cannot represent a carriage return, "+
				"which would be lost when the file is read back. Use --format env or json",
			name,
		)
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'", nil
}

// dockerValue: Docker's --env-file grammar has no quoting at all — everything
// after the first `=` is the value, verbatim, to the end of the line.
//
// That makes a line break unrepresentable: Docker would read the remainder as a
// new variable, or drop it. Emitting a value silently cut at the first newline
// is exactly the failure this file exists to prevent.
func dockerValue(name, value string) (string, error) {
	if strings.ContainsAny(value, "\n\r") {
		return "", fmt.Errorf(
			"cannot export %q: Docker env files cannot represent a value containing a "+
				"line break. Use --format env, json or yaml",
			name,
		)
	}
	return value, nil
}

// quoteYamlValue renders a YAML double-quoted scalar.
//
// Written out rather than delegated to a YAML library, because the property that
// matters is a scalar every parser reads back identically, and a library's
// choice of block style, folding or plain scalars is exactly what would break
// that. Line folding in particular is reversible only if every consumer
// implements it the same way, and the cost of one that does not is a corrupted
// secret — so long values stay on one line.
func quoteYamlValue(value string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '\\':
			out.WriteString(`\\`)
		case '"':
			out.WriteString(`\"`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 || r == 0x7f {
				fmt.Fprintf(&out, `\x%02x`, r)
				continue
			}
			out.WriteRune(r)
		}
	}
	out.WriteByte('"')
	return out.String()
}
