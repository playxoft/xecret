/**
 * Argon2id: master passphrase → Stretched Key (`SK`).
 *
 * `SK` never leaves the client and is not itself a key. It is HKDF input keying
 * material for exactly two branches — the User Key wrap key and the unlock
 * verifier — and MUST NOT encrypt anything directly.
 *
 * ## The provider seam
 *
 * The Argon2id implementation is injectable, and `@noble/hashes` is the default.
 * ADR 0009's measurement section records why: pure-JS Argon2id costs ~963 ms at
 * the production parameters on a fast desktop core, which extrapolates past the
 * 1.5 s bar on a mid-range phone, and the ADR's stated expectation is that the
 * Phase 2 phone measurement moves this to `hash-wasm`. The two libraries produce
 * byte-identical output at the same parameters — that was checked, not assumed —
 * so the switch is a dependency change and not a migration. Naming the seam now
 * means it is also not a change to any caller.
 *
 * ## Parameter validation is a security control, not a sanity check
 *
 * `kdfParams` arrives from the server. A client that runs a memory-hard KDF with
 * unvalidated server-supplied cost parameters can be made to allocate arbitrary
 * memory by a hostile or compromised server, so {@link parseKdfParams} is
 * mandatory before {@link deriveStretchedKey} and is not optional anywhere.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §3.1.
 */

import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js';
import { randomBytes } from '../encoding';
import type { Bytes } from '../types';
import { copyBytes, normalizedUtf8 } from './bytes';

/** The Argon2 version byte, 0x13. Nothing else is accepted. */
export const ARGON2_VERSION = 19;

/** 16 bytes, random per user, stored in plaintext beside the wrap. */
export const KDF_SALT_BYTES = 16;

/**
 * The object stored in `user_keys.kdfParams`, with exactly these keys.
 *
 * `m` is in KiB, matching the RFC 9106 reference convention — the single most
 * common place two Argon2 implementations disagree by a factor of 1024.
 */
export interface Argon2idParams {
  alg: 'argon2id';
  v: typeof ARGON2_VERSION;
  m: number;
  t: number;
  p: number;
  len: number;
}

/** The parameters new records are written with (spec §3.1). */
export const CURRENT_KDF_PARAMS: Readonly<Argon2idParams> = Object.freeze({
  alg: 'argon2id',
  v: ARGON2_VERSION,
  m: 65_536,
  t: 3,
  p: 1,
  len: 32,
});

/**
 * The parameters a **device PIN** is stretched at.
 *
 * ── Why this is cheaper than {@link CURRENT_KDF_PARAMS}, and why that is not a
 * weakening ──
 * Argon2id's cost is what stands between a guess and a key, and against six
 * digits no achievable cost is enough: 10^6 candidates at a second each is a
 * fortnight on one core, and a GPU farm makes it an afternoon. So the PIN's
 * security does not come from here at all. It comes from the 32-byte
 * server-held pepper that `HKDF(pinKey ‖ pepper)` mixes in — without which the
 * wrap is not attackable at any cost — and from the five-attempt counter that
 * releases it (spec §13.3).
 *
 * What the stretch still buys is the case where the pepper *is* known: a
 * compromised server colluding with whoever holds the device. There the PIN is
 * all that is left, and a memory-hard KDF turns a trivial enumeration into a
 * paid one. Light parameters are the honest choice for that job, because a PIN
 * is typed several times a day on whatever phone is to hand and a second of
 * Argon2id per entry would simply stop the feature being used.
 *
 * `m` is the OWASP 2025 floor, which is also {@link parseKdfParams}'s lower
 * bound — so these parameters are the cheapest this client will run at all.
 */
export const DEVICE_PIN_KDF_PARAMS: Readonly<Argon2idParams> = Object.freeze({
  alg: 'argon2id',
  v: ARGON2_VERSION,
  m: 19_456,
  t: 2,
  p: 1,
  len: 32,
});

/**
 * Accepted ranges. The lower bound on `m` is the OWASP 2025 floor; a record
 * below it is either corrupt or hostile, and refusing is correct either way.
 */
const BOUNDS = {
  m: { min: 19_456, max: 1_048_576 },
  t: { min: 1, max: 10 },
} as const;

/** Raised when stored KDF parameters are not ones this client will run. */
export class KdfParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KdfParamsError';
  }
}

/**
 * An Argon2id implementation.
 *
 * Async so a WASM or worker-thread provider can be dropped in without changing a
 * caller; the default is synchronous inside and simply resolves.
 */
export type Argon2idProvider = (
  password: Bytes,
  salt: Bytes,
  params: Argon2idParams,
) => Promise<Bytes>;

/**
 * The default provider, `@noble/hashes`.
 *
 * Exported because it is the seam's reference implementation — and because it is
 * the raw primitive, with no policy attached. {@link deriveStretchedKey} is
 * where the parameter bounds are enforced; a caller reaching for this directly
 * (the test-vector generator does, at deliberately cheap parameters) is asking
 * for Argon2id the function, not for xecret's passphrase policy.
 */
