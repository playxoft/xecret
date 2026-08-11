import { describe, expect, it } from 'vitest';
import { detectFormat } from './detect';
import { parseDotenv } from './dotenv';
import { flattenTree, parseJson } from './json';
import { buildImportPlan } from './plan';
import { parseShell } from './shell';
import { parseYaml } from './yaml';
import type { ParseResult } from './types';

/** The parsed entries as a plain record, for asserting values without line noise. */
function values(result: ParseResult): Record<string, string> {
  return Object.fromEntries(result.entries.map((entry) => [entry.key, entry.value]));
}

function messages(result: ParseResult): string {
  return result.warnings.map((warning) => warning.message).join('\n');
}

/**
 * A real key, shortened. What matters is the shape: a quoted value whose
 * newlines are part of the secret, spanning lines that each look like garbage
 * to a line-oriented parser.
 */
const PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAyLGqLTPGWvKmYQF9vB3nJZ0X1kQ7hRr2mN8sD4tW6uV0pC1e
9aXbYzR3kFqL5oN7wS2dH8jT4gM1vB6cP0rE3nK9xA7yU2iO5lQ8fD1zJ4hG6mV3
tR0sN9wX2kC5bY7pL1aQ4eZ8uH3jF6oI0dM7gT2nS5rB9vW1yK4xP8cE3lA6qU0i
-----END RSA PRIVATE KEY-----`;

describe('parseDotenv', () => {
  it('parses a Rails-style .env file', () => {
    const source = [
      '# Application',
      'RAILS_ENV=production',
      'SECRET_KEY_BASE=6f1a9c4e2b8d7a3f',
      'DATABASE_URL=postgres://app:pa55w0rd@db.internal:5432/app?sslmode=require',
      'RAILS_MAX_THREADS=5',
      '',
      '# Mailer',
      'SMTP_ADDRESS=smtp.sendgrid.net',
      'MAIL_FROM="Acme Support <support@acme.test>"',
      'FEATURE_FLAGS=',
      'export FORCE_SSL=true # set by the deploy script',
    ].join('\n');

    const result = parseDotenv(source);

    expect(result.warnings).toEqual([]);
    expect(values(result)).toEqual({
      RAILS_ENV: 'production',
      SECRET_KEY_BASE: '6f1a9c4e2b8d7a3f',
      DATABASE_URL: 'postgres://app:pa55w0rd@db.internal:5432/app?sslmode=require',
      RAILS_MAX_THREADS: '5',
      SMTP_ADDRESS: 'smtp.sendgrid.net',
      MAIL_FROM: 'Acme Support <support@acme.test>',
      FEATURE_FLAGS: '',
      FORCE_SSL: 'true',
    });
  });

  it('reports the line each entry came from', () => {
    const result = parseDotenv('# comment\nA=1\n\nB=2');
    expect(result.entries).toEqual([
      { key: 'A', value: '1', line: 2 },
      { key: 'B', value: '2', line: 4 },
    ]);
  });

  it.each([
    ['KEY=value', 'value'],
    ['KEY =value', 'value'],
    ['KEY= value', 'value'],
    ['KEY = value', 'value'],
    ['  KEY=value  ', 'value'],
    ['export KEY=value', 'value'],
    ['export  KEY = value', 'value'],
  ])('accepts the whitespace in %s', (line, expected) => {
    expect(values(parseDotenv(line))).toEqual({ KEY: expected });
  });

  it('does not mistake a key called export for the export prefix', () => {
    expect(values(parseDotenv('export=1\nexports=2'))).toEqual({ export: '1', exports: '2' });
  });

  // A `#` in a password is not a comment. Getting this wrong truncates the
  // secret at the hash and the failure only shows up at the far end.
  it('keeps a # that is not preceded by whitespace', () => {
    expect(values(parseDotenv('SMTP_PASSWORD=SG.abc#123'))).toEqual({
      SMTP_PASSWORD: 'SG.abc#123',
    });
  });

  it('strips a comment that follows whitespace', () => {
    expect(values(parseDotenv('KEY=value # trailing'))).toEqual({ KEY: 'value' });
  });

  it('treats a value that is only a comment as empty, but a leading # as a value', () => {
    expect(values(parseDotenv('A= # unset for now\nB=#literal'))).toEqual({ A: '', B: '#literal' });
  });

  it('treats a bare KEY= as an empty value rather than an error', () => {
    const result = parseDotenv('EMPTY=');
    expect(result.warnings).toEqual([]);
    expect(result.entries).toEqual([{ key: 'EMPTY', value: '', line: 1 }]);
  });

  it('processes escapes inside double quotes', () => {
    const result = parseDotenv(String.raw`A="one\ntwo\ttab\\slash\"quote"`);
    expect(values(result)).toEqual({ A: 'one\ntwo\ttab\\slash"quote' });
  });

  // Dropping the backslash on an unrecognised escape — the other plausible rule
  // — silently corrupts every Windows path and every regex.
  it('keeps the backslash on an escape it does not recognise', () => {
    expect(values(parseDotenv(String.raw`A="C:\Users\deploy" `))).toEqual({
      A: String.raw`C:\Users\deploy`,
    });
  });

  it('treats single quotes as fully literal', () => {
    const result = parseDotenv(String.raw`A='no \n escape, no ${'$'}{INTERPOLATION}, keeps \\'`);
    expect(values(result)).toEqual({
      A: String.raw`no \n escape, no ${'$'}{INTERPOLATION}, keeps \\`,
    });
  });

  it('reads a multi-line PEM key as a single value', () => {
    const result = parseDotenv(`JWT_PRIVATE_KEY="${PEM}"\nNEXT_KEY=still-parsed`);

    expect(result.warnings).toEqual([]);
    expect(values(result)).toEqual({ JWT_PRIVATE_KEY: PEM, NEXT_KEY: 'still-parsed' });
    // The line number is where the key was declared, not where the value ended.
    expect(result.entries[0]?.line).toBe(1);
  });

  it('reads a multi-line value in single quotes', () => {
    expect(values(parseDotenv("A='one\ntwo'\nB=2"))).toEqual({ A: 'one\ntwo', B: '2' });
  });

  it('handles CRLF line endings and a UTF-8 BOM', () => {
    const result = parseDotenv('\uFEFFA=1\r\nB="two words"\r\n# comment\r\nC=3\r\n');

    expect(result.warnings).toEqual([]);
    expect(values(result)).toEqual({ A: '1', B: 'two words', C: '3' });
    expect(Object.keys(values(result))[0]).toBe('A');
  });

  it('strips the carriage returns inside a multi-line value written on Windows', () => {
    const result = parseDotenv('KEY="line1\r\nline2"\r\n');
    expect(values(result)).toEqual({ KEY: 'line1\nline2' });
  });

  it('lets the last of a duplicated key win, and names both lines', () => {
    const result = parseDotenv('API_KEY=first\nOTHER=x\nAPI_KEY=second');

    expect(values(result)).toEqual({ API_KEY: 'second', OTHER: 'x' });
    expect(result.warnings).toEqual([
      {
        line: 3,
        message:
          '"API_KEY" is defined more than once. The value on line 3 replaces the one on line 1.',
      },
    ]);
    // First-seen ordering survives, so the preview does not reshuffle.
    expect(result.entries.map((entry) => entry.key)).toEqual(['API_KEY', 'OTHER']);
  });

  it('warns about a line with no = and keeps parsing', () => {
    const result = parseDotenv('A=1\nthis is not an assignment\nB=2');

    expect(values(result)).toEqual({ A: '1', B: '2' });
    expect(result.warnings).toEqual([{ line: 2, message: 'Line 2 is not KEY=value; skipped.' }]);
  });

  it('warns about an assignment with no key', () => {
    const result = parseDotenv('=orphaned');
    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([{ line: 1, message: 'Line 1 has no key; skipped.' }]);
  });

  // Warnings are rendered in the UI and pasted into bug reports, so a message
  // may name a key but never a value.
  it('never quotes file content back in a warning', () => {
    const result = parseDotenv('this line is not an assignment\nA="x" leftover');
    expect(messages(result)).not.toContain('leftover');
    expect(messages(result)).not.toContain('not an assignment');
  });

  it('does not interpolate variable references', () => {
    const result = parseDotenv('A=secret\nB=${A}\nC="$A"\nD=$A');

    expect(values(result)).toEqual({ A: 'secret', B: '${A}', C: '$A', D: '$A' });
  });

  // A stray quote must not swallow the rest of the file into one value.
  it('contains an unterminated quote to its own line', () => {
    const result = parseDotenv('PASSWORD="oops\nAPI_KEY=still-imported\nOTHER=also-imported');

    expect(values(result)).toEqual({
      PASSWORD: 'oops',
      API_KEY: 'still-imported',
      OTHER: 'also-imported',
    });
    expect(result.warnings).toEqual([
      {
        line: 1,
        message:
          'The quote opened on line 1 is never closed. The rest of that line was used as the value.',
      },
    ]);
  });

  it('warns about unexpected text after a closing quote', () => {
    const result = parseDotenv('A="value" and then some');

    expect(values(result)).toEqual({ A: 'value' });
    expect(result.warnings).toEqual([
      { line: 1, message: 'Ignored unexpected text after the closing quote on line 1.' },
    ]);
  });

  it('accepts a comment after a closing quote', () => {
    const result = parseDotenv('A="value" # explains the value');
    expect(result.warnings).toEqual([]);
    expect(values(result)).toEqual({ A: 'value' });
  });

  it.each([
    ['an empty file', ''],
    ['only comments', '# one\n# two\n'],
    ['only blank lines', '\n\n   \n'],
  ])('returns nothing for %s', (_label, source) => {
    expect(parseDotenv(source)).toEqual({ entries: [], warnings: [] });
  });
});

