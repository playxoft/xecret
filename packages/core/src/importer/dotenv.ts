import type { ParsedEntry, ParseResult, ParseWarning } from './types';

/**
 * A `.env` parser.
 *
 * There is no specification for this format — only a decade of tools that each
 * implement a slightly different dialect. The rules below are the intersection
 * that real files rely on, chosen so that the common shapes (Rails, Docker
 * Compose, Vercel, a PEM key pasted across twenty lines) all import correctly.
 *
 * Two rules are load-bearing enough to state up front.
 *
 * **This parser never throws.** Its input is a file a stranger dragged into a
 * browser. An exception here is a failed import with a stack trace instead of a
 * message a user can act on, and — worse — a crash inside a request that is
 * holding plaintext secrets. Every malformed construct produces a warning and
 * the parse continues.
 *
 * **`${VAR}` interpolation is deliberately not implemented.** Resolving a
 * variable reference at import time would bake a value from whatever shell,
 * container, or CI runner performed the import into a stored secret. The user
 * would see `${DB_PASSWORD}` in their file and a resolved value in the vault,
 * with no indication of where it came from — surprising at best, and a path for
 * one environment's values to leak into another at worst. `$` is stored as
 * written; resolution, if it ever happens, belongs to whatever consumes the
 * secret.
 */

/**
 * Byte-order mark. Windows editors and PowerShell's `>` redirection add one,
 * and it is invisible in every diff viewer — so without this the first key of
 * the file becomes `\uFEFFDATABASE_URL` and imports as a broken duplicate.
 */
const BOM = '\uFEFF';

/**
 * Splits source into lines, discarding the two things that are encoding
 * artefacts rather than data: a BOM and CRLF/CR line endings.
 *
 * Normalising line endings for the whole document — including inside quoted
 * values — is intentional. A private key committed from Windows would otherwise
 * import with a `\r` at the end of every line: invisible in the UI, and enough
 * to make an SSH key or a database URL fail somewhere far from here.
 *
 * Exported for the shell parser, which shares this preprocessing. Not part of
 * the module's public surface — see `index.ts`.
 */
export function splitSourceLines(content: string): string[] {
  const withoutBom = content.startsWith(BOM) ? content.slice(BOM.length) : content;
  return withoutBom.split(/\r\n|\r|\n/);
}

/** A line holding nothing but whitespace, or a whole-line `#` comment. */
export function isBlankOrComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed === '' || trimmed.startsWith('#');
}

const EXPORT_PREFIX = /^\s*export\s+/;

/**
 * Splits `KEY=…` into its key and the offset where the value begins.
 *
 * The `export ` prefix is accepted because `.env` files are routinely written
 * to be `source`-able. Requiring whitespace after it means a key literally
 * called `export` (or `exports`) still parses as a key.
 *
 * Returns `null` when the line has no `=` at all, which the caller reports.
 */
export function splitAssignment(line: string): { key: string; valueStart: number } | null {
  const withoutExport = line.replace(EXPORT_PREFIX, '');
  const start = line.length - withoutExport.length;

  const equals = line.indexOf('=', start);
  if (equals === -1) return null;

  return { key: line.slice(start, equals).trim(), valueStart: equals + 1 };
}

/**
 * Reads an unquoted value: strips a trailing comment, then trailing whitespace.
 *
 * A `#` only starts a comment when whitespace precedes it. `PASSWORD=abc#123`
 * is a password containing a hash, not a two-character password followed by a
 * comment — and the `#` position matters more than it looks, because the same
 * rule decides whether `KEY= # unset for now` is empty (it is) or the literal
 * text `# unset for now`. Pass the slice starting immediately after the `=` so
 * that distinction survives.
 *
 * No escape processing happens here: outside quotes, a backslash is a
 * backslash. Windows paths and regexes appear in `.env` files far more often
 * than someone hand-writing `\n` outside quotes and expecting a newline.
 */
