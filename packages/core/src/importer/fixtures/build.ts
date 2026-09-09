import { parseDotenv } from '../dotenv';
import { parseJson } from '../json';
import { parseShell } from '../shell';
import { parseYaml } from '../yaml';
import { buildImportPlan } from '../plan';
import type { ConflictStrategy, ImportFormat, ParseResult } from '../types';

/**
 * Cross-implementation fixtures for the import parsers.
 *
 * These are to `importer/` what `crypto/client/vectors/` is to the crypto: a
 * file that two independent implementations read, so that "the CLI and the
 * browser parse a `.env` the same way" is a test rather than an aspiration.
 *
 * The second implementation is `cli/internal/importer`, which exists because an
 * end-to-end encrypted environment cannot upload a plaintext file to be parsed
 * server-side. Two parsers for one format is a liability; the only thing that
 * makes it a manageable one is this file.
 *
 * ── Nothing here is a hand-written expectation ──
 *
 * Every `expected` block is whatever the TypeScript parsers actually produce.
 * `build.ts` is pure — it reads no clock, touches no disk — so the suite in this
 * directory can check the committed file back against the implementation, and
 * the Go suite can check itself against the same bytes. A hand-written
 * expectation would encode a guess and then validate the guess.
 *
 * ── The two null escape hatches ──
 *
 * A warning whose text comes from a parsing library — a JSON syntax error, a
 * YAML document error — cannot match across two languages, and pretending it
 * could would either freeze a dependency's wording into a contract or force one
 * implementation to fake the other's prose. Those warnings carry a null
 * `message`, meaning: *a warning must be reported at this line, and its wording
 * is the implementation's own*.
 *
 * A YAML **syntax** error additionally carries a null `line`, because the two
 * libraries disagree about where a broken flow sequence went wrong — `yaml`
 * reports where the problem was detected, `gopkg.in/yaml.v3` where the construct
 * opened — and neither is wrong. That is the only case; every other position in
 * this file is one both implementations compute themselves and must agree on.
 *
 * Everything else is compared verbatim, because every other message and every
 * other line number is written in this repository.
 */

export interface FixtureWarning {
  /**
   * Null when the *position* belongs to a parsing library rather than to us.
   *
   * A YAML syntax error is the only case: `yaml` reports the line it detected
   * the problem on and `gopkg.in/yaml.v3` reports the line the construct opened
   * on, and neither is wrong. Freezing one of them into a contract would mean
   * one implementation faking the other's idea of where a broken flow sequence
   * went wrong, which teaches nobody anything.
   */
  line: number | null;
  /** Null when the wording belongs to a parsing library rather than to us. */
  message: string | null;
}

export interface FixturePlan {
  strategy: ConflictStrategy;
  existingNames: string[];
  items: Array<{
    sourceKey: string;
    targetName: string;
    status: string;
    note: string | null;
  }>;
}

export interface Fixture {
  id: string;
  format: ImportFormat;
  description: string;
  source: string;
  expected: {
    entries: Array<{ key: string; value: string; line: number }>;
    warnings: FixtureWarning[];
  };
  plan?: FixturePlan;
}

export interface FixtureFile {
  generatedAt: string;
  generator: string;
  cases: Fixture[];
}

const PARSERS: Record<ImportFormat, (content: string) => ParseResult> = {
  dotenv: parseDotenv,
  json: parseJson,
  yaml: parseYaml,
  shell: parseShell,
};

/**
 * Ids whose warning *wording* comes from a library. Recorded here rather than
 * sniffed from the message, so adding one is a deliberate act with a reason
 * beside it.
 */
const LIBRARY_WORDED = new Set(['json/malformed', 'yaml/malformed', 'yaml/duplicate-key']);

/**
 * Ids whose warning *position* comes from a library too.
 *
 * Only YAML syntax errors. Every other line number in this file is one both
 * implementations compute themselves and must agree on — including the line a
 * duplicate YAML key sits on, which is a diagnosis rather than a parser
 * artefact.
 */
const LIBRARY_POSITIONED = new Set(['yaml/malformed']);

interface CaseInput {
  id: string;
  format: ImportFormat;
  description: string;
  source: string;
  plan?: { strategy: ConflictStrategy; existingNames: string[] };
}

