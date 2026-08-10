/**
 * UUIDv7 generation, per RFC 9562 §5.7.
 *
 * Layout (128 bits):
 *
 *   ┌────────────────────────────┬──────┬────────┬─────┬──────────────┐
 *   │ unix_ts_ms (48)            │ ver  │ rand_a │ var │ rand_b (62)  │
 *   │                            │ (4)  │ (12)   │ (2) │              │
 *   └────────────────────────────┴──────┴────────┴─────┴──────────────┘
 *
 * Why UUIDv7 rather than v4: the leading 48-bit timestamp makes identifiers
 * time-ordered, which keeps B-tree index inserts local instead of scattering
 * writes across the whole index. On tables that only ever grow — `secret_versions`
 * and `audit_logs` in particular — that difference compounds. Unlike a serial
 * integer, the value is still unguessable, so an identifier appearing in a URL
 * leaks neither row count nor creation order relative to other tenants.
 *
 * `rand_a` is used as a sub-millisecond counter (RFC 9562 §6.2 "Method 1"), which
 * guarantees that two IDs generated in the same millisecond still sort in
 * creation order. Without it, ordering within a millisecond would be random, and
 * `ORDER BY id` would silently disagree with `ORDER BY created_at`.
 *
 * This is an identifier format, not a cryptographic primitive: the randomness
 * comes from `crypto.getRandomValues`, and nothing here is invented. See
 * CONTRIBUTING.md — "never invent cryptography" is about algorithms, not about
 * assembling a documented, standardised byte layout.
 */

import type { Bytes } from '../crypto/types';

/** Highest value `rand_a` can hold (12 bits). */
const COUNTER_MAX = 0x0fff;

/**
 * Ceiling for a freshly seeded counter.
 *
 * Seeding randomly rather than at zero avoids leaking how many identifiers were
 * generated in a given millisecond. Seeding into the low quarter of the range
 * leaves at least 3,072 increments before overflow, which no realistic
 * single-millisecond burst will exhaust.
 */
const COUNTER_SEED_MAX = 0x03ff;

let lastTimestamp = -1;
let counter = 0;

/** Injected in tests to make timestamp behaviour deterministic. */
let now: () => number = Date.now;

/**
 * Generates a UUIDv7 as a canonical lowercase hyphenated string.
 *
 * Monotonic: two calls within the same millisecond produce values that sort in
 * call order.
 */
export function uuidv7(): string {
  return formatUuid(uuidv7Bytes());
}

/** Generates a UUIDv7 as raw bytes, for callers that want the 16-byte form. */
export function uuidv7Bytes(): Bytes {
  const timestamp = now();

  if (timestamp > lastTimestamp) {
    lastTimestamp = timestamp;
    counter = randomUint16() & COUNTER_SEED_MAX;
  } else {
    // Same millisecond, or a clock that moved backwards. In both cases keep
    // advancing the counter so ordering is preserved regardless of the clock.
    counter += 1;

    if (counter > COUNTER_MAX) {
      // Exhausted the counter. Borrow from the timestamp rather than blocking or
      // emitting a non-monotonic value; the drift is at most a few milliseconds
      // and self-corrects as soon as the wall clock catches up.
      lastTimestamp += 1;
      counter = randomUint16() & COUNTER_SEED_MAX;
    }
  }

  const bytes = new Uint8Array(16);

  // 48-bit big-endian millisecond timestamp.
  const ts = lastTimestamp;
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  // Version 7 in the high nibble of byte 6, counter in the remaining 12 bits.
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  // 62 bits of fresh randomness, with the RFC 4122 variant in the top two bits.
  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  bytes[8] = (random[0]! & 0x3f) | 0x80;
  for (let i = 1; i < 8; i += 1) {
    bytes[8 + i] = random[i]!;
  }

  return bytes;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Formats 16 bytes as a canonical hyphenated UUID string. */
export function formatUuid(bytes: Bytes): string {
  if (bytes.length !== 16) {
    throw new TypeError(`A UUID is 16 bytes, received ${bytes.length}`);
  }

  let out = '';
  for (let i = 0; i < 16; i += 1) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += HEX[bytes[i]!];
  }
  return out;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * True if the value is a canonical lowercase UUID string.
 *
 * Deliberately strict: uppercase, braced, and URN forms are rejected rather than
 * normalised. Identifiers arriving from a client are compared against database
 * values, and silently accepting several spellings of the same identifier is how
 * inconsistent-comparison bugs start.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Extracts the embedded creation timestamp, in milliseconds. */
export function uuidv7Timestamp(uuid: string): number {
  if (!isUuid(uuid)) {
    throw new TypeError('Not a canonical UUID string');
  }
  return Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
}

function randomUint16(): number {
  const buf = new Uint8Array(2);
  crypto.getRandomValues(buf);
  return (buf[0]! << 8) | buf[1]!;
}

/**
 * Test seam: overrides the clock and resets monotonic state.
 *
 * Exported for tests only — production code must never call this. Kept in the
 * module rather than injected through every call site so the public API stays a
 * zero-argument function.
 *
 * @internal
 */
export function __setClockForTesting(clock: (() => number) | null): void {
  now = clock ?? Date.now;
  lastTimestamp = -1;
  counter = 0;
}
