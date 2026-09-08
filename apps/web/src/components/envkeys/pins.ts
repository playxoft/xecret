/**
 * Trust-on-first-use pinning for the public keys this browser seals to.
 *
 * ── The attack this is about ──
 * A grant is sealed to a public key the *server* supplied. A malicious or
 * compromised server can therefore answer `GET …/keys/recipients` with a key it
 * holds the private half of, wait for an administrator to rotate, and read
 * everything written afterwards — while every screen in the product reports a
 * successful rotation. Signatures do not close this on their own: verifying a
 * grant signature needs a trusted signer key, which is the same substitution
 * problem one level up (ADR 0009, trade-off 3).
 *
 * What closes it in practice is *continuity*. The first time this browser sees a
 * principal's key it records it; every time afterwards it compares. A server
 * that substitutes a key has to do it in front of somebody who has sealed to the
 * real one before, and that person is shown a warning naming the person whose
 * key changed. It does not stop a first-contact substitution, and it does not
 * pretend to — the honest guarantee is "this key is not the one you used last
 * time", which is exactly the sentence a human can act on.
 *
 * ── Why `localStorage` here, when the vault forbids it everywhere else ──
 * `key-store.ts` is emphatic that nothing key-shaped is written to disk, and
 * that rule is about **secrets**. These are public keys. Writing one to disk
 * discloses nothing that the server did not just send in a response, and the
 * whole value of a pin is that it survives the page reload — a pin held in
 * memory is a pin that compares each key against itself. Per-origin storage is
 * also the correct scope: a pin is a statement about what *this browser* has
 * seen.
 *
 * ── Versioned key, and why ──
 * The record shape will change (a pin will eventually carry the signing key and
 * a "verified out of band" flag). Reading a future shape as though it were this
 * one would produce false mismatch warnings, which is the one failure mode that
 * teaches people to ignore the warning. A version in the storage key means an
 * older build and a newer one keep separate books instead.
 */

import { CROCKFORD_ALPHABET } from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';

/** Bump when the record shape changes. Old pins are then simply not found. */
const STORAGE_KEY = 'xecret.pins.v1';

/** How a pin is filed: the kind, then the id. Both are `[0-9a-z-]`. */
export type PinnedKind = 'member' | 'token';

export interface Pin {
  /** base64url of the 32-byte public key, exactly as the API served it. */
  publicKey: string;
  /** ISO 8601. Shown in the warning: "you first saw this key on …". */
  firstSeen: string;
}

export type PinStore = Readonly<Record<string, Pin>>;

/**
 * What comparing a key against the book produced.
 *
 * Three outcomes rather than a boolean, because they call for three different
 * screens: silence, a quiet "first time" note, and a warning that stops a
 * rotation until somebody looks at it.
 */
export type PinCheck =
  | { status: 'new' }
  | { status: 'match'; firstSeen: string }
  | { status: 'changed'; pinned: string; firstSeen: string };

export function pinKey(kind: PinnedKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Reads the book.
 *
 * Every failure — no `localStorage` (a hardened browser, a private window in
 * some configurations), unparseable JSON, a value that is not an object —
 * returns an empty book rather than throwing. A pin store that cannot be read is
 * a store with no pins in it, and the UI then reports first contact, which is
 * the true statement: this browser has no record.
 */
export function readPins(storage: Storage | null = defaultStorage()): PinStore {
  if (storage === null) return {};

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const pins: Record<string, Pin> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate['publicKey'] !== 'string') continue;
    pins[key] = {
      publicKey: candidate['publicKey'],
      firstSeen:
        typeof candidate['firstSeen'] === 'string'
          ? candidate['firstSeen']
          : '1970-01-01T00:00:00Z',
    };
  }

  return pins;
}

/**
 * Compares one key against the book, without writing.
 *
 * Pure, and separate from {@link recordPin}, because the two happen at different
 * moments: every screen that lists principals checks, and only an act the user
 * has actually gone through with — a rotation, a share — writes. Checking on
 * render and recording on render would pin whatever the server said the first
 * time a page loaded, which is a pin nobody ever consented to.
 */
