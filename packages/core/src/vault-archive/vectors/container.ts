import { toHex } from '../../crypto/client/bytes';
import type { Bytes } from '../../crypto/types';
import { crc32 } from '../crc32';
import { serializeArchiveDocument } from '../document';
import type { VaultArchiveDocument } from '../document';
import type { ArchiveVector } from './build';

/**
 * The container- and document-level vectors added in round 1 of review: ZIPs a
 * desktop tool or an attacker would make, and documents with the specific
 * defects the first readers let through. Kept apart from `build.ts` so that
 * file stays about the fixture vault.
 *
 * Every deflate stream here is built from **stored** deflate blocks (BTYPE 00,
 * RFC 1951 §3.2.4) by hand rather than by a compressor, so the bytes are the
 * same on every platform and zlib version and the vector file stays
 * byte-reproducible — while still taking every reader down its inflate path.
 */

/** A raw deflate stream of stored blocks: the data, uncompressed, in ≤ 65 535-byte pieces. */
export function deflateStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 0xffff));
  const out = new Uint8Array(data.length + blocks * 5);
  let read = 0;
  let write = 0;
  for (let block = 0; block < blocks; block += 1) {
    const length = Math.min(0xffff, data.length - read);
    out[write] = block === blocks - 1 ? 1 : 0; // BFINAL, BTYPE = 00
    out[write + 1] = length & 0xff;
    out[write + 2] = length >>> 8;
    out[write + 3] = ~length & 0xff;
    out[write + 4] = (~length >>> 8) & 0xff;
    out.set(data.subarray(read, read + length), write + 5);
    read += length;
    write += length + 5;
  }
  return out;
}

interface RawEntry {
  name: string;
  /** The bytes as they sit in the file — compressed when `method` is 8. */
  stored: Uint8Array;
  method: number;
  crc: number;
  uncompressedSize: number;
}

/** A ZIP built field by field, for inputs `writeStoredZip` deliberately cannot make. */
function rawZip(
  entries: readonly RawEntry[],
  end: { disk?: number; entries?: number } = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: number[] = [];
  const central: number[] = [];
  const u16 = (target: number[], value: number) => target.push(value & 0xff, (value >>> 8) & 0xff);
  const u32 = (target: number[], value: number) => {
    u16(target, value & 0xffff);
    u16(target, (value >>> 16) & 0xffff);
  };

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const offset = chunks.length;
    u32(chunks, 0x04034b50);
    u16(chunks, 20);
    u16(chunks, 0);
    u16(chunks, entry.method);
    u16(chunks, 0);
    u16(chunks, 0);
    u32(chunks, entry.crc);
    u32(chunks, entry.stored.length);
    u32(chunks, entry.uncompressedSize);
    u16(chunks, name.length);
    u16(chunks, 0);
    chunks.push(...name);
    for (const byte of entry.stored) chunks.push(byte);

    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, 0);
    u16(central, entry.method);
    u16(central, 0);
    u16(central, 0);
    u32(central, entry.crc);
    u32(central, entry.stored.length);
    u32(central, entry.uncompressedSize);
    u16(central, name.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, offset);
    central.push(...name);
  }

  const centralOffset = chunks.length;
  const tail: number[] = [];
  u32(tail, 0x06054b50);
  u16(tail, end.disk ?? 0);
  u16(tail, end.disk ?? 0);
  u16(tail, end.entries ?? entries.length);
  u16(tail, end.entries ?? entries.length);
  u32(tail, central.length);
  u32(tail, centralOffset);
  u16(tail, 0);
  return new Uint8Array([...chunks, ...central, ...tail]);
}

function hex(bytes: Uint8Array): string {
  return toHex(bytes as Bytes);
}

/**
 * A deflated re-zip of the single-part archive, with the extra entries macOS
 * adds: it must open exactly as the original does.
 */
export function rezipVector(
  doc: VaultArchiveDocument,
  code: string,
  opened: unknown[],
): ArchiveVector {
  const json = new TextEncoder().encode(serializeArchiveDocument(doc));
  const junk = new TextEncoder().encode('resource fork');
  const bytes = rawZip([
    {
      name: '__MACOSX/._archive.json',
      stored: deflateStored(junk),
      method: 8,
      crc: crc32(junk),
      uncompressedSize: junk.length,
    },
    {
      name: 'archive.json',
      stored: deflateStored(json),
      method: 8,
      crc: crc32(json),
      uncompressedSize: json.length,
    },
  ]);

  return {
    id: 'vault-archive/open/deflated-rezip',
    kind: 'vault-archive/open',
    description:
      'The archive re-zipped by a desktop tool: archive.json deflated, an extra __MACOSX entry beside it (§14.1).',
    input: { fileHex: hex(bytes), credential: { kind: 'recovery-code', code } },
    expected: { environments: opened },
  };
}

