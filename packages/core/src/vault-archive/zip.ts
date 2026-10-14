import { crc32 } from './crc32';
import { ArchiveFormatError } from './errors';

/**
 * The archive's container: the smallest ZIP that any operating system opens by
 * double-clicking, and a reader that accepts what a desktop tool makes of it.
 *
 * ── Why a ZIP at all ──
 * Because the archive must carry a `README.txt` a person can read without any
 * tool from us, beside a document a program can parse — and must survive being
 * attached to an email and saved somewhere for years. A ZIP is the one container
 * every platform opens natively. Spec §14.1 is the byte-level definition.
 *
 * ── The writer is deliberately narrow ──
 * Stored entries only (method 0), no extra fields, no comments, no data
 * descriptors, no ZIP64, DOS timestamps from one fixed instant. That makes the
 * output a pure function of its input, so the test vectors pin it byte for byte,
 * and it needs no compression library in a Worker or a browser. The contents
 * are ciphertext in base64url, which deflate would shrink by a quarter at most;
 * the size budget is kept by splitting (§14.6), not by compressing.
 *
 * ── The reader is deliberately liberal about the container ──
 * A person may unzip the file and zip it again with Finder or Explorer, which
 * deflates and adds entries of its own. So the reader accepts deflate, ignores
 * entries it does not need, and is strict about exactly the things that matter:
 * one `archive.json`, not encrypted, not ZIP64, a bounded size declared before
 * inflating, and a CRC and size that match after.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

/** `version needed to extract`: 1.0, which is all stored entries need. */
const VERSION_NEEDED = 10;
/** `version made by`: 2.0 on the MS-DOS host, as most writers declare. */
const VERSION_MADE_BY = 20;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;

export interface ZipEntryInput {
  /** ASCII only: the writer sets no UTF-8 flag, so a non-ASCII name is refused. */
  name: string;
  data: Uint8Array;
}

/** Inflates a raw deflate stream (RFC 1951), refusing to produce more than `maxBytes`. */
export type InflateRaw = (data: Uint8Array, maxBytes: number) => Promise<Uint8Array>;

/**
 * DOS time and date for `when`, in UTC.
 *
 * Seconds are halved because the format stores them in five bits. Years before
 * 1980 are unrepresentable and are clamped there rather than wrapping into a
 * date nobody intended.
 */
export function dosTimestamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getUTCFullYear());
  const time =
    (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  return { time, date };
}

/**
 * Writes a ZIP of stored entries, in the order given, exactly as spec §14.1
 * requires.
 */
