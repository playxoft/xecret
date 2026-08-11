import { stringify as stringifyYaml } from 'yaml';
import { SECRET_NAME_PATTERN } from '../validation/secret-name';

/**
 * Rendering secrets into the file formats people export them to.
 *
 * The whole module is one property: **whatever goes in comes back out
 * byte-for-byte**. A quoting bug here does not throw, it hands someone a
 * password with a character missing, and they find out when a service fails to
 * authenticate at 3am. `format.test.ts` asserts the round-trip through this
 * repository's own parsers for a set of deliberately hostile values; that test
 * is the actual specification of the escaping rules below.
 *
 * Where a format cannot represent a value, this throws rather than emitting
 * something close. A truncated secret that looks fine is worse than an error.
 */

export type ExportFormat = 'env' | 'json' | 'yaml' | 'shell' | 'docker';

export interface ExportableSecret {
  name: string;
  value: string;
}

export class ExportFormatError extends Error {
  constructor(
    readonly secretName: string,
    reason: string,
  ) {
    // The name is safe to put in an error message; the value never is, because
    // this string will be logged.
    super(`Cannot export "${secretName}": ${reason}`);
    this.name = 'ExportFormatError';
  }
}

export function formatSecrets(
  secrets: ReadonlyArray<ExportableSecret>,
  format: ExportFormat,
): string {
  for (const secret of secrets) assertRepresentableName(secret.name, format);

  switch (format) {
    case 'env':
      return joinLines(secrets.map((s) => `${s.name}=${quoteEnvValue(s.value)}`));
    case 'shell':
      return joinLines(secrets.map((s) => `export ${s.name}=${quoteSingle(s)}`));
    case 'docker':
      return joinLines(secrets.map((s) => `${s.name}=${dockerValue(s)}`));
    case 'json':
      return `${JSON.stringify(toSortedRecord(secrets), null, 2)}\n`;
    case 'yaml':
      return stringifyYaml(toSortedRecord(secrets), {
        /**
         * Line folding is reversible in theory and a liability in practice: it
         * only round-trips if every consumer implements folding identically,
         * and the cost of one that does not is a corrupted secret. Long values
         * stay on one line.
         */
        lineWidth: 0,
        /**
         * Quote every value, always. An unquoted `yes`, `NO`, `null`, `1.10` or
         * `08:00` is a string under YAML 1.2 and something else entirely under
         * YAML 1.1 — which is what PyYAML and much of the Ruby and PHP world
         * still implement. `PASSWORD: yes` reaching Python as the boolean
         * `True` is a real failure mode, and quoting costs two characters.
         */
        defaultStringType: 'QUOTE_DOUBLE',
        /** Keys are validated secret names, so they need no quoting. */
        defaultKeyType: 'PLAIN',
      });
  }
}

/**
 * `env`, `shell` and `docker` are line-oriented and keep the caller's order —
 * which is the order the UI displayed and the user reasoned about. `json` and
 * `yaml` are documents whose key order carries no meaning, so they are sorted:
 * a secret added today should produce a one-line diff, not a reshuffled file.
 *
 * Sorting is by code unit rather than `localeCompare`, so the output does not
 * depend on the server's locale.
 */
function toSortedRecord(secrets: ReadonlyArray<ExportableSecret>): Record<string, string> {
  const sorted = [...secrets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.fromEntries(sorted.map((secret) => [secret.name, secret.value]));
}

function joinLines(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('');
}

/**
 * A name that is not a valid identifier would produce a line that parses back
 * as something else — `A=B=value` reads as `A` holding `B=value`. Names come
 * from the database and are already constrained, so this is a guard against a
 * future caller, not a validation step.
 */
function assertRepresentableName(name: string, format: ExportFormat): void {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new ExportFormatError(name, `"${name}" is not a valid secret name for ${format} output.`);
  }
}

/**
 * Values that force quoting in a `.env` file.
 *
 * Whitespace and `#` change where the value ends. Quotes and backslashes change
 * how it is read. `$` and backtick do not matter to this repository's parser —
 * it never interpolates — but they do to python-dotenv, Docker Compose and
 * anything that sources the file, so a value containing one is quoted to keep
 * those readers from expanding it.
 */
const ENV_NEEDS_QUOTING = /[\s#"'$`\\]/;

/**
 * Quotes a `.env` value, and only when something in it requires quoting.
 *
 * Single quotes are preferred because they are literal in every dialect: no
 * escapes to get wrong, and no interpolation even in readers that perform it.
 * Double quotes are used only for values a single-quoted string cannot express
 * — one containing a `'`, since the literal form has no way to escape its own
 * delimiter — or a newline, which is escaped rather than written literally so
 * that one line of output stays one secret. A file truncated mid-write then
 * loses a secret instead of merging the remainder into the previous value.
 */
function quoteEnvValue(value: string): string {
  if (value === '' || !ENV_NEEDS_QUOTING.test(value)) return value;
  if (!/['\n\r]/.test(value)) return `'${value}'`;

  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

  return `"${escaped}"`;
}

/**
 * The only generally safe way to quote for a shell: single quotes, with the
 * `'\''` idiom for an embedded quote — close the string, emit an escaped quote,
 * reopen it. Nothing inside single quotes is expanded, so a value containing
 * `$(rm -rf …)` is inert when the file is sourced.
 *
 * A newline needs no escaping — inside single quotes it is literal — but a
 * carriage return is refused. Single quotes have no escape mechanism at all, so
 * the CR would have to be written raw, and every reader of the resulting file
 * (this repository's parsers included) normalises line endings before looking
 * at the content. The byte would be silently lost on the way back in, which is
 * the one outcome worth throwing over. `env` and `json` escape it and are the
 * formats to use for a value that contains one.
 */
function quoteSingle(secret: ExportableSecret): string {
  if (secret.value.includes('\r')) {
    throw new ExportFormatError(
      secret.name,
      'shell output cannot represent a carriage return, which would be lost when the file is read back. Export it as env or json instead.',
    );
  }
  return `'${secret.value.replace(/'/g, "'\\''")}'`;
}

/**
 * Docker's `--env-file` grammar has no quoting at all: everything after the
 * first `=` is the value, verbatim, to the end of the line.
 *
 * That makes a newline unrepresentable — Docker would read the remainder as a
 * new variable, or drop it. Emitting a value silently cut at the first newline
 * is exactly the failure this module exists to prevent, so it is an error.
 *
 * It also means a value containing ` #` or leading whitespace exports fine here
 * but is not `.env`-compatible, because that grammar is verbatim and `.env` is
 * not. That is a property of `--env-file`, and the reason `env` is the format
 * to reach for by default.
 */
function dockerValue(secret: ExportableSecret): string {
  if (/[\n\r]/.test(secret.value)) {
    throw new ExportFormatError(
      secret.name,
      'Docker env files cannot represent a value containing a line break. Export it as env, json or yaml instead.',
    );
  }
  return secret.value;
}
