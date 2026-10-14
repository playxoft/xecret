/**
 * CRC-32 as ZIP uses it: ISO 3309 / ITU-T V.42, reflected polynomial
 * `0xEDB88320`, initial value and final XOR `0xFFFFFFFF` — what zlib's `crc32`
 * computes, and what Go's `hash/crc32.IEEE` computes.
 *
 * A checksum against accidental corruption, not an integrity control: anybody
 * altering an archive recomputes it. What protects the contents is AES-GCM.
 *
 * The table is built on first use rather than at module load, so importing this
 * module has no side effect a bundler would have to keep.
 */

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table !== null) return table;

  const built = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    built[n] = c >>> 0;
  }

  table = built;
  return built;
}

export function crc32(data: Uint8Array): number {
  const lookup = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = lookup[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
