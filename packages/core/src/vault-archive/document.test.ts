import { beforeAll, describe, expect, it } from 'vitest';
import { ENVIRONMENT_SLUG_PATTERN, SLUG_MAX_LENGTH, SLUG_PATTERN } from '../validation/slug';
import {
  ARCHIVE_ENVIRONMENT_SLUG_PATTERN,
  ARCHIVE_SLUG_MAX_LENGTH,
  ARCHIVE_SLUG_PATTERN,
  isArchivableSecret,
  parseArchiveDocument,
  serializeArchiveDocument,
  toArchiveLabel,
  toArchiveSlug,
} from './document';
import type { VaultArchiveDocument } from './document';
import { planArchiveParts } from './build';
import { ArchiveFormatError } from './errors';
import { buildFixture } from './vectors/build';

/**
 * `archive.json` against spec §14.4: strict at every level, checked before any
 * key is derived, and errors that name a place rather than a value.
 */

let doc: VaultArchiveDocument;

beforeAll(async () => {
  const fixture = await buildFixture();
  [doc] = planArchiveParts(fixture.input, {
    archiveId: '0192f0a1-7c3d-7e4f-8a1b-000000000009',
    createdAt: new Date('2026-10-12T09:30:00.000Z'),
    retainedUntil: null,
  }) as [VaultArchiveDocument];
}, 30_000);

type Json = string | number | boolean | null | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json | undefined;
}

/**
 * The object at a dot path — `environments.0.secrets.0` — in a parsed copy of
 * the document. The edits below deliberately write values of the wrong type,
 * which is why they go through plain JSON rather than the document's own type.
 */
function at(root: JsonObject, path: string): JsonObject {
  let current: Json = root;
  for (const step of path.split('.')) {
    current = Array.isArray(current) ? current[Number(step)]! : (current as JsonObject)[step]!;
  }
  return current as JsonObject;
}

/** The document as plain JSON, edited, and parsed again. */
function parseEdited(edit: (raw: JsonObject) => void): VaultArchiveDocument {
  const raw = JSON.parse(serializeArchiveDocument(doc)) as JsonObject;
  edit(raw);
  return parseArchiveDocument(JSON.stringify(raw));
}

