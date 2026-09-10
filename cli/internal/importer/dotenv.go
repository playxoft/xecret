package importer

import (
	"fmt"
	"strings"
)

// A `.env` parser.
//
// There is no specification for this format — only a decade of tools that each
// implement a slightly different dialect. The rules below are the intersection
// that real files rely on, chosen so the common shapes (Rails, Docker Compose,
// Vercel, a PEM key pasted across twenty lines) all import correctly.

// ParseDotenv reads a `.env` file. It never fails; malformed constructs become
// warnings.
func ParseDotenv(content string) Result {
	lines := splitSourceLines(content)
	seen := newEntrySet()
	warnings := []Warning{}

	for index := 0; index < len(lines); index++ {
		line := lines[index]
		lineNumber := index + 1

		if isBlankOrComment(line) {
			continue
		}

		parsed, ok := splitAssignment(line)
		if !ok {
			// The offending text is never quoted back: a line that failed to
			// parse is still a line out of a file full of credentials.
			warnings = append(warnings, Warning{
				Line:    lineNumber,
				Message: fmt.Sprintf("Line %d is not KEY=value; skipped.", lineNumber),
			})
			continue
		}
		if parsed.key == "" {
			warnings = append(warnings, Warning{
				Line:    lineNumber,
				Message: fmt.Sprintf("Line %d has no key; skipped.", lineNumber),
			})
			continue
		}

		value, endIndex, valueWarnings := readDotenvValue(lines, index, parsed.valueStart)
		warnings = append(warnings, valueWarnings...)
		seen.record(&warnings, Entry{Key: parsed.key, Value: value, Line: lineNumber})
		index = endIndex
	}

	return Result{Entries: seen.values(), Warnings: warnings}
}

func readDotenvValue(lines []string, startIndex, valueStart int) (string, int, []Warning) {
	line := lines[startIndex]
	rest := line[valueStart:]
	// Whitespace between `=` and the value is not part of the value, so
	// `KEY= "x"` is still a quoted value.
	cursor := valueStart + (len(rest) - len(strings.TrimLeft(rest, asciiSpace)))
	quote := charAt(line, cursor)

	if quote != `"` && quote != "'" {
		return readUnquotedValue(rest), startIndex, nil
	}

	if value, endIndex, trailing, ok := readQuoted(lines, startIndex, cursor+1, quote[0]); ok {
		return value, endIndex, trailing
	}

	return recoverUnterminated(line, valueStart), startIndex, []Warning{{
		Line: startIndex + 1,
		Message: fmt.Sprintf(
			"The quote opened on line %d is never closed. The rest of that line was used as the value.",
			startIndex+1,
		),
	}}
}

// readQuoted reads a quoted value, which may span any number of lines — the case
// that motivates the whole scanner, because a pasted PEM key is the most common
// multi-line secret there is.
//
// ok is false if the closing quote never arrives.
func readQuoted(lines []string, startIndex, from int, quote byte) (string, int, []Warning, bool) {
	var value strings.Builder
	index := startIndex
	cursor := from

	for index < len(lines) {
		line := lines[index]

		for cursor < len(line) {
			char := line[cursor]

			if char == quote {
				return value.String(), index, trailingQuoteWarnings(line, cursor+1, index+1), true
			}

			// Single quotes are fully literal: no escapes, no interpolation,
			// nothing. That is what makes them the safe way to write a value
			// containing backslashes or dollar signs.
			if char == '\\' && quote == '"' {
				value.WriteString(unescapeDotenv(charAt(line, cursor+1)))
				cursor += 2
				continue
			}

			value.WriteByte(char)
			cursor++
		}

		// End of line inside a quote: the value continues, and the newline is
		// part of it.
		value.WriteByte('\n')
		index++
		cursor = 0
	}

	return "", startIndex, nil, false
}

// unescapeDotenv is the five escapes a double-quoted `.env` value may contain.
//
// Anything else keeps its backslash. Dropping it — the other plausible rule —
// silently corrupts `"C:\Users\deploy"` into `C:Usersdeploy` and every regex with
// a `\d` in it. Preserving an unknown escape can at worst leave a backslash the
// author meant to remove; dropping it destroys data.
//
// A backslash at end of line falls through to the same rule and stays literal:
// this format has no line continuation, and inventing one would let a stray
// trailing backslash join two unrelated secrets into one.
func unescapeDotenv(char string) string {
	switch char {
	case "n":
		return "\n"
	case "r":
		return "\r"
	case "t":
		return "\t"
	case `\`:
		return `\`
	case `"`:
		return `"`
	default:
		return `\` + char
	}
}

func trailingQuoteWarnings(line string, from, lineNumber int) []Warning {
	rest := strings.TrimSpace(line[min(from, len(line)):])
	if rest == "" || strings.HasPrefix(rest, "#") {
		return nil
	}
	return []Warning{{
		Line:    lineNumber,
		Message: fmt.Sprintf("Ignored unexpected text after the closing quote on line %d.", lineNumber),
	}}
}
