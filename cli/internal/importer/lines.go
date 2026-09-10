package importer

import (
	"fmt"
	"regexp"
	"strings"
)

// The line-oriented preprocessing `.env` and shell share.
//
// The framing — a BOM, line endings, comments, the `export` prefix, last-wins
// duplicates — is genuinely common to both formats, so it lives once. The
// *quoting grammars* are not common, and treating them as common corrupts
// values; each parser keeps its own scanner. See shell.go for what differs.

// bom is the byte-order mark Windows editors and PowerShell's `>` redirection
// add. It is invisible in every diff viewer, so without stripping it the first
// key of a file becomes "<BOM>DATABASE_URL" and imports as a broken duplicate.
const bom = "\ufeff"

var (
	exportPrefixPattern     = regexp.MustCompile(`^\s*export\s+`)
	exportAssignmentPattern = regexp.MustCompile(`^export\s+[A-Za-z_][A-Za-z0-9_]*=`)
	yamlKeyPattern          = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)`)
	envNamePattern          = regexp.MustCompile(`(^|\.)env(\.|$)`)
	lineBreakPattern        = regexp.MustCompile("\r\n|\r|\n")
)

// splitSourceLines discards the two things that are encoding artefacts rather
// than data: a BOM and CRLF/CR line endings.
//
// Normalising line endings for the whole document — including inside quoted
// values — is intentional. A private key committed from Windows would otherwise
// import with a `\r` at the end of every line: invisible in the UI, and enough
// to make an SSH key or a database URL fail somewhere far from here.
func splitSourceLines(content string) []string {
	return lineBreakPattern.Split(strings.TrimPrefix(content, bom), -1)
}

// isBlankOrComment reports a line holding nothing but whitespace, or a
// whole-line `#` comment.
func isBlankOrComment(line string) bool {
	trimmed := strings.TrimLeft(line, asciiSpace)
	return trimmed == "" || strings.HasPrefix(trimmed, "#")
}

// asciiSpace is the whitespace set the scanners below treat as a separator.
//
// Byte-oriented on purpose: every structural character in these grammars is
// ASCII, and a UTF-8 continuation byte can never be mistaken for one, so a byte
// scan and a rune scan agree on every well-formed input while the byte scan
// keeps offsets and slices trivially correct.
const asciiSpace = " \t\v\f\r\n"

func isSpaceByte(b byte) bool { return strings.IndexByte(asciiSpace, b) >= 0 }

// assignment is `KEY=` split into its key and the offset where the value begins.
type assignment struct {
	key        string
	valueStart int
}

// splitAssignment splits `KEY=…`.
//
// The `export ` prefix is accepted because `.env` files are routinely written to
// be `source`-able. Requiring whitespace after it means a key literally called
// `export` (or `exports`) still parses as a key.
//
// ok is false when the line has no `=` at all, which the caller reports.
func splitAssignment(line string) (assignment, bool) {
	withoutExport := exportPrefixPattern.ReplaceAllString(line, "")
	start := len(line) - len(withoutExport)

	equals := strings.IndexByte(line[start:], '=')
	if equals < 0 {
		return assignment{}, false
	}
	equals += start

	return assignment{key: strings.TrimSpace(line[start:equals]), valueStart: equals + 1}, true
}

// readUnquotedValue strips a trailing comment, then trailing whitespace.
//
// A `#` only starts a comment when whitespace precedes it. `PASSWORD=abc#123` is
// a password containing a hash, not a two-character password followed by a
// comment — and the `#` position matters more than it looks, because the same
// rule decides whether `KEY= # unset for now` is empty (it is) or the literal
// text `# unset for now`.
//
// No escape processing happens here: outside quotes, a backslash is a backslash.
// Windows paths and regexes appear in `.env` files far more often than somebody
// hand-writing `\n` outside quotes and expecting a newline.
func readUnquotedValue(text string) string {
	if comment := findInlineComment(text); comment >= 0 {
		text = text[:comment]
	}
	return strings.TrimSpace(text)
}

func findInlineComment(text string) int {
	for index := 1; index < len(text); index++ {
		if text[index] == '#' && isSpaceByte(text[index-1]) {
			return index
		}
	}
	return -1
}

// recoverUnterminated salvages a value whose opening quote is never closed.
//
// The obvious alternative — read to end of file, since that is where the quote
// would have to close — is the wrong failure. One stray quote in a forty-line
// file would swallow the other thirty-nine keys into a single value, and the
// user would see "1 secret will be added" with no idea why. Recovering the
// opening line alone keeps the damage to the line that contains the typo.
func recoverUnterminated(line string, valueStart int) string {
	rest := strings.TrimLeft(line[valueStart:], asciiSpace)
	if strings.HasPrefix(rest, `"`) || strings.HasPrefix(rest, "'") {
		rest = rest[1:]
	}
	return readUnquotedValue(rest)
}

// entrySet applies the last-wins rule for duplicate keys, loudly, in first-seen
// order.
//
// Last-wins matches every shell and every `.env` loader, so it is what the file
// author expects. The warning is the part that matters: a duplicated key is
// usually a bad merge, and importing the wrong one of two passwords without
// saying so is how somebody spends an afternoon debugging production.
type entrySet struct {
	order   []string
	entries map[string]Entry
}

func newEntrySet() *entrySet {
	return &entrySet{entries: map[string]Entry{}}
}

func (s *entrySet) record(warnings *[]Warning, entry Entry) {
	if previous, seen := s.entries[entry.Key]; seen {
		*warnings = append(*warnings, Warning{
			Line: entry.Line,
			Message: fmt.Sprintf(
				"%q is defined more than once. The value on line %d replaces the one on line %d.",
				entry.Key, entry.Line, previous.Line,
			),
		})
	} else {
		s.order = append(s.order, entry.Key)
	}
	s.entries[entry.Key] = entry
}

func (s *entrySet) values() []Entry {
	out := make([]Entry, 0, len(s.order))
	for _, key := range s.order {
		out = append(out, s.entries[key])
	}
	return out
}

// charAt is JavaScript's `String.prototype.charAt`: out of range is the empty
// string, not a panic. The scanners below are ports and rely on that, most
// visibly where a backslash sits at the end of a line and has nothing to escape.
func charAt(line string, index int) string {
	if index < 0 || index >= len(line) {
		return ""
	}
	return line[index : index+1]
}
