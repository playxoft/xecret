import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';
import { ArchiveFormatError } from './errors';
import { dosTimestamp, looksLikeZip, readZipEntry, writeStoredZip } from './zip';

/**
 * The container, against spec §14.1: a narrow writer whose bytes are a pure
 * function of its input, and a reader that is liberal about what desktop tools
 * do to a ZIP and strict about what matters.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const WHEN = new Date('2026-10-12T09:30:07.000Z');
const LIMIT = { maxBytes: 1024 * 1024 };

function zip(entries: Record<string, string>): Uint8Array {
  return writeStoredZip(
    Object.entries(entries).map(([name, text]) => ({ name, data: encoder.encode(text) })),
    WHEN,
  );
}

/** Builds a ZIP by hand, so the reader can be shown inputs the writer never makes. */
function handmade(
  entries: {
    name: string;
    data: Uint8Array;
    method?: number;
    flags?: number;
    uncompressedSize?: number;
    crc?: number;
  }[],
  comment = '',
): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  const push16 = (target: number[], value: number) =>
    target.push(value & 0xff, (value >>> 8) & 0xff);
  const push32 = (target: number[], value: number) => {
    push16(target, value & 0xffff);
    push16(target, (value >>> 16) & 0xffff);
  };

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const offset = parts.length;
    const crc = entry.crc ?? 0;
    const size = entry.uncompressedSize ?? entry.data.length;
    push32(parts, 0x04034b50);
    push16(parts, 20);
    push16(parts, entry.flags ?? 0);
    push16(parts, entry.method ?? 0);
    push16(parts, 0);
    push16(parts, 0);
    push32(parts, crc);
    push32(parts, entry.data.length);
    push32(parts, size);
    push16(parts, name.length);
    push16(parts, 0);
    parts.push(...name, ...entry.data);

    push32(central, 0x02014b50);
    push16(central, 20);
    push16(central, 20);
    push16(central, entry.flags ?? 0);
    push16(central, entry.method ?? 0);
    push16(central, 0);
    push16(central, 0);
    push32(central, crc);
    push32(central, entry.data.length);
    push32(central, size);
    push16(central, name.length);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push32(central, 0);
    push32(central, offset);
    central.push(...name);
  }

  const centralOffset = parts.length;
  const end: number[] = [];
  const commentBytes = encoder.encode(comment);
  push32(end, 0x06054b50);
  push16(end, 0);
  push16(end, 0);
  push16(end, entries.length);
  push16(end, entries.length);
  push32(end, central.length);
  push32(end, centralOffset);
  push16(end, commentBytes.length);
  return new Uint8Array([...parts, ...central, ...end, ...commentBytes]);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    // The CRC-32/ISO-HDLC check value for "123456789", as zlib and Go compute it.
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('dosTimestamp', () => {
  it('encodes UTC, halving the seconds', () => {
    const { time, date } = dosTimestamp(WHEN);
    expect(time).toBe((9 << 11) | (30 << 5) | 3);
    expect(date).toBe(((2026 - 1980) << 9) | (10 << 5) | 12);
  });

  it('clamps a year the format cannot represent', () => {
    expect(dosTimestamp(new Date('1970-01-01T00:00:00Z')).date >> 9).toBe(0);
  });
});

describe('writeStoredZip', () => {
  it('is a pure function of its input', () => {
    expect(zip({ 'README.txt': 'hi', 'archive.json': '{}' })).toEqual(
      zip({ 'README.txt': 'hi', 'archive.json': '{}' }),
    );
  });

  it('writes the exact header fields §14.1 requires', () => {
    const bytes = zip({ 'README.txt': 'hi' });
    const view = new DataView(bytes.buffer);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(4, true)).toBe(10); // version needed
    expect(view.getUint16(6, true)).toBe(0); // flags
    expect(view.getUint16(8, true)).toBe(0); // stored
    expect(view.getUint32(14, true)).toBe(crc32(encoder.encode('hi')));

    const central = 30 + 'README.txt'.length + 2;
    expect(view.getUint32(central, true)).toBe(0x02014b50);
    expect(view.getUint16(central + 4, true)).toBe(20); // version made by
    expect(view.getUint32(central + 38, true)).toBe(0); // external attributes

    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 20, true)).toBe(0); // no comment
  });

  it('refuses a name it would have to flag as UTF-8', () => {
    expect(() => writeStoredZip([{ name: 'naïve.txt', data: new Uint8Array() }], WHEN)).toThrow(
      TypeError,
    );
  });
});