/**
 * The input is a file a stranger dropped into a browser. An exception here is a
 * failed import with a stack trace instead of a message, thrown from a request
 * that is holding plaintext secrets.
 */
const ADVERSARIAL = [
  '',
  '=',
  '==',
  '"',
  "'",
  '\\',
  'A="',
  "A='",
  'A=\\',
  'A="\\',
  '#',
  'export',
  'export =',
  'export A',
  '\u0000\u0000\u0000',
  '\uFEFF',
  '\r\r\r',
  'A=B=C=D',
  '🔐=🔑',
  'A=${B}',
  '{"a":',
  'a: [1, 2',
  '- - -',
  'A='.repeat(2000),
  '"'.repeat(2000),
  `A="${'x'.repeat(20000)}`,
  '{'.repeat(500),
  '[]'.repeat(500),
];

describe.each([
  ['parseDotenv', parseDotenv],
  ['parseShell', parseShell],
  ['parseJson', parseJson],
  ['parseYaml', parseYaml],
])('%s on arbitrary input', (_name, parse) => {
  it.each(ADVERSARIAL)('never throws on %j', (source) => {
    const result = parse(source);
    expect(Array.isArray(result.entries)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

describe('parseShell', () => {
  it('parses an export -p style dump', () => {
    const source = [
      '# generated by `xecret pull --format shell`',
      "export DATABASE_URL='postgres://app:pa55w0rd@db.internal:5432/app'",
      "export STRIPE_KEY='sk_live_abc123'",
      "export EMPTY=''",
      'export UNQUOTED=plain',
    ].join('\n');

    const result = parseShell(source);

    expect(result.warnings).toEqual([]);
    expect(values(result)).toEqual({
      DATABASE_URL: 'postgres://app:pa55w0rd@db.internal:5432/app',
      STRIPE_KEY: 'sk_live_abc123',
      EMPTY: '',
      UNQUOTED: 'plain',
    });
  });

  // How every shell — and this repository's own exporter — writes an embedded
  // apostrophe. `.env` has no concatenation and cannot express it at all.
  it("reads the '\\'' idiom as a single word", () => {
    expect(values(parseShell(String.raw`export PASSWORD='it'\''s a secret'`))).toEqual({
      PASSWORD: "it's a secret",
    });
  });

  it('concatenates adjacent quoted and unquoted segments', () => {
    expect(values(parseShell(`export A='one'"two"three`))).toEqual({ A: 'onetwothree' });
  });

  // POSIX gives backslash meaning before exactly four characters inside double
  // quotes. `\n` is not one of them, and treating it as a newline here would
  // rewrite a value a machine produced.
  it('does not process \\n inside double quotes, unlike .env', () => {
    expect(values(parseShell(String.raw`export A="one\ntwo"`))).toEqual({
      A: String.raw`one\ntwo`,
    });
    expect(values(parseDotenv(String.raw`A="one\ntwo"`))).toEqual({ A: 'one\ntwo' });
  });

  it.each([
    [String.raw`export A="a\$b"`, 'a$b'],
    [String.raw`export A="a\"b"`, 'a"b'],
    [String.raw`export A="a\\b"`, String.raw`a\b`],
    ['export A="a\\`b"', 'a`b'],
    [String.raw`export A=a\ b`, 'a b'],
  ])('applies the POSIX escapes in %s', (line, expected) => {
    expect(values(parseShell(line))).toEqual({ A: expected });
  });

  it('reads a multi-line single-quoted value', () => {
    const result = parseShell(`export KEY='${PEM}'\nexport NEXT=after`);
    expect(result.warnings).toEqual([]);
    expect(values(result)).toEqual({ KEY: PEM, NEXT: 'after' });
  });

  it('keeps a # that is not preceded by whitespace and strips one that is', () => {
    expect(values(parseShell('export A=abc#123 # a comment'))).toEqual({ A: 'abc#123' });
  });

  it('warns about unexpected text after the value', () => {
    const result = parseShell('export A=value trailing');
    expect(values(result)).toEqual({ A: 'value' });
    expect(result.warnings).toEqual([
      { line: 1, message: 'Ignored unexpected text after the value on line 1.' },
    ]);
  });

  it('contains an unterminated quote to its own line', () => {
    const result = parseShell("export A='oops\nexport B=imported");

    expect(values(result)).toEqual({ A: 'oops', B: 'imported' });
    expect(result.warnings[0]?.line).toBe(1);
  });

  it('applies the same last-wins rule as .env, with a warning', () => {
    const result = parseShell('export A=first\nexport A=second');
    expect(values(result)).toEqual({ A: 'second' });
    expect(result.warnings).toHaveLength(1);
  });

  it('warns about lines that are not assignments', () => {
    const result = parseShell('#!/bin/sh\nset -euo pipefail\nexport A=1\n=nokey');

    expect(values(result)).toEqual({ A: '1' });
    expect(result.warnings.map((warning) => warning.line)).toEqual([2, 4]);
  });
});

describe('parseJson', () => {
  it('parses a flat object', () => {
    expect(values(parseJson('{"API_KEY": "abc", "PORT": "3000"}'))).toEqual({
      API_KEY: 'abc',
      PORT: '3000',
    });
  });

  it('flattens nested objects with an underscore', () => {
    const source = JSON.stringify({
      database: { url: 'postgres://localhost/app', pool: { size: 20 } },
      stripe: { secretKey: 'sk_live_abc' },
      NODE_ENV: 'production',
    });

    expect(values(parseJson(source))).toEqual({
      database_url: 'postgres://localhost/app',
      database_pool_size: '20',
      stripe_secretKey: 'sk_live_abc',
      NODE_ENV: 'production',
    });
  });

  // There is no such thing as a numeric environment variable, so the choice is
  // between coercing and rejecting most real config files.
  it('coerces non-string scalars to their text form', () => {
    const result = parseJson('{"port": 5432, "debug": false, "ratio": 1.5, "absent": null}');

    expect(result.warnings).toEqual([]);
    expect(values(result)).toEqual({ port: '5432', debug: 'false', ratio: '1.5', absent: '' });
  });

  it('warns when a number is too large to have survived parsing exactly', () => {
    const result = parseJson('{"account": 900719925474099123}');

    expect(values(result)).toEqual({ account: '900719925474099100' });
    expect(messages(result)).toContain('too large to represent exactly');
  });

  // JSON-stringifying the array would produce a secret nothing on the consuming
  // side will ever parse back.
  it('rejects arrays instead of stringifying them', () => {
    const result = parseJson('{"hosts": ["a", "b"], "KEEP": "me"}');

    expect(values(result)).toEqual({ KEEP: 'me' });
    expect(messages(result)).toContain('"hosts" is a list');
  });

  it('warns about a nested array by its full path', () => {
    expect(messages(parseJson('{"a": {"b": [1]}}'))).toContain('"a_b" is a list');
  });

  it('reports invalid JSON as a warning rather than throwing', () => {
    const result = parseJson('{"a": "b",}');
    expect(result.entries).toEqual([]);
    expect(messages(result)).toContain('not valid JSON');
  });

  it.each([
    ['a top-level array', '[1, 2, 3]', 'the top level must be an object'],
    ['a top-level string', '"just a string"', 'does not contain key/value pairs'],
    ['a top-level number', '42', 'does not contain key/value pairs'],
    ['null', 'null', 'does not contain key/value pairs'],
  ])('rejects %s', (_label, source, expected) => {
    const result = parseJson(source);
    expect(result.entries).toEqual([]);
    expect(messages(result)).toContain(expected);
  });

  it('reports an empty document', () => {
    expect(messages(parseJson('{}'))).toContain('no key/value pairs');
  });

  it('skips an empty nested object rather than dropping it silently', () => {
    expect(messages(parseJson('{"a": {}, "B": "1"}'))).toContain('"a" is empty');
  });

  it('stops at a nesting depth no config file reaches', () => {
    let source = '"deep"';
    for (let depth = 0; depth < 40; depth += 1) source = `{"a": ${source}}`;

    const result = parseJson(source);
    expect(result.entries).toEqual([]);
    expect(messages(result)).toContain('nested more than 16 levels deep');
  });

  it('reports a value with no textual meaning instead of guessing at one', () => {
    // Not reachable through JSON.parse; reachable through the YAML path and
    // through any future caller of the shared flattener.
    const result = flattenTree({ a: undefined, B: 'kept' });

    expect(values(result)).toEqual({ B: 'kept' });
    expect(messages(result)).toContain('cannot be stored as a secret');
  });
});

describe('parseYaml', () => {
  it('parses a nested config file', () => {
    const source = [
      '# deployment config',
      'database:',
      '  url: postgres://app@db/app',
      '  pool: 20',
      'stripe:',
      '  secret_key: sk_live_abc',
      'debug: false',
      'empty_value:',
    ].join('\n');

    const result = parseYaml(source);

    expect(result.warnings).toEqual([]);
    expect(values(result)).toEqual({
      database_url: 'postgres://app@db/app',
      database_pool: '20',
      stripe_secret_key: 'sk_live_abc',
      debug: 'false',
      empty_value: '',
    });
  });

  it('resolves anchors and merge keys', () => {
    const source = [
      'defaults: &defaults',
      '  host: db.internal',
      '  port: 5432',
      'production:',
      '  <<: *defaults',
      '  password: pa55w0rd',
    ].join('\n');

    expect(values(parseYaml(source))).toEqual({
      defaults_host: 'db.internal',
      defaults_port: '5432',
      production_host: 'db.internal',
      production_port: '5432',
      production_password: 'pa55w0rd',
    });
  });

  // Under YAML 1.1 — still the default in much tooling — `NO` is boolean false.
  it('does not turn the country code NO into a boolean', () => {
    expect(values(parseYaml('region: NO\nenabled: yes'))).toEqual({
      region: 'NO',
      enabled: 'yes',
    });
  });

  it('preserves a quoted numeric string exactly', () => {
    expect(values(parseYaml('pin: "0123"\nversion: 1.10'))).toEqual({
      pin: '0123',
      version: '1.1',
    });
  });

  // `.env` has a universal convention for duplicates; YAML has none, so picking
  // one of two passwords would be a guess.
  it('rejects a document with duplicate keys, naming the line', () => {
    const result = parseYaml('a: first\nb: x\na: second');

    expect(result.entries).toEqual([]);
    expect(result.warnings[0]?.line).toBe(3);
    expect(messages(result)).toContain('unique');
  });

  it('reports a syntax error as a warning with its line', () => {
    const result = parseYaml('a: 1\n\tb: 2');

    expect(result.entries).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]?.line).toBe(2);
  });

  // The tag must resolve to inert data, never construct anything.
  it('does not act on a custom tag', () => {
    const result = parseYaml('a: !!python/object:os.system "rm -rf /"');

    expect(values(result)).toEqual({ a: 'rm -rf /' });
    expect(messages(result)).toContain('Unresolved tag');
  });

  it('refuses to expand an alias bomb', () => {
    const source = [
      'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
    ].join('\n');

    const result = parseYaml(source);

    expect(result.entries).toEqual([]);
    expect(messages(result)).toContain('not valid YAML');
  });

  it('imports the first of several documents and says so', () => {
    const result = parseYaml('a: 1\n---\nb: 2\n');

    expect(values(result)).toEqual({ a: '1' });
    expect(messages(result)).toContain('Only the first was imported');
  });

  it.each(
    [
      ['', '   \n\n'],
      ['\uFEFF\n', '# only a comment\n'],
    ].flat(),
  )('treats %j as an empty file rather than a broken one', (source) => {
    const result = parseYaml(source);
    expect(result.entries).toEqual([]);
    expect(result.warnings.every((warning) => !warning.message.includes('not valid'))).toBe(true);
  });

  it('applies the same flattening and coercion as JSON', () => {
    const yaml = parseYaml('database:\n  url: x\n  pool: 20\nflag: true\n');
    const json = parseJson('{"database": {"url": "x", "pool": 20}, "flag": true}');

    expect(values(yaml)).toEqual(values(json));
  });
});

describe('detectFormat', () => {
  it.each([
    ['.env', 'dotenv'],
    ['.env.local', 'dotenv'],
    ['.env.production.local', 'dotenv'],
    ['production.env', 'dotenv'],
    ['env.example', 'dotenv'],
    ['/home/dev/app/.env', 'dotenv'],
    ['app\\config\\.env', 'dotenv'],
    ['config.json', 'json'],
    ['secrets.JSON', 'json'],
    ['values.yaml', 'yaml'],
    ['docker-compose.yml', 'yaml'],
    ['deploy.sh', 'shell'],
    ['.envrc', 'shell'],
  ])('identifies %s by name', (filename, expected) => {
    const detection = detectFormat(filename, 'A=1');
    expect(detection.format).toBe(expected);
    expect(detection.confidence).toBe('high');
  });

  it.each([
    ['{"a": "b"}', 'json'],
    ['\n\n  [1, 2]', 'json'],
    ['# comment\nexport A=1\n', 'shell'],
    ['database:\n  url: x\n', 'yaml'],
    ['key:\n', 'yaml'],
    ['A=1\nB=2\n', 'dotenv'],
  ])('sniffs %j as %s when the name says nothing', (content, expected) => {
    const detection = detectFormat('secrets.txt', content);
    expect(detection.format).toBe(expected);
    expect(detection.confidence).toBe('medium');
  });

  it('prefers the filename over the content', () => {
    expect(detectFormat('config.yaml', '{"a": "b"}').format).toBe('yaml');
  });

  it('falls back to .env with low confidence when nothing identifies the file', () => {
    expect(detectFormat('mystery', 'just some prose\nwith no structure')).toMatchObject({
      format: 'dotenv',
      confidence: 'low',
    });
  });

  it('reports an empty file with low confidence', () => {
    const detection = detectFormat('mystery', '# only a comment\n\n');
    expect(detection).toMatchObject({ format: 'dotenv', confidence: 'low' });
    expect(detection.reason).toContain('empty');
  });
});

/** Builds a ParseResult without going through a parser. */
function parsed(entries: ReadonlyArray<readonly [string, string]>): ParseResult {
  return {
    entries: entries.map(([key, value], index) => ({ key, value, line: index + 1 })),
    warnings: [],
  };
}

describe('buildImportPlan', () => {
  it('counts what an import will do', () => {
    const plan = buildImportPlan({
      parsed: parsed([
        ['NEW_ONE', '1'],
        ['NEW_TWO', '2'],
        ['EXISTING', '3'],
      ]),
      existingNames: ['EXISTING'],
      strategy: 'overwrite',
    });

    expect(plan.counts).toEqual({ create: 2, overwrite: 1, skip: 0, rename: 0, invalid: 0 });
    expect(plan.items.map((item) => item.status)).toEqual(['create', 'create', 'overwrite']);
  });

  it('carries the parse warnings into the plan', () => {
    const source: ParseResult = {
      entries: [{ key: 'A', value: '1', line: 1 }],
      warnings: [{ line: 2, message: 'something' }],
    };

    expect(
      buildImportPlan({ parsed: source, existingNames: [], strategy: 'skip' }).warnings,
    ).toEqual([{ line: 2, message: 'something' }]);
  });

  it('normalises source keys and says what it changed them to', () => {
    const plan = buildImportPlan({
      parsed: parsed([
        ['database.url', 'postgres://x'],
        ['my-api-key', 'abc'],
        ['stripe_secretKey', 'sk'],
      ]),
      existingNames: [],
      strategy: 'skip',
    });

    expect(plan.items.map((item) => item.targetName)).toEqual([
      'DATABASE_URL',
      'MY_API_KEY',
      'STRIPE_SECRET_KEY',
    ]);
    expect(plan.items[0]?.note).toContain('normalised');
  });

  it('adds no note when the name was already what it will be stored as', () => {
    const plan = buildImportPlan({
      parsed: parsed([['DATABASE_URL', 'x']]),
      existingNames: [],
      strategy: 'skip',
    });

    expect(plan.items[0]).toEqual({
      sourceKey: 'DATABASE_URL',
      targetName: 'DATABASE_URL',
      value: 'x',
      status: 'create',
      note: undefined,
    });
  });

  it('reports a key it cannot turn into a name instead of dropping it', () => {
    const plan = buildImportPlan({
      parsed: parsed([['!!!', 'orphan-value']]),
      existingNames: [],
      strategy: 'skip',
    });

    expect(plan.items[0]).toMatchObject({ status: 'invalid', sourceKey: '!!!', targetName: '' });
    expect(plan.items[0]?.note).toContain('cannot become a secret name');
    // The value survives so the user can fix the name without re-uploading.
    expect(plan.items[0]?.value).toBe('orphan-value');
  });

  it('reports a name that is too long', () => {
    const plan = buildImportPlan({
      parsed: parsed([['A'.repeat(300), 'x']]),
      existingNames: [],
      strategy: 'skip',
    });

    expect(plan.items[0]?.status).toBe('invalid');
    expect(plan.items[0]?.note).toContain('256');
  });

  // Injecting one of these would turn running a command with these secrets into
  // arbitrary code execution.
  it.each(['PATH', 'ld_preload', 'DYLD_INSERT_LIBRARIES', 'home'])(
    'refuses to import %s and explains why',
    (key) => {
      const plan = buildImportPlan({
        parsed: parsed([[key, '/tmp/evil.so']]),
        existingNames: [],
        strategy: 'overwrite',
      });

      expect(plan.items[0]?.status).toBe('invalid');
      expect(plan.items[0]?.note).toContain('reserved by the operating system');
      expect(plan.items[0]?.note).toContain('executables and libraries');
    },
  );

  it.each([
    ['skip', 'skip'],
    ['overwrite', 'overwrite'],
  ] as const)('applies the %s strategy to an existing name', (strategy, expected) => {
    const plan = buildImportPlan({
      parsed: parsed([['API_KEY', 'new-value']]),
      existingNames: ['API_KEY'],
      strategy,
    });

    expect(plan.items[0]?.status).toBe(expected);
    expect(plan.items[0]?.note).toContain('already exists');
  });

  it('renames around an existing name', () => {
    const plan = buildImportPlan({
      parsed: parsed([['API_KEY', 'v']]),
      existingNames: ['API_KEY', 'API_KEY_2'],
      strategy: 'rename',
    });

    expect(plan.items[0]).toMatchObject({ status: 'rename', targetName: 'API_KEY_3' });
  });

  it('renames around names claimed earlier in the same plan, not just existing ones', () => {
    const plan = buildImportPlan({
      parsed: parsed([
        ['API_KEY', 'a'],
        ['api-key', 'b'],
        ['api.key', 'c'],
      ]),
      existingNames: [],
      strategy: 'rename',
    });

    expect(plan.items.map((item) => item.targetName)).toEqual([
      'API_KEY',
      'API_KEY_2',
      'API_KEY_3',
    ]);
    expect(plan.counts).toEqual({ create: 1, overwrite: 0, skip: 0, rename: 2, invalid: 0 });
  });

  // Two keys collapsing into one secret means one of the two values is stored
  // under a name the user believes holds the other.
  it.each(['skip', 'overwrite'] as const)(
    'reports two keys that normalise to one name under the %s strategy',
    (strategy) => {
      const plan = buildImportPlan({
        parsed: parsed([
          ['my-api-key', 'first'],
          ['MY_API_KEY', 'second'],
        ]),
        existingNames: [],
        strategy,
      });

      expect(plan.items[0]).toMatchObject({ status: 'create', value: 'first' });
      expect(plan.items[1]).toMatchObject({ status: 'skip', value: 'second' });
      expect(plan.items[1]?.note).toContain('Another key in this file');
    },
  );

  it('reports a rename it cannot fit inside the name length limit', () => {
    const name = 'A'.repeat(256);
    const plan = buildImportPlan({
      parsed: parsed([[name, 'x']]),
      existingNames: [name],
      strategy: 'rename',
    });

    expect(plan.items[0]?.status).toBe('invalid');
    expect(plan.items[0]?.note).toContain('exceed the 256 character limit');
  });

  it('gives up on renaming rather than spinning when every variant is taken', () => {
    const taken = ['A', ...Array.from({ length: 998 }, (_unused, index) => `A_${index + 2}`)];

    const plan = buildImportPlan({
      parsed: parsed([['A', 'x']]),
      existingNames: taken,
      strategy: 'rename',
    });

    expect(plan.items[0]?.status).toBe('invalid');
    expect(plan.items[0]?.note).toContain('numbered variants are all taken');
  });

  // The dry run and the real import call this function with the same inputs, so
  // a preview that disagreed with the write would be a correctness bug, not a
  // cosmetic one.
  it('is pure: same inputs give the same plan, and the inputs are untouched', () => {
    const source = parsed([
      ['a-key', '1'],
      ['EXISTING', '2'],
      ['!!!', '3'],
    ]);
    const existingNames = ['EXISTING'];
    const snapshot = structuredClone({ source, existingNames });

    const first = buildImportPlan({ parsed: source, existingNames, strategy: 'rename' });
    const second = buildImportPlan({ parsed: source, existingNames, strategy: 'rename' });

    expect(first).toEqual(second);
    expect({ source, existingNames }).toEqual(snapshot);
  });

  it('leaves no way to log an item without its value being visible', () => {
    const plan = buildImportPlan({
      parsed: parsed([['API_KEY', 'sk_live_do_not_log']]),
      existingNames: [],
      strategy: 'skip',
    });

    // A redacting toJSON would make JSON.stringify(plan) look safe while the
    // value stayed one property access away. There is deliberately none, so the
    // danger is visible at every call site.
    expect(JSON.stringify(plan)).toContain('sk_live_do_not_log');
  });

  it('plans a whole .env file end to end', () => {
    const source = parseDotenv(
      [
        'DATABASE_URL=postgres://app@db/app',
        'stripe.secret_key=sk_live_abc',
        'API_KEY=rotated',
        'PATH=/usr/local/bin',
        'API_KEY=rotated-again',
      ].join('\n'),
    );

    const plan = buildImportPlan({
      parsed: source,
      existingNames: ['API_KEY'],
      strategy: 'overwrite',
    });

    expect(plan.counts).toEqual({ create: 2, overwrite: 1, skip: 0, rename: 0, invalid: 1 });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.items.map((item) => item.targetName)).toEqual([
      'DATABASE_URL',
      'STRIPE_SECRET_KEY',
      'API_KEY',
      '',
    ]);
  });
});