export function checkPin(
  pins: PinStore,
  kind: PinnedKind,
  id: string,
  publicKey: string,
): PinCheck {
  const pinned = pins[pinKey(kind, id)];
  if (pinned === undefined) return { status: 'new' };
  if (pinned.publicKey === publicKey) return { status: 'match', firstSeen: pinned.firstSeen };
  return { status: 'changed', pinned: pinned.publicKey, firstSeen: pinned.firstSeen };
}

/**
 * The book with one key recorded, or the same book when it was already there.
 *
 * Returns a new store rather than mutating, so the caller decides whether to
 * persist — and so this can be tested without a `Storage`. **A changed key is
 * not overwritten**: accepting a substitution silently is precisely the outcome
 * the warning exists to prevent, and re-pinning is a deliberate act
 * ({@link replacePin}) taken by somebody who has read the warning.
 */
export function recordPin(
  pins: PinStore,
  kind: PinnedKind,
  id: string,
  publicKey: string,
  now: Date = new Date(),
): PinStore {
  const key = pinKey(kind, id);
  if (pins[key] !== undefined) return pins;
  return { ...pins, [key]: { publicKey, firstSeen: now.toISOString() } };
}

/** Accepts a changed key, on purpose, after somebody has read the warning. */
export function replacePin(
  pins: PinStore,
  kind: PinnedKind,
  id: string,
  publicKey: string,
  now: Date = new Date(),
): PinStore {
  return { ...pins, [pinKey(kind, id)]: { publicKey, firstSeen: now.toISOString() } };
}

/** Persists the book. Silent on failure — see {@link readPins}. */
export function writePins(pins: PinStore, storage: Storage | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Quota, or a browser that refuses storage. A pin that could not be written
    // degrades to "first contact next time", which over-warns rather than
    // under-warns and is the right direction to fail in.
  }
}

function defaultStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The short human-comparable form of a public key.
 *
 * ── The format, and why this one ──
 * The spec defines no fingerprint, so one is chosen here and stated in full:
 *
 *     SHA-256(publicKey) → Crockford base32 → first 8 characters → "XXXX-XXXX"
 *
 * Crockford rather than hex or standard base32 because this product already
 * reads codes aloud in that alphabet — recovery codes and the invite fragment
 * are both Crockford (spec §7.1, §10) — so there is one alphabet to explain, one
 * set of confusable characters already excluded (`I`, `L`, `O`, `U`), and one
 * normalisation routine. Eight characters is 40 bits: far too short to be a
 * cryptographic commitment, and it is not used as one. It is a *comparison aid*
 * for a human reading two strings side by side, and the actual decision — has
 * this key changed — is made by {@link checkPin} against the full 32 bytes.
 *
 * The hyphen is display only. Nothing parses this.
 */
export async function fingerprint(publicKey: Bytes): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
  const encoded = crockford(digest, 8);
  return `${encoded.slice(0, 4)}-${encoded.slice(4)}`;
}

/**
 * The first `chars` Crockford symbols of a byte string, big-endian.
 *
 * Bit-by-bit rather than by `BigInt` or a chunked table: eight characters is 40
 * bits, which is not a byte multiple, and every shortcut for that case is a
 * place to get the padding direction wrong. `recovery.ts` encodes whole values
 * and cannot be reused for a truncation.
 */
function crockford(bytes: Bytes, chars: number): string {
  let out = '';
  let bits = 0;
  let accumulator = 0;

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(accumulator >> bits) & 31];
      if (out.length === chars) return out;
    }
  }

  // Unreachable for a 32-byte digest and any `chars` ≤ 51, but a partial group
  // is padded with zero bits rather than dropped, so the function is total.
  if (bits > 0 && out.length < chars) {
    out += CROCKFORD_ALPHABET[(accumulator << (5 - bits)) & 31];
  }
  return out.slice(0, chars);
}
