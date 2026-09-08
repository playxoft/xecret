/**
 * Recovery codes, and the invite key fragment that shares their alphabet.
 *
 * Five recovery codes are generated at vault setup. Each independently wraps the
 * User Key, each is single-use, and using one invalidates the whole set. They
 * are the *only* recovery path: there is no escrow and no support-side reset, so
 * these strings are what stands between a forgotten passphrase and a permanently
 * unreadable vault. They are typed by a human, off a printed sheet, on the worst
 * day this product ever has — which is why the alphabet excludes `I`, `L`, `O`,
 * and `U`, and why there is a check character.
 *
 * ## The check character is a usability control, not a security one
 *
 * A code that passes the check is still verified by the server's lookup hash and
 * then by GCM authentication. What the check buys is *"that code has a typo"*
 * instead of *"invalid recovery code"* — which is the difference between a user
 * retyping one character and a user concluding their kit is worthless.
 *
 * Luhn mod 32 rather than Crockford's own mod-37 check symbol: mod 37 is
 * arithmetically stronger (37 is prime, so it catches all transpositions rather
 * than most), but it drags in five extra symbols — `*`, `~`, `$`, `=`, and `U` —
 * four of which are punctuation that is awkward on a phone keyboard, easy to
 * lose to a copy-paste that trims, and prone to mangling by the chat and email
 * clients an Emergency Kit passes through. One alphabet with one normalisation
 * rule is worth more than the extra transposition cases, for a control whose job
 * is a better error message.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §7 and §10.
 */

import { randomBytes } from '../encoding';
import type { Bytes } from '../types';
import { normalizedUtf8 } from './bytes';
import { deriveKey, HKDF_INFO } from './hkdf';

/** Crockford base32: 32 symbols, without `I`, `L`, `O`, or `U`. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 bytes with the top three bits cleared — a 125-bit value. */
export const RECOVERY_CODE_BYTES = 16;

/** Twenty-five base32 characters carry exactly 125 bits. */
export const RECOVERY_CODE_DATA_CHARS = 25;

/** The invite fragment uses all 128 bits, so it needs one more character. */
export const INVITE_FRAGMENT_DATA_CHARS = 26;

const DOMAIN_RECOVERY_LOOKUP = 'xecret.v2.recovery-lookup';

/**
 * Raised when a typed code cannot be read.
 *
 * `reason` separates the two cases a user experiences differently: `checksum`
 * means "you mistyped it, look again", `format` means "that is not one of our
 * codes at all". Distinguishing them is safe precisely because the check
 * character is not a security control — knowing a guess had a valid check digit
 * tells an attacker nothing about the 125 bits behind it.
 */
export class RecoveryCodeError extends Error {
  constructor(readonly reason: 'format' | 'checksum') {
    super(
      reason === 'checksum'
        ? 'That code has a typo — check it against your Emergency Kit'
        : 'That is not a valid code',
    );
    this.name = 'RecoveryCodeError';
  }
}

function symbolValue(character: string): number {
  const value = CROCKFORD_ALPHABET.indexOf(character);
  if (value < 0) throw new RecoveryCodeError('format');
  return value;
}

/**
 * Normalises typed input, forgiving exactly what Crockford specifies.
 *
 * In order: strip hyphens and Unicode whitespace, upper-case, then map `I` → 1,
 * `L` → 1, `O` → 0. Anything left outside the alphabet — including `U`, which is
 * excluded because it is confusable with `V` and which Crockford reserves for a
 * mod-37 check-symbol set this specification does not use — is a parse error.
 * `U` is rejected rather than aliased: it has no meaning here at all.
 */