export const nobleArgon2idProvider: Argon2idProvider = (password, salt, params) =>
  Promise.resolve(
    copyBytes(
      nobleArgon2id(password, salt, {
        t: params.t,
        m: params.m,
        p: params.p,
        version: params.v,
        dkLen: params.len,
      }),
    ),
  );

function assertInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new KdfParamsError(`kdfParams.${label} must be an integer`);
  }
  return value;
}

/**
 * Validates stored parameters and returns them narrowed.
 *
 * Rejects unknown keys as well as out-of-range values: the stored object is
 * specified as having exactly six fields, and a seventh is a record this client
 * does not understand well enough to run a KDF from.
 */
export function parseKdfParams(value: unknown): Argon2idParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KdfParamsError('kdfParams must be an object');
  }

  const candidate = value as Record<string, unknown>;
  const allowed = ['alg', 'v', 'm', 't', 'p', 'len'];
  for (const key of Object.keys(candidate)) {
    if (!allowed.includes(key)) {
      throw new KdfParamsError('kdfParams carries a field this client does not understand');
    }
  }

  if (candidate['alg'] !== 'argon2id') {
    // Argon2i and Argon2d are different functions; accepting either would derive
    // a different key from the same passphrase.
    throw new KdfParamsError('kdfParams.alg must be "argon2id"');
  }

  if (assertInteger(candidate['v'], 'v') !== ARGON2_VERSION) {
    throw new KdfParamsError(`kdfParams.v must be ${ARGON2_VERSION}`);
  }

  const m = assertInteger(candidate['m'], 'm');
  if (m < BOUNDS.m.min || m > BOUNDS.m.max) {
    throw new KdfParamsError('kdfParams.m is outside the accepted range');
  }

  const t = assertInteger(candidate['t'], 't');
  if (t < BOUNDS.t.min || t > BOUNDS.t.max) {
    throw new KdfParamsError('kdfParams.t is outside the accepted range');
  }

  if (assertInteger(candidate['p'], 'p') !== 1) {
    // Browsers run this single-threaded. A record asking for more lanes was not
    // written by a client of this system.
    throw new KdfParamsError('kdfParams.p must be 1');
  }

  if (assertInteger(candidate['len'], 'len') !== 32) {
    throw new KdfParamsError('kdfParams.len must be 32');
  }

  return { alg: 'argon2id', v: ARGON2_VERSION, m, t, p: 1, len: 32 };
}

/**
 * Whether a stored record should be re-derived at the current parameters.
 *
 * `!==`, not `<`, deliberately — the same reasoning as `pinNeedsRehash` in
 * `auth/pin.ts`. An upgrade must also be able to *lower* a cost, if a parameter
 * was ever set to a value some platform cannot reach.
 */
export function kdfNeedsUpgrade(params: Argon2idParams): boolean {
  return (
    params.alg !== CURRENT_KDF_PARAMS.alg ||
    params.v !== CURRENT_KDF_PARAMS.v ||
    params.m !== CURRENT_KDF_PARAMS.m ||
    params.t !== CURRENT_KDF_PARAMS.t ||
    params.p !== CURRENT_KDF_PARAMS.p ||
    params.len !== CURRENT_KDF_PARAMS.len
  );
}

/** A fresh 16-byte salt for a new or upgraded record. */
export function generateKdfSalt(): Bytes {
  return randomBytes(KDF_SALT_BYTES);
}

/**
 * Derives the Stretched Key from a master passphrase.
 *
 * The passphrase is NFC-normalised before encoding, without exception: the same
 * passphrase typed on macOS and on Windows must derive the same key, and it does
 * not unless both sides normalise.
 */
export async function deriveStretchedKey(params: {
  passphrase: string;
  salt: Bytes;
  /**
   * As stored — `unknown` on purpose, so the record straight off the wire is the
   * natural thing to pass. Validated here even if the caller validated it too.
   */
  params: unknown;
  /** Defaults to `@noble/hashes`. See the module header. */
  argon2id?: Argon2idProvider;
}): Promise<Bytes> {
  const kdfParams = parseKdfParams(params.params);

  if (params.salt.length !== KDF_SALT_BYTES) {
    throw new KdfParamsError(`kdfSalt must be ${KDF_SALT_BYTES} bytes`);
  }

  const password = normalizedUtf8(params.passphrase);
  const argon2 = params.argon2id ?? nobleArgon2idProvider;

  try {
    return await argon2(password, params.salt, kdfParams);
  } finally {
    // The passphrase bytes are the most valuable material in the system; they do
    // not need to outlive this call. The original string is still in the
    // caller's hands, and JavaScript strings cannot be wiped — see
    // `encoding.ts`'s note on what zeroization does and does not buy.
    password.fill(0);
  }
}
