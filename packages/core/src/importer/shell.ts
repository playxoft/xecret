import {
  isBlankOrComment,
  recordEntry,
  recoverUnterminated,
  splitAssignment,
  splitSourceLines,
} from './dotenv';
import type { ParsedEntry, ParseResult, ParseWarning } from './types';

/**
 * Parser for shell environment dumps: the output of `export -p`, a hand-written
 * `source`-able file, or `xecret pull --format shell`.
 *
 * The line shape is the same as `.env` — `export KEY=value` — and the framing
 * (BOM, line endings, comments, `export` prefix, last-wins duplicates) is
 * genuinely shared, so it is imported rather than reimplemented. The quoting
 * grammar is *not* the same, and treating it as the same corrupts values:
 *
 *  - **Double quotes.** POSIX gives `\` special meaning before exactly `"`,
 *    `\``, `$` and `\` — and nothing else. `"a\nb"` in a shell dump is the six
 *    characters `a`, `\`, `n`, `b`… not a newline. Applying the `.env` escape
 *    table here would silently turn a Windows path or a regex into different
 *    data, in the one file format whose values were produced by a machine and
 *    are therefore assumed exact.
 *  - **Adjacent segments concatenate.** `'it'\''s'` is a single word meaning
 *    `it's`; it is how every shell emits an embedded apostrophe, and it is the
 *    exact form this codebase's own shell exporter produces. `.env` has no
 *    concatenation, so it cannot express that value at all.
 *  - **Backslash outside quotes escapes the next character**, which `.env`
 *    treats as literal.
 *
 * Like the `.env` parser, this never throws and never performs `$` expansion —
 * see `dotenv.ts` for why that matters.
 */
export function parseShell(content: string): ParseResult {
  const lines = splitSourceLines(content);
  const seen = new Map<string, ParsedEntry>();
  const warnings: ParseWarning[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;

    if (isBlankOrComment(line)) continue;

    const assignment = splitAssignment(line);
    if (assignment === null) {
      warnings.push({
        line: lineNumber,
        message: `Line ${lineNumber} is not an assignment; skipped.`,
      });
      continue;
    }

    if (assignment.key === '') {
      warnings.push({ line: lineNumber, message: `Line ${lineNumber} has no key; skipped.` });
      continue;
    }

    const word = readWord(lines, index, assignment.valueStart);

    if (word.terminated) {
      warnings.push(...trailingWarnings(lines, word.endIndex, word.endCursor));
      recordEntry(seen, warnings, { key: assignment.key, value: word.value, line: lineNumber });
      index = word.endIndex;
      continue;
    }

    // Same recovery as the `.env` parser: contain an unclosed quote to its own
    // line rather than letting it consume every following secret.
    warnings.push({
      line: lineNumber,
      message: `The quote opened on line ${lineNumber} is never closed. The rest of that line was used as the value.`,
    });
    recordEntry(seen, warnings, {
      key: assignment.key,
      value: recoverUnterminated(line, assignment.valueStart),
      line: lineNumber,
    });
  }

  return { entries: [...seen.values()], warnings };
}

interface WordRead {
  value: string;
  /** Index of the last line consumed. */
  endIndex: number;
  /** Offset just past the word, where a trailing comment may begin. */
  endCursor: number;
  terminated: boolean;
}

/**
 * Reads one shell word, concatenating quoted and unquoted segments until
 * unquoted whitespace or end of line ends it. Quoted segments may span lines.
 */
function readWord(lines: readonly string[], startIndex: number, from: number): WordRead {
  let value = '';
  let index = startIndex;
  let cursor = from;
  let quote: '"' | "'" | null = null;

  // Leading whitespace after `=` is not part of the value.
  const opening = lines[startIndex] ?? '';
  while (cursor < opening.length && /\s/.test(opening.charAt(cursor))) cursor += 1;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    while (cursor < line.length) {
      const char = line.charAt(cursor);

      if (quote === null) {
        if (char === '"' || char === "'") {
          quote = char;
          cursor += 1;
          continue;
        }
        if (/\s/.test(char)) {
          return { value, endIndex: index, endCursor: cursor, terminated: true };
        }
        if (char === '\\') {
          // A trailing backslash has nothing to escape. Keeping it literal
          // rather than implementing line continuation is the same choice the
          // `.env` parser makes, and for the same reason.
          const next = line.charAt(cursor + 1);
          value += next === '' ? '\\' : next;
          cursor += 2;
          continue;
        }
        value += char;
        cursor += 1;
        continue;
      }

      if (char === quote) {
        quote = null;
        cursor += 1;
        continue;
      }

      if (quote === '"' && char === '\\') {
        const next = line.charAt(cursor + 1);
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          value += next;
          cursor += 2;
          continue;
        }
        // Not one of the four: the backslash is an ordinary character. This is
        // the divergence from `.env` that matters most.
        value += char;
        cursor += 1;
        continue;
      }

      value += char;
      cursor += 1;
    }

    if (quote === null) {
      return { value, endIndex: index, endCursor: cursor, terminated: true };
    }

    value += '\n';
    index += 1;
    cursor = 0;
  }

  return { value, endIndex: startIndex, endCursor: cursor, terminated: false };
}

function trailingWarnings(lines: readonly string[], index: number, cursor: number): ParseWarning[] {
  const rest = (lines[index] ?? '').slice(cursor).trim();
  if (rest === '' || rest.startsWith('#')) return [];

  return [
    {
      line: index + 1,
      message: `Ignored unexpected text after the value on line ${index + 1}.`,
    },
  ];
}