export function normalizeCrockford(input: string): string {
  return input
    .replace(/[-\s]+/gu, '')
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

/**
 * The Luhn mod 32 check character over a run of data characters.
 *
 * Standard Luhn mod N at N = 32: it detects every single-character substitution
 * and the large majority of adjacent transpositions.
 */
export function luhnMod32(dataChars: string): string {
  let factor = 2;
  let sum = 0;

  for (let i = dataChars.length - 1; i >= 0; i -= 1) {
    let addend = factor * symbolValue(dataChars[i]!);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }

  return CROCKFORD_ALPHABET[(32 - (sum % 32)) % 32]!;
}

/** Validates data characters plus their trailing check character. */
export function isValidLuhnMod32(full: string): boolean {
  let factor = 1;
  let sum = 0;

  for (let i = full.length - 1; i >= 0; i -= 1) {
    let addend;
    try {
      addend = factor * symbolValue(full[i]!);
    } catch {
      return false;
    }
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }

  return sum % 32 === 0;
}

function encodeCrockford(bytes: Bytes, characters: number): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = '';
  for (let i = 0; i < characters; i += 1) {
    out = CROCKFORD_ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }

  if (value !== 0n) {
    throw new TypeError('Value does not fit in the requested number of characters');
  }
  return out;
}

function decodeCrockford(dataChars: string, byteLength: number): Bytes {
  let value = 0n;
  for (const character of dataChars) value = (value << 5n) | BigInt(symbolValue(character));

  const out = new Uint8Array(byteLength);
  for (let i = byteLength - 1; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }

  if (value !== 0n) {
    // 26 base32 characters can carry 130 bits while the seed holds 128, so a
    // string whose leading characters are too large does not name any fragment.
    // Truncating instead would accept two different strings as one seed.
    throw new RecoveryCodeError('format');
  }
  return out;
}

/** A code in every form the rest of the system needs it. */
export interface RecoveryCode {
  /** The canonical 16 bytes: the top three bits of byte 0 are zero. */
  codeBytes: Bytes;
  /** The 25 data characters, no hyphens. */
  dataChars: string;
  /** The Luhn mod-32 check character. */
  checkChar: string;
  /** `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-C` — the only form the UI may render. */
  displayForm: string;
}

/** `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-C` — five groups of five, then the check. */
function groupRecoveryCode(dataChars: string, checkChar: string): string {
  return [...(dataChars.match(/.{5}/g) ?? []), checkChar].join('-');
}

/**
 * `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XC` — the fragment's 26th data character shares
 * the last group with the check character, so the display stays six groups.
 */
function groupInviteFragment(dataChars: string, checkChar: string): string {
  const head = dataChars.slice(0, 25).match(/.{5}/g) ?? [];
  return [...head, dataChars.slice(25) + checkChar].join('-');
}

/**
 * Renders a recovery code from its canonical bytes.
 *
 * The check character gets its own display group on purpose: it is not part of
 * the secret, and a user comparing two codes should be able to see where the
 * entropy stops.
 */
export function encodeRecoveryCode(codeBytes: Bytes): RecoveryCode {
  if (codeBytes.length !== RECOVERY_CODE_BYTES) {
    throw new TypeError(`A recovery code is ${RECOVERY_CODE_BYTES} bytes`);
  }
  if ((codeBytes[0]! & 0xe0) !== 0) {
    // 125 bits, not 128: twenty-five base32 characters carry exactly 125, and 25
    // is what the five-group display holds. Padding to 26 would introduce two
    // meaningless bits that two implementations could encode differently.
    throw new TypeError('The top three bits of a recovery code must be zero');
  }

  const dataChars = encodeCrockford(codeBytes, RECOVERY_CODE_DATA_CHARS);
  const checkChar = luhnMod32(dataChars);

  return { codeBytes, dataChars, checkChar, displayForm: groupRecoveryCode(dataChars, checkChar) };
}

/** Generates one code: 125 bits of CSPRNG output, plus its check character. */
export function generateRecoveryCode(): RecoveryCode {
  const codeBytes = randomBytes(RECOVERY_CODE_BYTES);
  codeBytes[0] = codeBytes[0]! & 0x1f;
  return encodeRecoveryCode(codeBytes);
}