export function writeStoredZip(entries: readonly ZipEntryInput[], modified: Date): Uint8Array {
  const { time, date } = dosTimestamp(modified);
  const encoder = new TextEncoder();

  const prepared = entries.map((entry) => {
    if (!/^[\x20-\x7e]+$/.test(entry.name)) {
      throw new TypeError('ZIP entry names here are printable ASCII');
    }
    return { name: encoder.encode(entry.name), data: entry.data, crc: crc32(entry.data) };
  });

  const localSize = prepared.reduce(
    (total, entry) => total + LOCAL_HEADER_BYTES + entry.name.length + entry.data.length,
    0,
  );
  const centralSize = prepared.reduce(
    (total, entry) => total + CENTRAL_HEADER_BYTES + entry.name.length,
    0,
  );

  if (localSize + centralSize + END_OF_CENTRAL_DIRECTORY_BYTES > 0xffffffff) {
    throw new TypeError('This writer does not produce ZIP64 archives');
  }

  const out = new Uint8Array(localSize + centralSize + END_OF_CENTRAL_DIRECTORY_BYTES);
  const view = new DataView(out.buffer);
  let offset = 0;
  const offsets: number[] = [];

  for (const entry of prepared) {
    offsets.push(offset);
    view.setUint32(offset, LOCAL_HEADER_SIGNATURE, true);
    view.setUint16(offset + 4, VERSION_NEEDED, true);
    view.setUint16(offset + 6, 0, true); // flags
    view.setUint16(offset + 8, METHOD_STORED, true);
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, date, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true); // compressed size
    view.setUint32(offset + 22, entry.data.length, true); // uncompressed size
    view.setUint16(offset + 26, entry.name.length, true);
    view.setUint16(offset + 28, 0, true); // extra field length
    out.set(entry.name, offset + LOCAL_HEADER_BYTES);
    out.set(entry.data, offset + LOCAL_HEADER_BYTES + entry.name.length);
    offset += LOCAL_HEADER_BYTES + entry.name.length + entry.data.length;
  }

  const centralOffset = offset;
  prepared.forEach((entry, index) => {
    view.setUint32(offset, CENTRAL_HEADER_SIGNATURE, true);
    view.setUint16(offset + 4, VERSION_MADE_BY, true);
    view.setUint16(offset + 6, VERSION_NEEDED, true);
    view.setUint16(offset + 8, 0, true); // flags
    view.setUint16(offset + 10, METHOD_STORED, true);
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, date, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.name.length, true);
    view.setUint16(offset + 30, 0, true); // extra field length
    view.setUint16(offset + 32, 0, true); // comment length
    view.setUint16(offset + 34, 0, true); // disk number start
    view.setUint16(offset + 36, 0, true); // internal attributes
    view.setUint32(offset + 38, 0, true); // external attributes
    view.setUint32(offset + 42, offsets[index]!, true);
    out.set(entry.name, offset + CENTRAL_HEADER_BYTES);
    offset += CENTRAL_HEADER_BYTES + entry.name.length;
  });

  view.setUint32(offset, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(offset + 4, 0, true); // this disk
  view.setUint16(offset + 6, 0, true); // disk with the central directory
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true); // comment length

  return out;
}

/** Whether `bytes` begins like a ZIP file — a local file header signature. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

interface CentralEntry {
  name: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/**
 * Reads one entry, by exact name, from a ZIP file — under every rule of spec
 * §14.1.
 *
 * Every failure is an {@link ArchiveFormatError}. The messages say what is wrong
 * with the container and never echo its contents.
 */
export async function readZipEntry(
  file: Uint8Array,
  name: string,
  options: { maxBytes: number; inflateRaw?: InflateRaw | undefined },
): Promise<Uint8Array> {
  if (!looksLikeZip(file)) {
    throw new ArchiveFormatError('This file is not a ZIP archive.');
  }

  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const end = findEndOfCentralDirectory(view);

  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const entriesOnDisk = view.getUint16(end + 8, true);
  const totalEntries = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);

  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ArchiveFormatError('Multi-disk ZIP archives are not supported.');
  }
  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    (end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR_SIGNATURE)
  ) {
    throw new ArchiveFormatError('ZIP64 archives are not supported.');
  }
  if (centralOffset + centralSize > end) {
    throw new ArchiveFormatError('The ZIP central directory is out of bounds.');
  }

  const entries = readCentralDirectory(file, view, centralOffset, centralSize, totalEntries);
  const wanted = new TextEncoder().encode(name);
  const matches = entries.filter((entry) => bytesEqual(entry.name, wanted));

  if (matches.length === 0) {
    throw new ArchiveFormatError(`The ZIP archive has no ${name}.`);
  }
  if (matches.length > 1) {
    throw new ArchiveFormatError(`The ZIP archive has more than one ${name}.`);
  }

  const entry = matches[0]!;
  if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
    throw new ArchiveFormatError(`${name} is encrypted inside the ZIP, which is not supported.`);
  }
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    throw new ArchiveFormatError(`${name} uses a ZIP compression method that is not supported.`);
  }
  if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff) {
    throw new ArchiveFormatError('ZIP64 archives are not supported.');
  }
  if (entry.uncompressedSize > options.maxBytes) {
    throw new ArchiveFormatError(`${name} is larger than any archive this reader accepts.`);
  }

  const data = localData(file, view, entry);
  const contents =
    entry.method === METHOD_STORED
      ? data
      : await (options.inflateRaw ?? inflateRawWithStreams)(data, entry.uncompressedSize);

  if (contents.length !== entry.uncompressedSize) {
    throw new ArchiveFormatError(`${name} does not have the size the ZIP directory states.`);
  }
  if (crc32(contents) !== entry.crc) {
    throw new ArchiveFormatError(`${name} is damaged: its checksum does not match.`);
  }

  return contents;
}

function findEndOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - END_OF_CENTRAL_DIRECTORY_BYTES;
  const first = Math.max(0, last - MAX_COMMENT_BYTES);

  for (let offset = last; offset >= first; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    // The comment must run exactly to the end of the file, or this is a
    // signature that happens to occur inside some entry's data.
    if (
      offset + END_OF_CENTRAL_DIRECTORY_BYTES + view.getUint16(offset + 20, true) ===
      view.byteLength
    ) {
      return offset;
    }
  }

  throw new ArchiveFormatError('The ZIP archive has no end-of-central-directory record.');
}

function readCentralDirectory(
  file: Uint8Array,
  view: DataView,
  offset: number,
  size: number,
  count: number,
): CentralEntry[] {
  const entries: CentralEntry[] = [];
  const limit = offset + size;
  let cursor = offset;

  for (let index = 0; index < count; index += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > limit) {
      throw new ArchiveFormatError('The ZIP central directory is truncated.');
    }
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ArchiveFormatError('The ZIP central directory is damaged.');
    }

    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (next > limit) {
      throw new ArchiveFormatError('The ZIP central directory is truncated.');
    }

    entries.push({
      flags: view.getUint16(cursor + 8, true),
      method: view.getUint16(cursor + 10, true),
      crc: view.getUint32(cursor + 16, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      localOffset: view.getUint32(cursor + 42, true),
      name: file.subarray(
        cursor + CENTRAL_HEADER_BYTES,
        cursor + CENTRAL_HEADER_BYTES + nameLength,
      ),
    });
    cursor = next;
  }

  if (cursor !== limit) {
    throw new ArchiveFormatError('The ZIP central directory does not match its stated size.');
  }
  return entries;
}

function localData(file: Uint8Array, view: DataView, entry: CentralEntry): Uint8Array {
  const offset = entry.localOffset;
  if (offset + LOCAL_HEADER_BYTES > file.length) {
    throw new ArchiveFormatError('A ZIP entry points outside the file.');
  }
  if (view.getUint32(offset, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new ArchiveFormatError('A ZIP entry header is damaged.');
  }

  // The local header's own lengths locate the data; its sizes are not trusted,
  // because a writer that streamed the entry put zeros there and the real
  // values in a data descriptor. The central directory's are authoritative.
  const start =
    offset +
    LOCAL_HEADER_BYTES +
    view.getUint16(offset + 26, true) +
    view.getUint16(offset + 28, true);
  const stop = start + entry.compressedSize;
  if (stop > file.length) {
    throw new ArchiveFormatError('A ZIP entry runs past the end of the file.');
  }
  return file.subarray(start, stop);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Raw inflate with the platform's own `DecompressionStream`, which browsers,
 * Workers and Node all ship. Output is counted as it arrives and the stream is
 * abandoned the moment it exceeds what the directory declared — a small file
 * that inflates to gigabytes is refused at the declared size plus one chunk, not
 * after it has filled memory.
 */
async function inflateRawWithStreams(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ArchiveFormatError(
      'This archive is compressed, and this environment cannot decompress it. Use the original file.',
    );
  }

  const source = new Blob([data as BlobPart]).stream();
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = source.pipeThrough(new DecompressionStream('deflate-raw'));
  } catch {
    throw new ArchiveFormatError(
      'This archive is compressed, and this environment cannot decompress it. Use the original file.',
    );
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ArchiveFormatError('A ZIP entry inflates to more than its stated size.');
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof ArchiveFormatError) throw cause;
    throw new ArchiveFormatError('A ZIP entry could not be decompressed.');
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