export function readUnquotedValue(text: string): string {
  const comment = findInlineComment(text);
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

function findInlineComment(text: string): number {
  for (let index = 1; index < text.length; index += 1) {
    if (text.charAt(index) === '#' && /\s/.test(text.charAt(index - 1))) return index;
  }
  return -1;
}

/**
 * Salvages a value whose opening quote is never closed.
 *
 * The obvious alternative — read to end of file, since that is where the quote
 * would have to close — is the wrong failure. One stray quote in a forty-line
 * file would swallow the other thirty-nine keys into a single value, and the
 * user would see "1 secret will be added" with no idea why. Recovering the
 * opening line alone keeps the damage to the line that actually contains the
 * typo, and the caller emits a warning naming it.
 */
export function recoverUnterminated(line: string, valueStart: number): string {
  const rest = line.slice(valueStart).trimStart();
  const opensWithQuote = rest.startsWith('"') || rest.startsWith("'");
  return readUnquotedValue(opensWithQuote ? rest.slice(1) : rest);
}

/**
 * Applies the last-wins rule for duplicate keys, loudly.
 *
 * Last-wins matches every shell and every `.env` loader, so it is what the file
 * author expects. The warning is the part that matters: a duplicated key is
 * usually a bad merge, and importing the wrong one of two passwords without
 * saying so is how someone spends an afternoon debugging production.
 *
 * A `Map` keyed by name gives last-wins values in first-seen order, which is
 * the order the preview should list them in.
 */
export function recordEntry(
  seen: Map<string, ParsedEntry>,
  warnings: ParseWarning[],
  entry: ParsedEntry,
): void {
  const previous = seen.get(entry.key);
  if (previous !== undefined) {
    warnings.push({
      line: entry.line,
      message: `"${entry.key}" is defined more than once. The value on line ${entry.line} replaces the one on line ${previous.line}.`,
    });
  }
  seen.set(entry.key, entry);
}

interface ValueRead {
  value: string;
  /** Index of the last line consumed, so multi-line values advance the cursor. */
  endIndex: number;
  warnings: ParseWarning[];
}

export function parseDotenv(content: string): ParseResult {
  const lines = splitSourceLines(content);
  const seen = new Map<string, ParsedEntry>();
  const warnings: ParseWarning[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;

    if (isBlankOrComment(line)) continue;

    const assignment = splitAssignment(line);
    if (assignment === null) {
      // The offending text is never quoted back: a line that failed to parse is
      // still a line out of a file full of credentials.
      warnings.push({ line: lineNumber, message: `Line ${lineNumber} is not KEY=value; skipped.` });
      continue;
    }

    if (assignment.key === '') {
      warnings.push({ line: lineNumber, message: `Line ${lineNumber} has no key; skipped.` });
      continue;
    }

    const read = readValue(lines, index, assignment.valueStart);
    warnings.push(...read.warnings);
    recordEntry(seen, warnings, { key: assignment.key, value: read.value, line: lineNumber });
    index = read.endIndex;
  }

  return { entries: [...seen.values()], warnings };
}

function readValue(lines: readonly string[], startIndex: number, valueStart: number): ValueRead {
  const line = lines[startIndex] ?? '';
  const rest = line.slice(valueStart);
  // Whitespace between `=` and the value is not part of the value, so `KEY= "x"`
  // is still a quoted value.
  const cursor = valueStart + (rest.length - rest.trimStart().length);
  const quote = line.charAt(cursor);

  if (quote === '"' || quote === "'") {
    const quoted = readQuoted(lines, startIndex, cursor + 1, quote);
    if (quoted !== null) return quoted;

    return {
      value: recoverUnterminated(line, valueStart),
      endIndex: startIndex,
      warnings: [
        {
          line: startIndex + 1,
          message: `The quote opened on line ${startIndex + 1} is never closed. The rest of that line was used as the value.`,
        },
      ],
    };
  }

  return { value: readUnquotedValue(rest), endIndex: startIndex, warnings: [] };
}

/**
 * Reads a quoted value, which may span any number of lines — the case that
 * motivates the whole scanner, because a pasted PEM key is the most common
 * multi-line secret there is.
 *
 * Returns `null` if the closing quote never arrives.
 */
function readQuoted(
  lines: readonly string[],
  startIndex: number,
  from: number,
  quote: '"' | "'",
): ValueRead | null {
  let value = '';
  let index = startIndex;
  let cursor = from;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    while (cursor < line.length) {
      const char = line.charAt(cursor);

      if (char === quote) {
        return {
          value,
          endIndex: index,
          warnings: trailingWarnings(line, cursor + 1, index + 1),
        };
      }

      // Single quotes are fully literal: no escapes, no interpolation, nothing.
      // That is what makes them the safe way to write a value containing
      // backslashes or dollar signs, and it is worth preserving exactly.
      if (char === '\\' && quote === '"') {
        value += unescape(line.charAt(cursor + 1));
        cursor += 2;
        continue;
      }

      value += char;
      cursor += 1;
    }

    // End of line inside a quote: the value continues, and the newline is part
    // of it.
    value += '\n';
    index += 1;
    cursor = 0;
  }

  return null;
}

/**
 * The five escapes a double-quoted `.env` value may contain.
 *
 * Anything else keeps its backslash. Dropping it — the other plausible rule —
 * silently corrupts `"C:\Users\deploy"` into `C:Usersdeploy` and every regex
 * with a `\d` in it. Preserving unknown escapes can at worst leave a backslash
 * the author intended to remove; dropping them destroys data.
 *
 * A backslash at end of line falls through to the same rule and stays literal:
 * this format has no line continuation, and inventing one would let a stray
 * trailing backslash join two unrelated secrets into one.
 */
function unescape(char: string): string {
  switch (char) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case '\\':
      return '\\';
    case '"':
      return '"';
    default:
      return `\\${char}`;
  }
}

function trailingWarnings(line: string, from: number, lineNumber: number): ParseWarning[] {
  const rest = line.slice(from).trim();
  if (rest === '' || rest.startsWith('#')) return [];

  return [
    {
      line: lineNumber,
      message: `Ignored unexpected text after the closing quote on line ${lineNumber}.`,
    },
  ];
}
