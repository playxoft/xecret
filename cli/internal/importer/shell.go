package importer

import (
	"fmt"
	"strings"
)

// Parser for shell environment dumps: the output of `export -p`, a hand-written
// `source`-able file, or `xecret pull --format shell`.
//
// The line shape is the same as `.env` — `export KEY=value` — and the framing is
// genuinely shared, so it is reused rather than reimplemented. The quoting
// grammar is *not* the same, and treating it as the same corrupts values:
//
//   - **Double quotes.** POSIX gives `\` special meaning before exactly `"`,
//     backtick, `$` and `\` — and nothing else. `"a\nb"` in a shell dump is the
//     four characters `a`, `\`, `n`, `b`, not a newline. Applying the `.env`
//     escape table here would silently turn a Windows path or a regex into
//     different data, in the one format whose values were produced by a machine
//     and are therefore assumed exact.
//   - **Adjacent segments concatenate.** `'it'\''s'` is a single word meaning
//     `it's`; it is how every shell emits an embedded apostrophe, and it is what
//     this repository's own shell exporter produces. `.env` has no
//     concatenation, so it cannot express that value at all.
//   - **A backslash outside quotes escapes the next character**, which `.env`
//     treats as literal.

// ParseShell reads a shell environment dump. Like the `.env` parser it never
// fails and never performs `$` expansion.
func ParseShell(content string) Result {
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
			warnings = append(warnings, Warning{
				Line:    lineNumber,
				Message: fmt.Sprintf("Line %d is not an assignment; skipped.", lineNumber),
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

		word := readShellWord(lines, index, parsed.valueStart)

		if word.terminated {
			warnings = append(warnings, trailingWordWarnings(lines, word.endIndex, word.endCursor)...)
			seen.record(&warnings, Entry{Key: parsed.key, Value: word.value, Line: lineNumber})
			index = word.endIndex
			continue
		}

		// Same recovery as the `.env` parser: contain an unclosed quote to its
		// own line rather than letting it consume every following secret.
		warnings = append(warnings, Warning{
			Line: lineNumber,
			Message: fmt.Sprintf(
				"The quote opened on line %d is never closed. The rest of that line was used as the value.",
				lineNumber,
			),
		})
		seen.record(&warnings, Entry{
			Key:   parsed.key,
			Value: recoverUnterminated(line, parsed.valueStart),
			Line:  lineNumber,
		})
	}

	return Result{Entries: seen.values(), Warnings: warnings}
}

type shellWord struct {
	value string
	// endIndex is the last line consumed.
	endIndex int
	// endCursor is just past the word, where a trailing comment may begin.
	endCursor  int
	terminated bool
}

// readShellWord reads one shell word, concatenating quoted and unquoted segments
// until unquoted whitespace or end of line ends it. Quoted segments may span
// lines.
func readShellWord(lines []string, startIndex, from int) shellWord {
	var value strings.Builder
	index := startIndex
	cursor := from
	var quote byte // 0 when outside quotes

	// Leading whitespace after `=` is not part of the value.
	opening := lines[startIndex]
	for cursor < len(opening) && isSpaceByte(opening[cursor]) {
		cursor++
	}

	for index < len(lines) {
		line := lines[index]

		for cursor < len(line) {
			char := line[cursor]

			if quote == 0 {
				if char == '"' || char == '\'' {
					quote = char
					cursor++
					continue
				}
				if isSpaceByte(char) {
					return shellWord{value: value.String(), endIndex: index, endCursor: cursor, terminated: true}
				}
				if char == '\\' {
					// A trailing backslash has nothing to escape. Keeping it
					// literal rather than implementing line continuation is the
					// same choice the `.env` parser makes, and for the same
					// reason.
					next := charAt(line, cursor+1)
					if next == "" {
						value.WriteString(`\`)
					} else {
						value.WriteString(next)
					}
					cursor += 2
					continue
				}
				value.WriteByte(char)
				cursor++
				continue
			}

			if char == quote {
				quote = 0
				cursor++
				continue
			}

			if quote == '"' && char == '\\' {
				next := charAt(line, cursor+1)
				if next == `"` || next == `\` || next == "$" || next == "`" {
					value.WriteString(next)
					cursor += 2
					continue
				}
				// Not one of the four: the backslash is an ordinary character.
				// This is the divergence from `.env` that matters most.
				value.WriteByte(char)
				cursor++
				continue
			}

			value.WriteByte(char)
			cursor++
		}

		if quote == 0 {
			return shellWord{value: value.String(), endIndex: index, endCursor: cursor, terminated: true}
		}

		value.WriteByte('\n')
		index++
		cursor = 0
	}

	return shellWord{value: value.String(), endIndex: startIndex, endCursor: cursor}
}

func trailingWordWarnings(lines []string, index, cursor int) []Warning {
	line := lines[index]
	rest := strings.TrimSpace(line[min(cursor, len(line)):])
	if rest == "" || strings.HasPrefix(rest, "#") {
		return nil
	}
	return []Warning{{
		Line:    index + 1,
		Message: fmt.Sprintf("Ignored unexpected text after the value on line %d.", index+1),
	}}
}