function refusal(edit: (raw: JsonObject) => void): string {
  try {
    parseEdited(edit);
  } catch (cause) {
    expect(cause).toBeInstanceOf(ArchiveFormatError);
    return (cause as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('serializeArchiveDocument', () => {
  it('round-trips through the parser', () => {
    expect(parseArchiveDocument(serializeArchiveDocument(doc))).toEqual(doc);
  });

  it('writes fields in the spec order whatever order they arrived in', () => {
    const shuffled = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    const reversed = Object.fromEntries(
      Object.entries(shuffled).reverse(),
    ) as unknown as VaultArchiveDocument;

    expect(serializeArchiveDocument(reversed)).toBe(serializeArchiveDocument(doc));
    expect(
      serializeArchiveDocument(doc).startsWith('{\n  "format": "xecret.vault-archive",\n'),
    ).toBe(true);
    expect(serializeArchiveDocument(doc).endsWith('}\n')).toBe(true);
  });

  it('is accepted however it is formatted', () => {
    expect(parseArchiveDocument(JSON.stringify(JSON.parse(serializeArchiveDocument(doc))))).toEqual(
      doc,
    );
  });
});

describe('parseArchiveDocument', () => {
  it('names the document, not a field, when it is something else entirely', () => {
    expect(() => parseArchiveDocument('not json')).toThrow(/not valid JSON/);
    expect(() => parseArchiveDocument('[]')).toThrow(/must hold a JSON object/);
    expect(() => parseArchiveDocument('{"format":"other"}')).toThrow(/not an xecret vault archive/);
  });

  it('names the version it found when it is a future one', () => {
    expect(refusal((raw) => (raw.formatVersion = 7))).toMatch(/version 7 vault archive/);
    expect(refusal((raw) => (raw.formatVersion = '1'))).toMatch(/must be an integer/);
  });

  const cases: [string, (raw: JsonObject) => void, RegExp][] = [
    ['an unknown top-level field', (raw) => (raw.extra = 1), /archive.json has a field/],
    ['a missing top-level field', (raw) => delete raw.archiveId, /archiveId is missing/],
    [
      'an unknown vault field',
      (raw) => (at(raw, 'vault').signPrivateKeyBlob = 'xk2.gcm.AAAA'),
      /vault has a field/,
    ],
    [
      'an unknown secret field',
      (raw) => (at(raw, 'environments.0.secrets.0').value = 'x'),
      /secrets\[0\] has a field/,
    ],
    [
      'a missing secret field',
      (raw) => delete at(raw, 'environments.0.secrets.0').noteBlob,
      /noteBlob is missing/,
    ],
    ['part above parts', (raw) => (raw.part = 2), /part must be an integer from 1 to 1/],
    ['too many parts', (raw) => (raw.parts = 65), /parts must be an integer/],
    ['another reason', (raw) => (raw.reason = 'export'), /reason must be/],
    ['an uppercase uuid', (raw) => (raw.archiveId = doc.archiveId.toUpperCase()), /lowercase UUID/],
    [
      'a timestamp without milliseconds',
      (raw) => (raw.createdAt = '2026-10-12T09:30:00Z'),
      /UTC timestamp/,
    ],
    ['an impossible date', (raw) => (raw.createdAt = '2026-02-30T09:30:00.000Z'), /UTC timestamp/],
    [
      'kdf params out of range',
      (raw) => (at(raw, 'vault.kdfParams').m = 1024),
      /kdfParams is not acceptable/,
    ],
    [
      'kdf params with an extra field',
      (raw) => (at(raw, 'vault.kdfParams').extra = 1),
      /kdfParams is not acceptable/,
    ],
    ['a short salt', (raw) => (at(raw, 'vault').kdfSaltB64Url = 'AAAA'), /exactly 16 bytes/],
    [
      'a salt that is not base64url',
      (raw) => (at(raw, 'vault').kdfSaltB64Url = '!!!!'),
      /unpadded base64url/,
    ],
    [
      'a public key of the wrong length',
      (raw) => (at(raw, 'vault').encPublicKeyB64Url = 'AAAA'),
      /exactly 32 bytes/,
    ],
    [
      'a wrap that is not a blob',
      (raw) => (at(raw, 'vault').passphraseWrapBlob = 'xk1.gcm.AAAA'),
      /not a well-formed xk2.gcm/,
    ],
    [
      'a recovery wrap with a bad hash',
      (raw) => (at(raw, 'vault.recoveryWraps.0').lookupHashHex = 'ABC'),
      /64 lowercase hex/,
    ],
    [
      'a repeated recovery hash',
      (raw) =>
        (at(raw, 'vault.recoveryWraps.1').lookupHashHex = at(
          raw,
          'vault.recoveryWraps.0',
        ).lookupHashHex),
      /repeats a lookupHashHex/,
    ],
    [
      'too many recovery wraps',
      (raw) =>
        (at(raw, 'vault').recoveryWraps = Array<Json>(17).fill(at(raw, 'vault.recoveryWraps.0'))),
      /more entries than an archive may carry/,
    ],
    [
      'an environment with no keys',
      (raw) => (at(raw, 'environments.0').keys = []),
      /at least one key/,
    ],
    [
      'a repeated key version',
      (raw) =>
        (at(raw, 'environments.0.keys.1').edkVersion = at(raw, 'environments.0.keys.0').edkVersion),
      /repeats a edkVersion/,
    ],
    [
      'a key version of zero',
      (raw) => (at(raw, 'environments.0.keys.0').edkVersion = 0),
      /edkVersion must be an integer/,
    ],
    [
      'a grant that is not a sealed box',
      (raw) =>
        (at(raw, 'environments.0.keys.0').edkSealedBlob = at(
          raw,
          'environments.0.secrets.0',
        ).valueBlob),
      /not a well-formed xk2.x25519/,
    ],
    [
      'a repeated secret name',
      (raw) =>
        (at(raw, 'environments.0.secrets.1').name = at(raw, 'environments.0.secrets.0').name),
      /repeats a name/,
    ],
    [
      'a repeated secret id',
      (raw) =>
        (at(raw, 'environments.0.secrets.1').secretId = at(
          raw,
          'environments.0.secrets.0',
        ).secretId),
      /repeats a secretId/,
    ],
    [
      'an invalid secret name',
      (raw) => (at(raw, 'environments.0.secrets.0').name = '1BAD'),
      /not a valid secret name/,
    ],
    [
      'an invalid value type',
      (raw) => (at(raw, 'environments.0.secrets.0').valueType = 'URL'),
      /not a valid value type/,
    ],
    [
      'an oversized value blob',
      (raw) => (at(raw, 'environments.0.secrets.0').valueBlob = `xk2.gcm.${'A'.repeat(90_000)}`),
      /longer than any blob/,
    ],
    [
      'an empty display name',
      (raw) => (at(raw, 'environments.0').projectName = ''),
      /1 to 256 characters/,
    ],
    [
      'a non-boolean production flag',
      (raw) => (at(raw, 'environments.0').isProduction = 'yes'),
      /true or false/,
    ],
    [
      'environments that are not an array',
      (raw) => (raw.environments = {}),
      /environments must be an array/,
    ],
    ['an account that is not an object', (raw) => (raw.account = 'x'), /account must be an object/],
    [
      'a name that is not a string',
      (raw) => (at(raw, 'environments.0').orgName = 5),
      /orgName must be a string/,
    ],
  ];

  it.each(cases)('refuses %s', (_label, edit, message) => {
    expect(refusal(edit)).toMatch(message);
  });

  it('accepts a secret with no note and an environment with no secrets', () => {
    const parsed = parseEdited((raw) => {
      at(raw, 'environments.0.secrets.0').noteBlob = null;
      at(raw, 'environments.1').secrets = [];
    });
    expect(parsed.environments[0]!.secrets[0]!.noteBlob).toBeNull();
    expect(parsed.environments[1]!.secrets).toEqual([]);
  });

  it('never puts the offending value in its message', () => {
    const marker = 'xk2.gcm.SECRET_LOOKING_MARKER';
    const message = refusal((raw) => (at(raw, 'vault').passphraseWrapBlob = marker));
    expect(message).not.toContain('MARKER');
  });

  it('accepts a surrogate pair in a name, and refuses a lone surrogate', () => {
    expect(
      parseEdited((raw) => (at(raw, 'environments.0').orgName = 'Acme 😀')).environments[0]!
        .orgName,
    ).toBe('Acme 😀');
    expect(refusal((raw) => (at(raw, 'environments.0').orgName = 'Acme \ud83d'))).toMatch(
      /character a name may not/,
    );
  });

  it('counts a name in code points, as the Go reader does', () => {
    expect(() =>
      parseEdited((raw) => (at(raw, 'environments.0').orgName = '😀'.repeat(256))),
    ).not.toThrow();
  });
});

describe('what a writer puts in a field', () => {
  it('cleans a name into one every reader accepts', () => {
    expect(toArchiveLabel('Acme')).toBe('Acme');
    expect(toArchiveLabel('Acme\u001b[2J Prod\u2028uction\u0085')).toBe('Acme[2J Production');
    expect(toArchiveLabel('Prod\ud800')).toBe('Prod\ufffd');
    expect(toArchiveLabel('Acme 😀')).toBe('Acme 😀');
    expect(toArchiveLabel('\u0000\u0001')).toBe('-');
    expect([...toArchiveLabel('😀'.repeat(300))]).toHaveLength(256);

    for (const name of ['Acme\u001b[2J', 'Prod\ud800', '', '\u2029', 'é'.repeat(400)]) {
      expect(() =>
        parseEdited((raw) => (at(raw, 'environments.0').orgName = toArchiveLabel(name))),
      ).not.toThrow();
    }
  });

  it('keeps a slug in the grammar, and replaces one outside it with one made from the id', () => {
    const id = '0192f0a1-7c3d-7e4f-8a1b-000000000009';
    expect(toArchiveSlug('acme', 'slug', id)).toBe('acme');
    expect(toArchiveSlug('prod_eu', 'environment', id)).toBe('prod_eu');
    expect(toArchiveSlug('prod_eu', 'slug', id)).toBe('x-0192f0a17c3d7e4f8a1b000000000009');
    expect(toArchiveSlug('acme\nfake', 'slug', id)).toBe('x-0192f0a17c3d7e4f8a1b000000000009');
    expect(toArchiveSlug('a'.repeat(64), 'environment', id)).toMatch(/^x-[0-9a-f]{32}$/);

    const replaced = toArchiveSlug('Bad Slug', 'environment', id);
    expect(replaced.length).toBeLessThanOrEqual(ARCHIVE_SLUG_MAX_LENGTH);
    expect(ARCHIVE_SLUG_PATTERN.test(replaced)).toBe(true);
    expect(ARCHIVE_ENVIRONMENT_SLUG_PATTERN.test(replaced)).toBe(true);
  });

  it('tells which secrets a reader would refuse', () => {
    expect(isArchivableSecret({ name: 'DATABASE_URL', valueType: 'string' })).toBe(true);
    expect(isArchivableSecret({ name: '1BAD', valueType: 'string' })).toBe(false);
    expect(isArchivableSecret({ name: 'OK', valueType: 'URL' })).toBe(false);
    expect(isArchivableSecret({ name: `A${'B'.repeat(256)}`, valueType: 'string' })).toBe(false);
  });
});

describe('the slug grammar', () => {
  it('is the product’s own, so the two cannot drift', () => {
    expect(ARCHIVE_SLUG_PATTERN.source).toBe(SLUG_PATTERN.source);
    expect(ARCHIVE_ENVIRONMENT_SLUG_PATTERN.source).toBe(ENVIRONMENT_SLUG_PATTERN.source);
    expect(ARCHIVE_SLUG_MAX_LENGTH).toBe(SLUG_MAX_LENGTH);
  });
});
