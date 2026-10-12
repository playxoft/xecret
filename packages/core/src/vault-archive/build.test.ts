import { beforeAll, describe, expect, it } from 'vitest';
import { toHex } from '../crypto/client/bytes';
import { toBase64Url } from '../crypto/encoding';
import {
  ARCHIVE_PART_BUDGET_BYTES,
  archiveFileName,
  archiveReadme,
  encodeArchivePart,
  planArchiveParts,
} from './build';
import type { ArchiveInput } from './build';
import type { ArchiveEnvironment } from './document';
import { ArchiveTooLargeError } from './errors';
import { readArchiveFile } from './open';
import { buildFixture } from './vectors/build';

/**
 * The writer: planning parts, encoding each, and — the claim the whole archive
 * rests on — never carrying a plaintext.
 */

let input: ArchiveInput;
const options = {
  archiveId: '0192f0a1-7c3d-7e4f-8a1b-000000000009',
  createdAt: new Date('2026-10-12T09:30:00.000Z'),
  retainedUntil: new Date('2026-10-19T09:30:00.000Z'),
};

beforeAll(async () => {
  input = (await buildFixture()).input;
}, 30_000);

/** Every secret in a set of parts, as `environmentId/name`. */
function secretKeys(parts: { environments: ArchiveEnvironment[] }[]): string[] {
  return parts.flatMap((part) =>
    part.environments.flatMap((environment) =>
      environment.secrets.map((secret) => `${environment.environmentId}/${secret.name}`),
    ),
  );
}

describe('planArchiveParts', () => {
  it('fits the fixture in one part under the default budget', () => {
    const parts = planArchiveParts(input, options);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.part).toBe(1);
    expect(parts[0]!.parts).toBe(1);
  });

  it('orders environments, keys and secrets the same whatever order they arrive in', () => {
    const shuffled: ArchiveInput = {
      ...input,
      environments: [...input.environments].reverse().map((environment) => ({
        ...environment,
        keys: [...environment.keys].reverse(),
        secrets: [...environment.secrets].reverse(),
      })),
    };

    expect(planArchiveParts(shuffled, options)).toEqual(planArchiveParts(input, options));
    const names = planArchiveParts(input, options)[0]!.environments.map(
      (environment) =>
        `${environment.orgName}/${environment.projectName}/${environment.environmentName}`,
    );
    expect(names).toEqual([...names].sort());
  });

  // Budgets from "every secret in its own part" to "everything in one", so the
  // packer is exercised across every boundary the fixture has.
  it.each([11_000, 12_000, 14_000, 20_000, 40_000])(
    'splits under a %i-byte budget without losing, duplicating or overfilling',
    async (maxPartBytes) => {
      const parts = planArchiveParts(input, { ...options, maxPartBytes });
      expect(secretKeys(parts).sort()).toEqual(
        secretKeys([{ environments: [...input.environments] }]).sort(),
      );
      expect(new Set(secretKeys(parts)).size).toBe(secretKeys(parts).length);

      // Every environment appears in some part, the empty one included.
      const seen = new Set(
        parts.flatMap((part) => part.environments.map((environment) => environment.environmentId)),
      );
      expect(seen.size).toBe(input.environments.length);

      for (const part of parts) {
        expect(part.parts).toBe(parts.length);
        // The vault block is in every part, so each opens on its own.
        expect(part.vault).toEqual(input.vault);
        const file = encodeArchivePart(part, {
          retainedUntil: options.retainedUntil,
          maxPartBytes,
        });
        expect(file.bytes.length).toBeLessThanOrEqual(maxPartBytes);
        // And it reads back as exactly the part that was planned.
        expect(await readArchiveFile(file.bytes)).toEqual(part);
      }
    },
  );

  it('refuses a vault that needs more parts than allowed', () => {
    expect(() =>
      planArchiveParts(input, { ...options, maxPartBytes: 11_000, maxParts: 2 }),
    ).toThrow(ArchiveTooLargeError);
  });

  it('refuses a budget no single secret fits', () => {
    expect(() => planArchiveParts(input, { ...options, maxPartBytes: 2_000 })).toThrow(
      ArchiveTooLargeError,
    );
  });

  it('never accepts a looser part limit than the format allows', () => {
    expect(() =>
      planArchiveParts(input, { ...options, maxPartBytes: 12_000, maxParts: 1_000 }),
    ).not.toThrow();
  });

  it('plans one part for a vault with no environments at all', () => {
    const parts = planArchiveParts({ ...input, environments: [] }, options);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.environments).toEqual([]);
  });
});

describe('encodeArchivePart', () => {
  it('holds README.txt then archive.json', () => {
    const [part] = planArchiveParts(input, options);
    const { bytes } = encodeArchivePart(part!, { retainedUntil: options.retainedUntil });
    const text = new TextDecoder().decode(bytes);
    expect(text.indexOf('README.txt')).toBeLessThan(text.indexOf('archive.json'));
  });

  it('refuses a part that came out over its budget', () => {
    const [part] = planArchiveParts(input, options);
    expect(() =>
      encodeArchivePart(part!, { retainedUntil: options.retainedUntil, maxPartBytes: 1_000 }),
    ).toThrow(ArchiveTooLargeError);
  });
});