function buildCase(input: CaseInput): Fixture {
  const parsed = PARSERS[input.format](input.source);
  const libraryWorded = LIBRARY_WORDED.has(input.id);
  const libraryPositioned = LIBRARY_POSITIONED.has(input.id);

  const fixture: Fixture = {
    id: input.id,
    format: input.format,
    description: input.description,
    source: input.source,
    expected: {
      entries: parsed.entries.map((entry) => ({
        key: entry.key,
        value: entry.value,
        line: entry.line,
      })),
      warnings: parsed.warnings.map((warning) => ({
        line: libraryPositioned ? null : warning.line,
        message: libraryWorded ? null : warning.message,
      })),
    },
  };

  if (input.plan !== undefined) {
    const plan = buildImportPlan({
      parsed,
      existingNames: input.plan.existingNames,
      strategy: input.plan.strategy,
    });
    fixture.plan = {
      strategy: input.plan.strategy,
      existingNames: input.plan.existingNames,
      items: plan.items.map((item) => ({
        sourceKey: item.sourceKey,
        targetName: item.targetName,
        status: item.status,
        note: item.note ?? null,
      })),
    };
  }

  return fixture;
}

/**
 * The cases, and what each one is here to pin.
 *
 * Chosen the way the crypto vectors' coverage list was: boundaries, non-ASCII,
 * and the specific constructs where two readings of an unspecified format
 * plausibly diverge. A `.env` file has no specification, so every rule below is
 * a decision somebody could reasonably have made differently.
 */