/** Container negatives every reader must refuse, in the format class (§14.1). */
export function containerRejectVectors(doc: VaultArchiveDocument): ArchiveVector[] {
  const json = new TextEncoder().encode(serializeArchiveDocument(doc));
  const stored = (overrides: Partial<RawEntry> = {}): RawEntry => ({
    name: 'archive.json',
    stored: json,
    method: 0,
    crc: crc32(json),
    uncompressedSize: json.length,
    ...overrides,
  });

  const reject = (id: string, description: string, bytes: Uint8Array): ArchiveVector => ({
    id: `vault-archive/reject/${id}`,
    kind: 'vault-archive/reject',
    description,
    input: { fileHex: hex(bytes) },
    expected: { errorClass: 'format' },
  });

  // Declared small, inflates to the whole document: a reader must stop at the
  // declared size rather than trust the stream.
  const bomb = stored({ stored: deflateStored(json), method: 8, uncompressedSize: 100 });

  return [
    reject(
      'zip64',
      'The end record marks the directory ZIP64 (entry count 0xFFFF).',
      rawZip([stored()], { entries: 0xffff }),
    ),
    reject(
      'multi-disk',
      'The end record names disk 1 of a multi-disk archive.',
      rawZip([stored()], { disk: 1 }),
    ),
    reject(
      'size-mismatch',
      'archive.json stored with a directory size one byte larger than its data.',
      rawZip([stored({ uncompressedSize: json.length + 1 })]),
    ),
    reject(
      'deflate-bomb',
      'archive.json declared as 100 bytes and inflating to the whole document.',
      rawZip([bomb]),
    ),
  ];
}

/** A copy of the document as JSON, edited, for a negative vector. */
function edited(doc: VaultArchiveDocument, edit: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(serializeArchiveDocument(doc)) as Record<string, unknown>;
  edit(raw);
  return `${JSON.stringify(raw, null, 2)}\n`;
}

/** Document negatives added in round 1 of review: names, slugs and duplicates (§14.4). */
export function documentRejectVectors(doc: VaultArchiveDocument): ArchiveVector[] {
  const environment = (raw: Record<string, unknown>, index = 0) =>
    (raw['environments'] as Record<string, unknown>[])[index]!;
  const reject = (id: string, description: string, jsonText: string): ArchiveVector => ({
    id: `vault-archive/reject/${id}`,
    kind: 'vault-archive/reject',
    description,
    input: { jsonText },
    expected: { errorClass: 'format' },
  });

  return [
    reject(
      'newline-in-slug',
      "An organisation slug carrying a newline and a forged second line: slugs are the product's own grammar only.",
      edited(doc, (raw) => (environment(raw)['orgSlug'] = 'acme\nfake/prod DATABASE_URL=x')),
    ),
    reject(
      'slug-too-long',
      "An environment slug of 64 characters, one over the product's limit.",
      edited(doc, (raw) => (environment(raw)['environmentSlug'] = 'a'.repeat(64))),
    ),
    reject(
      'control-in-name',
      'An organisation name carrying an ESC sequence a terminal would act on.',
      edited(doc, (raw) => (environment(raw)['orgName'] = 'Acme\u001b[2J')),
    ),
    reject(
      'line-separator-in-name',
      'A project name carrying U+2028, a line break to anything that renders Unicode.',
      edited(doc, (raw) => (environment(raw)['projectName'] = 'API Production')),
    ),
    reject(
      'lone-surrogate',
      'An environment name holding a lone surrogate escape (\\ud800), which no UTF-8 text can carry.',
      edited(doc, (raw) => (environment(raw)['environmentName'] = 'PLACEHOLDER')).replace(
        '"PLACEHOLDER"',
        '"Prod\\ud800"',
      ),
    ),
    reject(
      'duplicate-environment-id',
      'Two entries for one environment id.',
      edited(doc, (raw) => {
        environment(raw, 1)['environmentId'] = environment(raw, 0)['environmentId'];
      }),
    ),
    reject(
      'duplicate-environment-path',
      'Two entries with the same organisation, project and environment slug.',
      edited(doc, (raw) => {
        for (const key of ['orgSlug', 'projectSlug', 'environmentSlug']) {
          environment(raw, 1)[key] = environment(raw, 0)[key];
        }
      }),
    ),
  ];
}

/**
 * The single-part document with its integers written as `1.0`, `1e0` and
 * `6.5536e4` — the same integers (§14.4), which every reader must accept as
 * such, inside `kdfParams` as much as anywhere else.
 */
export function integerFormsVector(
  doc: VaultArchiveDocument,
  code: string,
  opened: unknown[],
): ArchiveVector {
  let jsonText = serializeArchiveDocument(doc);
  const rewrite = (pattern: RegExp, replacement: (digits: string) => string) => {
    const next = jsonText.replace(pattern, (_match, digits: string) => replacement(digits));
    if (next === jsonText) throw new Error(`integer-forms: ${String(pattern)} matched nothing`);
    jsonText = next;
  };
  rewrite(/"formatVersion": (1),/, () => '"formatVersion": 1.0,');
  rewrite(/"part": (1),/, () => '"part": 1e0,');
  rewrite(/"m": (\d+),/, (digits) => `"m": ${Number(digits) / 10_000}e4,`);
  rewrite(/"t": (\d+),/, (digits) => `"t": ${digits}.0,`);

  return {
    id: 'vault-archive/open/integer-forms',
    kind: 'vault-archive/open',
    description:
      'Integers written as 1.0, 1e0 and an exponent, in the document and inside kdfParams: the same integers, accepted by every reader (§14.4).',
    input: { jsonText, credential: { kind: 'recovery-code', code } },
    expected: { environments: opened },
  };
}
