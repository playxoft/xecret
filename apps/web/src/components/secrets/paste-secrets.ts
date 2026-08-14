import { parseDotenv } from '@xecret/core/importer';
import type { ParseWarning } from '@xecret/core/importer';
import { checkSecretName, normalizeSecretName } from '@xecret/core/validation';
import type { DraftSeed } from './staged-changes';

/**
 * Pasted `KEY=value` text, turned into rows the table can show.
 *
 * ── Why this parses in the browser rather than posting to `/import` ──
 * The import endpoint exists and is the right tool for a *file*: it plans,
 * reports conflicts, and applies a strategy server-side in one request. This is
 * the other half of the same job — someone pasting three lines out of a
 * teammate's `.env` who wants to see and edit them before anything is written.
 * Parsing here keeps that paste on the user's machine until they press save, so
 * a block of credentials that was pasted by mistake never leaves the browser.
 *
 * `parseDotenv` is the same parser the server runs, imported from `@xecret/core`
 * rather than reimplemented, so a quoted multi-line private key splits into rows
 * here exactly as it would have been stored by an import.
 *
 * Nothing in this module logs, and nothing it returns carries a value into a
 * message: `warnings` come from the parser, which is documented never to quote
 * the text it rejected, and `renamed` carries key names only.
 */

export interface RenamedKey {
  from: string;
  to: string;
}

export interface PastedSecrets {
  seeds: readonly DraftSeed[];
  warnings: readonly ParseWarning[];
  /** Keys that were not legal secret names and were corrected on the way in. */
  renamed: readonly RenamedKey[];
}

/**
 * Whether a paste into a *name* field should be treated as a block of
 * assignments rather than as a name.
 *
 * A legal secret name matches `^[A-Za-z_][A-Za-z0-9_]*$`, so it can never
 * contain `=` or a newline. Either character therefore means the user pasted
 * something other than a single name, and expanding it is what they meant.
 */
export function looksLikeAssignments(text: string): boolean {
  return text.includes('=') || /[\r\n]/.test(text);
}

export function parsePastedSecrets(text: string): PastedSecrets {
  const parsed = parseDotenv(text);
  const seeds: DraftSeed[] = [];
  const renamed: RenamedKey[] = [];

  for (const entry of parsed.entries) {
    if (checkSecretName(entry.key).valid) {
      seeds.push({ name: entry.key, value: entry.value });
      continue;
    }

    // `database.url` → `DATABASE_URL`, the same normalisation the import
    // planner applies. When nothing legal can be derived the raw key is kept
    // so the row shows the inline error and the user can fix it in place —
    // dropping the entry would lose a value the user believes they pasted.
    const suggestion = normalizeSecretName(entry.key);
    if (suggestion !== '' && checkSecretName(suggestion).valid) {
      renamed.push({ from: entry.key, to: suggestion });
      seeds.push({ name: suggestion, value: entry.value });
    } else {
      seeds.push({ name: entry.key, value: entry.value });
    }
  }

  return { seeds, warnings: parsed.warnings, renamed };
}
