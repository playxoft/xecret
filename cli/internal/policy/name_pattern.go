package policy

import (
	"regexp"
	"strconv"
	"strings"
)

// This file is a straight port of the backtracking guard in
// packages/core/src/policy/secret-policy.ts (`NESTED_QUANTIFIER`,
// `MAX_ADJACENT_REPEATS`, `longestRepeatRun`) — for cross-language parity
// only (review round 2, F2). The package header already says the name rule
// itself is the server's alone and nothing here evaluates a name against one;
// Go's own regexp package (RE2) is linear-time and immune to the catastrophic
// backtracking this guards against in a backtracking engine. What this buys
// is the one thing RE2 cannot: that a pattern the server refuses as unsafe is
// refused by this package's own fixture-driven tests too, under the same
// shared policy-fixtures.json the TypeScript suite reads — so the two
// descriptions of "a safe name pattern" cannot quietly drift apart.

// nestedQuantifierPattern matches a group that is itself repeated and holds a
// quantifier or an alternation — (a+)+, (a|ab)*, (x{2,})+ — the shapes that
// backtrack exponentially in a backtracking engine.
var nestedQuantifierPattern = regexp.MustCompile(`\((?:[^()\\]|\\.)*(?:[+*|]|\{\d)(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)`)

// maxAdjacentRepeats is the most repeated parts a name pattern may have in a
// row. See the TypeScript's MAX_ADJACENT_REPEATS for why three is refused.
const maxAdjacentRepeats = 2

// NamePatternIsSafe reports whether pattern passes the same backtracking
// guard `validateSecretPolicy` applies in TypeScript: no nested, repeated
// group, and no more than maxAdjacentRepeats repeated parts in a row at any
// one level (counting through a transparent group, an empty group, a
// zero-width lookaround and a zero-width escape, none of which may hide an
// otherwise-adjacent run — review round 2, F2).
func NamePatternIsSafe(pattern string) bool {
	return !nestedQuantifierPattern.MatchString(pattern) && LongestRepeatRun(pattern) <= maxAdjacentRepeats
}

// quantKind is a quantifier's effect on a run: it repeats, it does not, or it
// is optional and affects neither (the TypeScript's `boolean | null`).
type quantKind int

const (
	quantNone quantKind = iota
	quantOptional
	quantRepeats
)

var repeatBraces = regexp.MustCompile(`^\{(\d+)(,(\d*))?\}`)

// groupPrefixPattern recognises a group's `?`-prefix: non-capturing, a
// lookaround of either direction, or a named capture.
var groupPrefixPattern = regexp.MustCompile(`^\?(?::|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>)`)

// LongestRepeatRun is the port of the TypeScript function of the same name:
// the longest run of repeated parts — an atom followed by `*`, `+` or a
// variable `{m,n}` — directly after one another at the same level of a
// pattern. A group is one part of the level it sits in, and its own content
// is a level of its own. A static, single-pass scan: it never runs the
// pattern. See the TypeScript for the full explanation of what passes
// through without breaking, or hiding, a run — a group with no quantifier of
// its own, an empty group (including an empty lookaround), and a zero-width
// escape all leave a run exactly as it stood.
func LongestRepeatRun(pattern string) int {
	runs := []int{0}
	type openGroup struct{ start int }
	var groups []openGroup
	longest := 0
	index := 0

	quantifier := func() quantKind {
		if index >= len(pattern) {
			return quantNone
		}
		var kind quantKind
		switch pattern[index] {
		case '*', '+':
			kind = quantRepeats
			index++
		case '?':
			kind = quantOptional
			index++
		case '{':
			m := repeatBraces.FindStringSubmatch(pattern[index:])
			if m == nil {
				return quantNone
			}
			index += len(m[0])
			min, _ := strconv.Atoi(m[1])
			var max int
			unbounded := false
			switch {
			case m[2] == "":
				max = min
			case m[3] == "":
				unbounded = true
			default:
				max, _ = strconv.Atoi(m[3])
			}
			switch {
			case !unbounded && max == min:
				kind = quantNone
			case !unbounded && max <= 1:
				kind = quantOptional
			default:
				kind = quantRepeats
			}
		default:
			return quantNone
		}
		// A lazy quantifier backtracks just the same.
		if index < len(pattern) && pattern[index] == '?' {
			index++
		}
		return kind
	}

	part := func(repeated quantKind) {
		if repeated == quantOptional {
			return
		}
		level := len(runs) - 1
		run := 0
		if repeated == quantRepeats {
			run = runs[level] + 1
		}
		runs[level] = run
		if run > longest {
			longest = run
		}
	}

	for index < len(pattern) {
		char := pattern[index]
		switch {
		case char == '\\':
			var escaped byte
			if index+1 < len(pattern) {
				escaped = pattern[index+1]
			}
			index += 2
			// `\u{…}`, `\p{…}`: the braces belong to the escape.
			if index < len(pattern) && pattern[index] == '{' && index >= 1 &&
				(pattern[index-1] == 'u' || pattern[index-1] == 'p' || pattern[index-1] == 'P') {
				close := strings.IndexByte(pattern[index:], '}')
				if close == -1 {
					index = len(pattern)
				} else {
					index += close + 1
				}
			}
			// `\b`/`\B`: a zero-width boundary, consumed and skipped — not a
			// part, and nothing to reset a run over.
			if escaped != 'b' && escaped != 'B' {
				part(quantifier())
			}
		case char == '[':
			index++
			if index < len(pattern) && pattern[index] == '^' {
				index++
			}
			if index < len(pattern) && pattern[index] == ']' {
				index++
			}
			for index < len(pattern) && pattern[index] != ']' {
				if pattern[index] == '\\' {
					index += 2
				} else {
					index++
				}
			}
			index++
			part(quantifier())
		case char == '(':
			runs = append(runs, 0)
			index++
			if prefix := groupPrefixPattern.FindString(pattern[index:]); prefix != "" {
				index += len(prefix)
			}
			groups = append(groups, openGroup{start: index})
		case char == ')':
			var group openGroup
			hasGroup := len(groups) > 0
			if hasGroup {
				group = groups[len(groups)-1]
				groups = groups[:len(groups)-1]
			}
			innerRun := 0
			if len(runs) > 1 {
				innerRun = runs[len(runs)-1]
				runs = runs[:len(runs)-1]
			}
			empty := hasGroup && index == group.start
			index++
			groupQuantifier := quantifier()
			switch {
			case empty:
				// Matches the empty string either way — (), (?:), (?=) —
				// so there is nothing on either side of it to disambiguate:
				// leave the run exactly as it stood, never a reset, never a
				// part of its own.
			case groupQuantifier == quantNone && innerRun > 0:
				// No quantifier of its own, but it closed on an active
				// repeat: as exploitable here as that repeat sitting
				// directly at this level.
				part(quantRepeats)
			default:
				part(groupQuantifier)
			}
		case char == '|':
			runs[len(runs)-1] = 0
			index++
		case char == '^' || char == '$':
			index++
		default:
			index++
			part(quantifier())
		}
	}
	return longest
}