describe('archiveFileName', () => {
  it('names a single archive and a part', () => {
    expect(archiveFileName({ createdAt: '2026-10-12T09:30:00.000Z', part: 1, parts: 1 })).toBe(
      'xecret-vault-archive-2026-10-12.zip',
    );
    expect(archiveFileName({ createdAt: '2026-10-12T09:30:00.000Z', part: 2, parts: 3 })).toBe(
      'xecret-vault-archive-2026-10-12-part-2-of-3.zip',
    );
  });
});

describe('archiveReadme', () => {
  const doc = {
    createdAt: '2026-10-12T09:30:00.000Z',
    part: 1,
    parts: 1,
    account: { userId: '0192f0a1-7c3d-7e4f-8a1b-2c3d4e5f6a7b' },
  };

  it('says everything §14.3 requires', () => {
    const readme = archiveReadme(doc, { retainedUntil: options.retainedUntil });

    expect(readme).toContain('0192f0a1-7c3d-7e4f-8a1b-2c3d4e5f6a7b');
    expect(readme).toContain('2026-10-12 at 09:30 UTC');
    expect(readme).toMatch(/master passphrase of that vault, or one of its unused recovery/);
    expect(readme).toContain('ANYONE WHO GETS THIS FILE CAN ATTACK YOUR PASSPHRASE');
    expect(readme).toMatch(/There is no\s+rate limit and no lockout/);
    expect(readme).toContain('xecret vault open-archive');
    expect(readme).toContain('Import archive');
    expect(readme).toContain('section 14 of docs/security/e2ee-crypto-spec.md');
    expect(readme).toContain('Until 2026-10-19 at 09:30 UTC');
  });

  it('puts the warning before the instructions', () => {
    const readme = archiveReadme(doc, { retainedUntil: null });
    expect(readme.indexOf('WARNING')).toBeLessThan(readme.indexOf('HOW TO OPEN IT'));
    expect(readme).not.toContain('SEVEN DAYS');
  });

  it('says which part of how many, for a split archive', () => {
    expect(archiveReadme({ ...doc, part: 2, parts: 3 }, { retainedUntil: null })).toContain(
      'This is part 2 of 3.',
    );
  });

  it('is plain ASCII, so any editor on any system shows it', () => {
    expect(archiveReadme(doc, { retainedUntil: options.retainedUntil })).toMatch(/^[\n -~]*$/);
  });
});

/**
 * The archive's whole claim: no plaintext, in any encoding.
 *
 * The fixture's own plaintexts — every value and note it encrypted — are swept
 * for, in every form a careless writer might have produced: raw UTF-8, UTF-16,
 * base64, base64url, hex, URL-encoded, and JSON-escaped. Short values are
 * skipped: a two-byte string will occur by chance in any 12 kB of base64, and a
 * sweep that flags chance is a sweep somebody learns to ignore. The empty value
 * is covered by its secret being `ok` in the vectors, not here.
 */
describe('the no-plaintext sweep', () => {
  const PLAINTEXTS = [
    'postgres://app:example-not-a-real-key@db.internal:5432/payments?sslmode=require',
    'example-not-a-real-key',
    'legacy-token-example-not-a-real-key',
    'bot-token-example-not-a-real-key',
    'value-under-version-2',
    'https://staging.example.com/api',
    'line one\nline two',
    'Primary cluster. Rotated quarterly.',
    'Written before the key was rotated.',
    'This note was written under key version 1.',
    'A value with newlines, tabs, quotes and a backslash.',
    'written under a key this account was never given',
    'this value must not be returned',
    'Café — 日本語',
  ];

  function encodings(text: string): Record<string, Uint8Array> {
    const encoder = new TextEncoder();
    const utf8 = encoder.encode(text);
    const utf16 = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i += 1) {
      utf16[i * 2] = text.charCodeAt(i) & 0xff;
      utf16[i * 2 + 1] = text.charCodeAt(i) >> 8;
    }
    return {
      utf8,
      utf16le: utf16,
      base64: encoder.encode(btoa(String.fromCharCode(...utf8))),
      base64url: encoder.encode(toBase64Url(utf8)),
      hex: encoder.encode(toHex(utf8)),
      urlEncoded: encoder.encode(encodeURIComponent(text)),
      jsonEscaped: encoder.encode(JSON.stringify(text).slice(1, -1)),
    };
  }

  function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
    outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  }

  it('finds none, in any part, in any encoding', () => {
    const files = [
      ...planArchiveParts(input, options).map((part) => encodeArchivePart(part, options).bytes),
      ...planArchiveParts(input, { ...options, maxPartBytes: 11_000 }).map(
        (part) => encodeArchivePart(part, { ...options, maxPartBytes: 11_000 }).bytes,
      ),
    ];

    const found: string[] = [];
    for (const bytes of files) {
      for (const plaintext of PLAINTEXTS) {
        for (const [encoding, needle] of Object.entries(encodings(plaintext))) {
          if (contains(bytes, needle)) found.push(`${encoding}: ${plaintext.slice(0, 20)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('would find one, so the sweep is not vacuous', () => {
    // The same sweep over a document a broken writer produced — a note copied
    // into the archive in the clear — must fire.
    const [part] = planArchiveParts(input, options);
    const leaky = {
      ...part!,
      environments: part!.environments.map((environment) => ({
        ...environment,
        orgName: 'Primary cluster. Rotated quarterly.',
      })),
    };
    const bytes = encodeArchivePart(leaky, {
      ...options,
      maxPartBytes: ARCHIVE_PART_BUDGET_BYTES,
    }).bytes;
    expect(contains(bytes, encodings('Primary cluster. Rotated quarterly.')['utf8']!)).toBe(true);
  });
});