/** Generates the five codes issued together at setup. */
export function generateRecoveryCodes(count = 5): RecoveryCode[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/**
 * Parses a code a user typed.
 *
 * Accepts lower case, missing or extra hyphens, and the `I`/`L`/`O` confusables,
 * because those are what a human copying 26 characters off paper actually
 * produces. Rejects everything else, `U` included.
 */
export function parseRecoveryCode(input: string): RecoveryCode {
  if (typeof input !== 'string') throw new RecoveryCodeError('format');

  const normalized = normalizeCrockford(input);
  if (normalized.length !== RECOVERY_CODE_DATA_CHARS + 1) {
    throw new RecoveryCodeError('format');
  }

  const dataChars = normalized.slice(0, RECOVERY_CODE_DATA_CHARS);
  const checkChar = normalized.slice(RECOVERY_CODE_DATA_CHARS);

  for (const character of normalized) symbolValue(character);
  if (luhnMod32(dataChars) !== checkChar) throw new RecoveryCodeError('checksum');

  return {
    codeBytes: decodeCrockford(dataChars, RECOVERY_CODE_BYTES),
    dataChars,
    checkChar,
    displayForm: groupRecoveryCode(dataChars, checkChar),
  };
}

/**
 * The server's lookup value for one code.
 *
 * A fast hash is correct here, for the same reason `auth/tokens.ts` gives for
 * storing token hashes as plain SHA-256: the input is a 125-bit uniformly random
 * value with no structure to attack, so a slow KDF buys nothing and the lookup
 * stays a single indexed query. The domain-separation prefix ensures this digest
 * can never collide with another SHA-256 use over the same bytes.
 */
export async function recoveryLookupHash(codeBytes: Bytes): Promise<Bytes> {
  if (codeBytes.length !== RECOVERY_CODE_BYTES) {
    throw new TypeError(`A recovery code is ${RECOVERY_CODE_BYTES} bytes`);
  }

  const domain = normalizedUtf8(DOMAIN_RECOVERY_LOOKUP);
  const input = new Uint8Array(domain.length + codeBytes.length);
  input.set(domain, 0);
  input.set(codeBytes, domain.length);

  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/**
 * Derives the Recovery Code Key that unwraps this code's User Key wrap.
 *
 * Argon2 is deliberately not used: the input is 125 bits of uniform randomness,
 * not a passphrase, and a memory-hard KDF over it would cost the user a second
 * and an attacker nothing.
 */
export async function deriveRecoveryKey(codeBytes: Bytes): Promise<Bytes> {
  if (codeBytes.length !== RECOVERY_CODE_BYTES) {
    throw new TypeError(`A recovery code is ${RECOVERY_CODE_BYTES} bytes`);
  }
  return deriveKey({ ikm: codeBytes, info: HKDF_INFO.recoveryWrap });
}

/* ───────────────────────── invite key fragment ───────────────────────── */

/**
 * The invitation's second channel (spec §10).
 *
 * Same alphabet, same grouping, same check character as a recovery code, so one
 * normalisation routine and one "you mistyped this" message serve both. The seed
 * uses all 128 bits rather than 125 because there is no five-group display
 * convention to fit: six groups, `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XC`.
 */
export interface InviteFragment {
  seed: Bytes;
  dataChars: string;
  checkChar: string;
  displayForm: string;
}

/** The 16-byte seed for an invitation keypair, and its human form. */
export function generateInviteFragment(): InviteFragment {
  return encodeInviteFragment(randomBytes(16));
}

/** Renders an invite fragment from its seed. */
export function encodeInviteFragment(seed: Bytes): InviteFragment {
  if (seed.length !== 16) throw new TypeError('An invite fragment seed is 16 bytes');

  const dataChars = encodeCrockford(seed, INVITE_FRAGMENT_DATA_CHARS);
  const checkChar = luhnMod32(dataChars);

  return { seed, dataChars, checkChar, displayForm: groupInviteFragment(dataChars, checkChar) };
}

/** Parses a typed invite fragment. Normalisation is exactly §7.1. */
export function parseInviteFragment(input: string): InviteFragment {
  if (typeof input !== 'string') throw new RecoveryCodeError('format');

  const normalized = normalizeCrockford(input);
  if (normalized.length !== INVITE_FRAGMENT_DATA_CHARS + 1) {
    throw new RecoveryCodeError('format');
  }

  const dataChars = normalized.slice(0, INVITE_FRAGMENT_DATA_CHARS);
  const checkChar = normalized.slice(INVITE_FRAGMENT_DATA_CHARS);

  for (const character of normalized) symbolValue(character);
  if (luhnMod32(dataChars) !== checkChar) throw new RecoveryCodeError('checksum');

  return {
    seed: decodeCrockford(dataChars, 16),
    dataChars,
    checkChar,
    displayForm: groupInviteFragment(dataChars, checkChar),
  };
}