describe('readZipEntry', () => {
  it('reads an entry the writer wrote', async () => {
    const bytes = zip({ 'README.txt': 'read me', 'archive.json': '{"a":1}' });
    expect(decoder.decode(await readZipEntry(bytes, 'archive.json', LIMIT))).toBe('{"a":1}');
  });

  it('reads a deflated entry, as a desktop tool re-zips it', async () => {
    const text = '{"format":"x"}'.repeat(50);
    const data = encoder.encode(text);
    const bytes = handmade([
      {
        name: 'archive.json',
        data: await deflateRaw(data),
        method: 8,
        uncompressedSize: data.length,
        crc: crc32(data),
      },
    ]);

    expect(decoder.decode(await readZipEntry(bytes, 'archive.json', LIMIT))).toBe(text);
  });

  it('ignores entries it does not need, and finds the end record past a comment', async () => {
    const data = encoder.encode('{}');
    const bytes = handmade(
      [
        {
          name: '__MACOSX/._archive.json',
          data: encoder.encode('junk'),
          crc: crc32(encoder.encode('junk')),
        },
        { name: 'archive.json', data, crc: crc32(data) },
      ],
      'a comment',
    );

    expect(decoder.decode(await readZipEntry(bytes, 'archive.json', LIMIT))).toBe('{}');
  });

  it('matches the name exactly: not case-folded, not in a folder', async () => {
    const data = encoder.encode('{}');
    for (const name of ['Archive.json', 'folder/archive.json']) {
      const bytes = handmade([{ name, data, crc: crc32(data) }]);
      await expect(readZipEntry(bytes, 'archive.json', LIMIT)).rejects.toThrow(/no archive.json/);
    }
  });

  const refusals: [string, () => Promise<Uint8Array> | Uint8Array, RegExp][] = [
    ['not a zip at all', () => encoder.encode('hello'), /not a ZIP/],
    [
      'two entries of the name',
      () => {
        const data = encoder.encode('{}');
        return handmade([
          { name: 'archive.json', data, crc: crc32(data) },
          { name: 'archive.json', data, crc: crc32(data) },
        ]);
      },
      /more than one/,
    ],
    [
      'an encrypted entry',
      () =>
        handmade([
          {
            name: 'archive.json',
            data: encoder.encode('{}'),
            flags: 1,
            crc: crc32(encoder.encode('{}')),
          },
        ]),
      /encrypted/,
    ],
    [
      'an unsupported method',
      () =>
        handmade([
          {
            name: 'archive.json',
            data: encoder.encode('{}'),
            method: 12,
            crc: crc32(encoder.encode('{}')),
          },
        ]),
      /compression method/,
    ],
    [
      'a declared size over the limit',
      () =>
        handmade([
          {
            name: 'archive.json',
            data: encoder.encode('{}'),
            uncompressedSize: 2 * 1024 * 1024,
            crc: 0,
          },
        ]),
      /larger than any archive/,
    ],
    [
      'a checksum that does not match',
      () => handmade([{ name: 'archive.json', data: encoder.encode('{}'), crc: 1 }]),
      /checksum/,
    ],
    [
      'a size that does not match',
      () =>
        handmade([
          {
            name: 'archive.json',
            data: encoder.encode('{}'),
            uncompressedSize: 5,
            crc: crc32(encoder.encode('{}')),
          },
        ]),
      /size/,
    ],
    [
      'ZIP64 markers',
      () => {
        const bytes = zip({ 'archive.json': '{}' });
        new DataView(bytes.buffer).setUint16(bytes.length - 22 + 10, 0xffff, true);
        new DataView(bytes.buffer).setUint16(bytes.length - 22 + 8, 0xffff, true);
        return bytes;
      },
      /ZIP64/,
    ],
    [
      'a multi-disk archive',
      () => {
        const bytes = zip({ 'archive.json': '{}' });
        new DataView(bytes.buffer).setUint16(bytes.length - 22 + 4, 1, true);
        return bytes;
      },
      /Multi-disk/,
    ],
    [
      'no end record',
      () => zip({ 'archive.json': '{}' }).slice(0, -22),
      /end-of-central-directory/,
    ],
    [
      'a directory pointing past the end',
      () => {
        const bytes = zip({ 'archive.json': '{}' });
        new DataView(bytes.buffer).setUint32(bytes.length - 22 + 16, 0x7fffffff, true);
        return bytes;
      },
      /out of bounds/,
    ],
    [
      'a damaged directory entry',
      () => {
        const bytes = zip({ 'archive.json': '{}' });
        const centralOffset = new DataView(bytes.buffer).getUint32(bytes.length - 22 + 16, true);
        bytes[centralOffset] = 0;
        return bytes;
      },
      /damaged/,
    ],
    [
      'a local header that is not one',
      () => {
        const bytes = zip({ 'archive.json': '{}' });
        const view = new DataView(bytes.buffer);
        const centralOffset = view.getUint32(bytes.length - 22 + 16, true);
        view.setUint32(centralOffset + 42, 1, true); // local offset into the middle of a header
        return bytes;
      },
      /entry header is damaged/,
    ],
    [
      'a local header past the end',
      () => {
        const bytes = zip({ 'archive.json': '{}' });
        const view = new DataView(bytes.buffer);
        const centralOffset = view.getUint32(bytes.length - 22 + 16, true);
        view.setUint32(centralOffset + 42, bytes.length, true);
        return bytes;
      },
      /points outside/,
    ],
  ];

  it.each(refusals)('refuses %s', async (_label, build, message) => {
    const bytes = await build();
    const failure = await readZipEntry(bytes, 'archive.json', LIMIT).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ArchiveFormatError);
    expect((failure as Error).message).toMatch(message);
  });

  it('stops inflating at the declared size, rather than after filling memory', async () => {
    const big = new Uint8Array(256 * 1024); // zeros compress to almost nothing
    const bytes = handmade([
      {
        name: 'archive.json',
        data: await deflateRaw(big),
        method: 8,
        uncompressedSize: 1024,
        crc: crc32(big),
      },
    ]);

    await expect(readZipEntry(bytes, 'archive.json', LIMIT)).rejects.toThrow(
      /more than its stated size/,
    );
  });

  it('uses a supplied inflater when given one', async () => {
    const data = encoder.encode('{}');
    const bytes = handmade([
      {
        name: 'archive.json',
        data: new Uint8Array([1]),
        method: 8,
        crc: crc32(data),
        uncompressedSize: 2,
      },
    ]);
    const out = await readZipEntry(bytes, 'archive.json', {
      ...LIMIT,
      inflateRaw: async () => data,
    });
    expect(decoder.decode(out)).toBe('{}');
  });

  it('reports a stream that is not deflate as damage, not a crash', async () => {
    const bytes = handmade([
      {
        name: 'archive.json',
        data: encoder.encode('not deflate'),
        method: 8,
        uncompressedSize: 10,
        crc: 0,
      },
    ]);
    await expect(readZipEntry(bytes, 'archive.json', LIMIT)).rejects.toThrow(ArchiveFormatError);
  });
});

describe('looksLikeZip', () => {
  it('recognises only the local header signature', () => {
    expect(looksLikeZip(zip({ a: '' }))).toBe(true);
    expect(looksLikeZip(encoder.encode('{}'))).toBe(false);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});