const CASES: CaseInput[] = [
  {
    id: 'dotenv/plain',
    format: 'dotenv',
    description: 'Unquoted values, blank lines, and a whole-line comment.',
    source: '# a comment\nAPI_URL=https://example.com\n\nPORT=5432\n',
  },
  {
    id: 'dotenv/inline-comment',
    format: 'dotenv',
    description:
      'A `#` only starts a comment when whitespace precedes it, which is the difference between a password containing a hash and a two-character one.',
    source: 'PASSWORD=abc#123\nTOKEN=xyz # the real comment\nEMPTY= # unset for now\n',
  },
  {
    id: 'dotenv/quoting',
    format: 'dotenv',
    description: 'Single quotes are literal; double quotes carry the five escapes.',
    source:
      'LITERAL=\'a\\nb $HOME\'\nESCAPED="line1\\nline2\\ttabbed"\nWINDOWS="C:\\Users\\deploy"\nSPACED=  "  padded  "\n',
  },
  {
    id: 'dotenv/multiline',
    format: 'dotenv',
    description: 'A pasted PEM key: the case the whole scanner exists for.',
    source:
      'KEY="-----BEGIN KEY-----\nline one\nline two\n-----END KEY-----"\nAFTER=still-parsed\n',
  },
  {
    id: 'dotenv/export-prefix',
    format: 'dotenv',
    description: '`export ` is accepted, and a key literally called `export` still parses.',
    source: 'export A=1\nexport=2\nexports=3\n',
  },
  {
    id: 'dotenv/duplicates',
    format: 'dotenv',
    description: 'Last wins, in first-seen order, and loudly.',
    source: 'A=first\nB=only\nA=second\n',
  },
  {
    id: 'dotenv/malformed',
    format: 'dotenv',
    description: 'A line with no `=`, a line with no key, and an unterminated quote.',
    source: 'JUST_A_LINE\n=novalue\nOPEN="never closed\nAFTER=recovered\n',
  },
  {
    id: 'dotenv/crlf-and-bom',
    format: 'dotenv',
    description:
      'A BOM and CRLF endings are encoding artefacts, not data — including inside a quoted value.',
    source: '\uFEFFA=1\r\nB="two\r\nlines"\r\n',
  },
  {
    id: 'dotenv/non-ascii',
    format: 'dotenv',
    description: 'A value outside ASCII survives byte for byte.',
    source: 'GREETING="caf\u00e9 \u2615 \u79d8\u5bc6"\nNAME=Zo\u00eb\n',
  },
  {
    id: 'dotenv/trailing-text',
    format: 'dotenv',
    description: 'Text after a closing quote is ignored, with a warning; a comment is not.',
    source: 'A="one" leftover\nB="two" # fine\n',
  },
  {
    id: 'shell/concatenation',
    format: 'shell',
    description:
      "Adjacent segments concatenate: `'it'\\''s'` is how every shell emits an apostrophe.",
    source: "export A='it'\\''s'\nexport B='a'\"b\"c\n",
  },
  {
    id: 'shell/posix-escapes',
    format: 'shell',
    description:
      'POSIX gives `\\` meaning before exactly four characters — `"a\\nb"` is a literal backslash-n, unlike in .env.',
    source: 'export A="a\\nb"\nexport B="say \\"hi\\""\nexport C="cost \\$5"\nexport D=a\\ b\n',
  },
  {
    id: 'shell/trailing-comment',
    format: 'shell',
    description: 'A comment after the word is fine; anything else is reported.',
    source: "export A='x' # a note\nexport B='y' leftover\n",
  },
  {
    id: 'json/nested',
    format: 'json',
    description: 'A tree flattens to `key_subkey`, keeping source order.',
    source: '{"database":{"url":"postgres://x","pool":{"max":10}},"debug":true,"nothing":null}',
  },
  {
    id: 'json/unsupported',
    format: 'json',
    description: 'A list has no environment-variable equivalent; an empty object is skipped.',
    source: '{"hosts":["a","b"],"empty":{},"ok":"kept"}',
  },
  {
    id: 'json/not-an-object',
    format: 'json',
    description: 'The top level must be an object.',
    source: '["a","b"]',
  },
  {
    id: 'json/malformed',
    format: 'json',
    description: 'Invalid JSON is one warning and no entries.',
    source: '{"a": }',
  },
  {
    id: 'yaml/scalars',
    format: 'yaml',
    description:
      'YAML 1.2 core schema: `NO` is the string it looks like, not boolean false; a bare key is empty, not "null".',
    source: 'region: NO\nenabled: true\nport: 5432\npassword:\nversion: "1.10"\ntime: 08:00\n',
  },
  {
    id: 'yaml/nested-and-merge',
    format: 'yaml',
    description: 'Merge keys resolve, and an explicit key wins over a merged one.',
    source:
      'defaults: &defaults\n  host: localhost\n  port: 5432\ndatabase:\n  <<: *defaults\n  port: 6543\n',
  },
  {
    id: 'yaml/duplicate-key',
    format: 'yaml',
    description:
      'A duplicate key is an error, not a last-wins situation: YAML defines no convention, so guessing would silently import the wrong password.',
    source: 'a: one\nb: two\na: three\n',
  },
  {
    id: 'yaml/malformed',
    format: 'yaml',
    description: 'Invalid YAML is one warning and no entries.',
    source: 'a: [1, 2\nb: 3\n',
  },
  {
    id: 'yaml/empty',
    format: 'yaml',
    description: 'A blank file is empty, not malformed.',
    source: '   \n\n',
  },
  {
    id: 'plan/normalisation',
    format: 'dotenv',
    description: 'Source keys become UPPER_SNAKE_CASE, and the change is reported.',
    source: 'database.url=a\nmy-api-key=b\nmyAPIKey=c\ns3Bucket=d\n_2fa=e\n',
    plan: { strategy: 'skip', existingNames: [] },
  },
  {
    id: 'plan/conflicts-skip',
    format: 'dotenv',
    description: 'An existing name is left alone under `skip`.',
    source: 'A=1\nB=2\n',
    plan: { strategy: 'skip', existingNames: ['A'] },
  },
  {
    id: 'plan/conflicts-overwrite',
    format: 'dotenv',
    description: 'The same file under `overwrite`.',
    source: 'A=1\nB=2\n',
    plan: { strategy: 'overwrite', existingNames: ['A'] },
  },
  {
    id: 'plan/conflicts-rename',
    format: 'dotenv',
    description: 'A rename picks the first free numbered variant.',
    source: 'A=1\n',
    plan: { strategy: 'rename', existingNames: ['A', 'A_2'] },
  },
  {
    id: 'plan/collision',
    format: 'dotenv',
    description: 'Two source keys that normalise to one name: first seen wins, loudly.',
    source: 'my-api-key=first\nMY_API_KEY=second\n',
    plan: { strategy: 'skip', existingNames: [] },
  },
  {
    id: 'plan/invalid',
    format: 'dotenv',
    description:
      'A reserved name and a key with nothing usable in it. `LD_PRELOAD` would turn `xecret run` into arbitrary code execution.',
    source: 'PATH=/usr/bin\nLD_PRELOAD=/tmp/evil.so\n---=nothing\n',
    plan: { strategy: 'skip', existingNames: [] },
  },
];

/** Builds the fixture file. Pure: no clock, no disk, no randomness. */
export function buildFixtureFile(metadata: {
  generatedAt: string;
  generator: string;
}): FixtureFile {
  return {
    generatedAt: metadata.generatedAt,
    generator: metadata.generator,
    cases: CASES.map(buildCase),
  };
}
