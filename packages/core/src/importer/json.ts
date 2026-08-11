import type { ParsedEntry, ParseResult, ParseWarning } from './types';

/**
 * JSON config importer, and the tree-flattening rules shared with YAML.
 *
 * Both formats describe a tree; environment variables are flat. The mapping is
 * `{"database": {"url": "…"}}` → `database_url`, which the planner then
 * normalises to `DATABASE_URL`. Keeping flattening here — rather than once per
 * format — is what stops a JSON import and the equivalent YAML import producing
 * different names.
 */

/**
 * JSON.parse discards source positions, and the position it reports on failure
 * is worded differently in every engine. Entries are therefore anchored to the
 * document rather than to a line; the UI identifies them by key.
 */
const DOCUMENT_LINE = 1;

/**
 * Nesting deeper than this is not a config file, it is either a mistake or an
 * attempt to exhaust the stack with a small payload. Sixteen levels is far past
 * anything a human writes.
 */
const MAX_DEPTH = 16;

export function parseJson(content: string): ParseResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    // Deep input makes JSON.parse throw RangeError, not SyntaxError, so this
    // catches everything. The engine's message is included because it is the
    // only position information available and it contains no user data beyond
    // the offending token.
    return {
      entries: [],
      warnings: [
        {
          line: DOCUMENT_LINE,
          message: `The file is not valid JSON: ${errorMessage(error)}`,
        },
      ],
    };
  }

  return flattenTree(parsed);
}

/**
 * Flattens a parsed JSON/YAML document into `key_subkey` entries.
 *
 * Exported so `yaml.ts` can share it verbatim; not part of the module's public
 * surface — see `index.ts`.
 */
export function flattenTree(root: unknown): ParseResult {
  const entries: ParsedEntry[] = [];
  const warnings: ParseWarning[] = [];

  if (!isPlainObject(root)) {
    warnings.push({
      line: DOCUMENT_LINE,
      message: Array.isArray(root)
        ? 'The document is a list. Secrets are imported from key/value pairs, so the top level must be an object.'
        : 'The document does not contain key/value pairs at the top level.',
    });
    return { entries, warnings };
  }

  walk(root, [], 0, entries, warnings);

  if (entries.length === 0 && warnings.length === 0) {
    warnings.push({ line: DOCUMENT_LINE, message: 'The document contains no key/value pairs.' });
  }

  return { entries, warnings };
}

function walk(
  node: Record<string, unknown>,
  prefix: readonly string[],
  depth: number,
  entries: ParsedEntry[],
  warnings: ParseWarning[],
): void {
  for (const [key, value] of Object.entries(node)) {
    const path = [...prefix, key];
    const name = path.join('_');

    if (Array.isArray(value)) {
      // JSON-stringifying the array is the tempting alternative, and it is
      // wrong: the user would get a secret whose value is `["a","b"]` and no
      // sign that nothing on the consuming side will ever parse it back.
      warnings.push({
        line: DOCUMENT_LINE,
        message: `"${name}" is a list, which has no environment variable equivalent. Flatten it into separate keys to import it.`,
      });
      continue;
    }

    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        warnings.push({ line: DOCUMENT_LINE, message: `"${name}" is empty and was skipped.` });
        continue;
      }
      if (depth + 1 >= MAX_DEPTH) {
        warnings.push({
          line: DOCUMENT_LINE,
          message: `"${name}" is nested more than ${MAX_DEPTH} levels deep and was skipped.`,
        });
        continue;
      }
      walk(value, path, depth + 1, entries, warnings);
      continue;
    }

    const scalar = coerceScalar(value, name, warnings);
    if (scalar === null) {
      warnings.push({
        line: DOCUMENT_LINE,
        message: `"${name}" has a type that cannot be stored as a secret and was skipped.`,
      });
      continue;
    }

    entries.push({ key: name, value: scalar, line: DOCUMENT_LINE });
  }
}

/**
 * Coerces a non-string scalar to the text a program would see in its
 * environment. There is no such thing as a numeric environment variable, so
 * `{"port": 5432}` has to become `"5432"` — refusing it would reject most real
 * config files for no benefit.
 *
 * `null` becomes the empty string rather than the text `"null"`. In both
 * formats — and especially in YAML, where a bare `PASSWORD:` parses as null —
 * an absent value means "nothing here"; storing the four characters `null` as
 * someone's password is never what was meant.
 *
 * Returns `null` for values with no textual meaning at all (functions, symbols,
 * `undefined`), which the caller reports rather than guessing at.
 */
function coerceScalar(value: unknown, name: string, warnings: ParseWarning[]): string | null {
  if (typeof value === 'string') return value;

  if (typeof value === 'number') {
    // A long digit string — an account number, a Discord snowflake, a numeric
    // API key — parses as a float and comes back rounded. The value still
    // imports, because refusing it would be worse, but the user is told the
    // digits changed rather than discovering it in production.
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      warnings.push({
        line: DOCUMENT_LINE,
        message: `"${name}" is a number too large to represent exactly. Quote it in the source file to import the exact digits.`,
      });
    }
    return String(value);
  }

  if (typeof value === 'boolean') return String(value);
  if (value === null) return '';

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
