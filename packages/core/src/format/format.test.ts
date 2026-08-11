import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../importer/dotenv';
import { parseJson } from '../importer/json';
import { parseShell } from '../importer/shell';
import { parseYaml } from '../importer/yaml';
import type { ParseResult } from '../importer/types';
import { ExportFormatError, formatSecrets } from './format';
import type { ExportableSecret } from './format';

const PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAyLGqLTPGWvKmYQF9vB3nJZ0X1kQ7hRr2mN8sD4tW6uV0pC1e
9aXbYzR3kFqL5oN7wS2dH8jT4gM1vB6cP0rE3nK9xA7yU2iO5lQ8fD1zJ4hG6mV3
-----END RSA PRIVATE KEY-----`;

/**
 * Every value that has ever broken a naive quoting implementation. The
 * round-trip assertions below are the real specification of the escaping rules
 * in `format.ts`: a bug there does not throw, it hands someone a password with
 * a character missing.
 */
const NASTY: ExportableSecret[] = [
  { name: 'EMPTY', value: '' },
  { name: 'PLAIN', value: 'simple-value' },
  { name: 'SPACES', value: '  leading and trailing  ' },
  { name: 'HASH', value: 'SG.abc#123' },
  { name: 'HASH_AFTER_SPACE', value: 'value # not a comment' },
  { name: 'EQUALS', value: 'a=b=c' },
  { name: 'SINGLE_QUOTE', value: "it's" },
  { name: 'DOUBLE_QUOTE', value: 'say "hi"' },
  { name: 'BOTH_QUOTES', value: `mixed '"' quotes` },
  { name: 'BACKSLASH', value: 'C:\\Users\\deploy\\.ssh' },
  { name: 'ESCAPE_LOOKALIKE', value: String.raw`literal \n and \t` },
  { name: 'DOLLAR', value: '${NOT_INTERPOLATED} $PATH' },
  { name: 'BACKTICK', value: 'a`whoami`b' },
  { name: 'NEWLINES', value: 'line one\nline two' },
  { name: 'CARRIAGE_RETURN', value: 'before\rafter' },
  { name: 'TAB', value: 'before\tafter' },
  { name: 'UNICODE', value: 'pässwörd — 日本語 — 🔐' },
  { name: 'ONLY_HASH', value: '#' },
  { name: 'PEM_KEY', value: PEM },
];

function asRecord(secrets: ReadonlyArray<ExportableSecret>): Record<string, string> {
  return Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]));
}

function parsedRecord(result: ParseResult): Record<string, string> {
  return Object.fromEntries(result.entries.map((entry) => [entry.key, entry.value]));
}

/**
 * Values a format is honest about being unable to carry, and refuses. They are
 * excluded from that format's round-trip and asserted on separately, so the
 * exclusion is a documented limit rather than a gap in the test.
 */
const UNREPRESENTABLE: Partial<Record<string, readonly string[]>> = {
  shell: ['CARRIAGE_RETURN'],
};

describe('formatSecrets round-trips', () => {
  it.each([
    ['env', parseDotenv],
    ['shell', parseShell],
    ['json', parseJson],
    ['yaml', parseYaml],
  ] as const)('every value survives %s exactly', (format, parse) => {
    const excluded = UNREPRESENTABLE[format] ?? [];
    const secrets = NASTY.filter((secret) => !excluded.includes(secret.name));
    const result = parse(formatSecrets(secrets, format));

    expect(result.warnings).toEqual([]);
    expect(parsedRecord(result)).toEqual(asRecord(secrets));
  });

  it('keeps line-oriented formats in the caller order', () => {
    const result = parseDotenv(formatSecrets(NASTY, 'env'));
    expect(result.entries.map((entry) => entry.key)).toEqual(NASTY.map((secret) => secret.name));
  });

  it('round-trips a value through env, back out, and in again unchanged', () => {
    const once = formatSecrets(NASTY, 'env');
    const twice = formatSecrets(
      parseDotenv(once).entries.map((entry) => ({ name: entry.key, value: entry.value })),
      'env',
    );

    expect(twice).toBe(once);
  });
});

describe('formatSecrets: env', () => {
  it('quotes only when the value requires it', () => {
    const output = formatSecrets(
      [
        { name: 'PLAIN', value: 'simple-value' },
        { name: 'URL', value: 'postgres://app:pw@db.internal:5432/app?sslmode=require' },
        { name: 'EMPTY', value: '' },
        { name: 'SPACED', value: 'two words' },
      ],
      'env',
    );

    expect(output).toBe(
      [
        'PLAIN=simple-value',
        'URL=postgres://app:pw@db.internal:5432/app?sslmode=require',
        'EMPTY=',
        "SPACED='two words'",
        '',
      ].join('\n'),
    );
  });

  // Single quotes are literal in every dialect, so a value containing `$` cannot
  // be expanded by a reader that performs interpolation.
  it('prefers single quotes, which no reader interpolates', () => {
    expect(formatSecrets([{ name: 'A', value: '${HOME}/x' }], 'env')).toBe("A='${HOME}/x'\n");
    expect(formatSecrets([{ name: 'A', value: 'C:\\Users' }], 'env')).toBe("A='C:\\Users'\n");
  });

  // A single-quoted string has no way to escape its own delimiter.
  it('uses double quotes for a value containing an apostrophe', () => {
    expect(formatSecrets([{ name: 'A', value: "it's" }], 'env')).toBe('A="it\'s"\n');
  });

  // One line of output stays one secret: a file truncated mid-write loses a
  // secret instead of merging the rest into the previous value.
  it('escapes newlines rather than writing them literally', () => {
    expect(formatSecrets([{ name: 'A', value: 'one\ntwo' }], 'env')).toBe('A="one\\ntwo"\n');
    expect(formatSecrets([{ name: 'K', value: PEM }], 'env').split('\n')).toHaveLength(2);
  });
});

describe('formatSecrets: shell', () => {
  it('single-quotes every value and escapes embedded quotes', () => {
    const output = formatSecrets(
      [
        { name: 'PLAIN', value: 'value' },
        { name: 'APOSTROPHE', value: "it's" },
        { name: 'INJECTION', value: '$(rm -rf /)' },
      ],
      'shell',
    );

    expect(output).toBe(
      [
        "export PLAIN='value'",
        "export APOSTROPHE='it'\\''s'",
        "export INJECTION='$(rm -rf /)'",
        '',
      ].join('\n'),
    );
  });

  it('writes a newline literally, since single quotes need no escape for it', () => {
    const output = formatSecrets([{ name: 'K', value: PEM }], 'shell');
    expect(parsedRecord(parseShell(output))).toEqual({ K: PEM });
  });

  // Single quotes have no escape mechanism, so the CR would be written raw and
  // normalised away by every reader — including this repository's parsers.
  it('refuses a carriage return rather than losing it on the way back in', () => {
    expect(() => formatSecrets([{ name: 'A', value: 'before\rafter' }], 'shell')).toThrow(
      /carriage return/,
    );
    expect(parsedRecord(parseDotenv(formatSecrets([{ name: 'A', value: 'a\rb' }], 'env')))).toEqual(
      {
        A: 'a\rb',
      },
    );
  });
});

describe('formatSecrets: json', () => {
  it('sorts keys so a diff shows only what changed', () => {
    const output = formatSecrets(
      [
        { name: 'ZULU', value: '1' },
        { name: 'ALPHA', value: '2' },
        { name: 'MIKE', value: '3' },
      ],
      'json',
    );

    expect(output).toBe('{\n  "ALPHA": "2",\n  "MIKE": "3",\n  "ZULU": "1"\n}\n');
  });

  it('produces identical output regardless of the order it was given', () => {
    const forwards = formatSecrets(NASTY, 'json');
    const backwards = formatSecrets([...NASTY].reverse(), 'json');

    expect(forwards).toBe(backwards);
  });
});

describe('formatSecrets: yaml', () => {
  // Unquoted, `yes` is a string under YAML 1.2 and boolean true under 1.1,
  // which is what PyYAML implements.
  it('quotes every value so no reader can retype it', () => {
    const output = formatSecrets(
      [
        { name: 'FLAG', value: 'yes' },
        { name: 'PORT', value: '5432' },
        { name: 'TIME', value: '08:00' },
        { name: 'NOTHING', value: '' },
      ],
      'yaml',
    );

    expect(output).toBe('FLAG: "yes"\nNOTHING: ""\nPORT: "5432"\nTIME: "08:00"\n');
  });

  it('keeps a long value on one line rather than folding it', () => {
    const value = `${'a'.repeat(200)} ${'b'.repeat(200)}`;
    const output = formatSecrets([{ name: 'LONG', value }], 'yaml');

    expect(output.split('\n')).toHaveLength(2);
    expect(parsedRecord(parseYaml(output))).toEqual({ LONG: value });
  });
});

describe('formatSecrets: docker', () => {
  it('writes values verbatim, as --env-file reads them', () => {
    const output = formatSecrets(
      [
        { name: 'PLAIN', value: 'value' },
        { name: 'SPACED', value: 'two words' },
        { name: 'QUOTES', value: `"quoted"` },
      ],
      'docker',
    );

    expect(output).toBe('PLAIN=value\nSPACED=two words\nQUOTES="quoted"\n');
  });

  // Docker would read the remainder of a multi-line value as a new variable, or
  // drop it. Emitting a secret silently cut at the first newline is the failure
  // this module exists to prevent.
  it('refuses a value it cannot represent instead of truncating it', () => {
    expect(() => formatSecrets([{ name: 'PEM_KEY', value: PEM }], 'docker')).toThrow(
      ExportFormatError,
    );
    expect(() => formatSecrets([{ name: 'A', value: 'a\rb' }], 'docker')).toThrow(/line break/);
  });

  it('names the secret but never its value in the error', () => {
    try {
      formatSecrets([{ name: 'STRIPE_KEY', value: 'sk_live_secret\nmore' }], 'docker');
      expect.unreachable('formatSecrets should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ExportFormatError);
      expect((error as ExportFormatError).secretName).toBe('STRIPE_KEY');
      expect((error as Error).message).toContain('STRIPE_KEY');
      expect((error as Error).message).not.toContain('sk_live_secret');
    }
  });
});

describe('formatSecrets', () => {
  it.each(['env', 'json', 'yaml', 'shell', 'docker'] as const)(
    'renders an empty list as an empty %s document',
    (format) => {
      const output = formatSecrets([], format);
      expect(output).toBe(format === 'json' ? '{}\n' : format === 'yaml' ? '{}\n' : '');
    },
  );

  // `A=B=value` would parse back as `A` holding `B=value`.
  it.each(['env', 'json', 'yaml', 'shell', 'docker'] as const)(
    'refuses a name that would not survive %s output',
    (format) => {
      expect(() => formatSecrets([{ name: 'A=B', value: 'x' }], format)).toThrow(ExportFormatError);
      expect(() => formatSecrets([{ name: '', value: 'x' }], format)).toThrow(ExportFormatError);
    },
  );
});
