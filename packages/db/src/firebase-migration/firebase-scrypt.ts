import { createCipheriv, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Firebase's password hashing, and the PHC string WorkOS imports it as.
 *
 * Operator tooling for the one-off Firebase → WorkOS user import
 * (`scripts/migrate-users-to-workos.ts`, `docs/operations/workos-user-migration.md`).
 * Node-only, and never imported by the application: nothing in `apps/web`
 * reaches this directory, and it is not exported from the package.
 *
 * ── The algorithm (Firebase's scrypt fork) ──
 *
 *   key  = scrypt(password, salt ‖ saltSeparator, N = 2^memCost, r = rounds, p = 1)[0..32]
 *   hash = AES-256-CTR(key, iv = 0¹²⁸).encrypt(signerKey)
 *
 * The signer key, salt separator, rounds and memory cost are per *project*
 * (Firebase console → Authentication → password hash parameters); the salt and
 * hash are per *user* (`firebase auth:export`). This module computes a hash
 * for two checks only, and the import itself never does: it forwards
 * Firebase's.
 *
 *  - `--check-hash-params` recomputes one real user's exported hash from their
 *    password ({@link verifyFirebasePassword}). It is the only check that can
 *    catch a wrong signer key, separator, rounds or memory cost: every other
 *    one is self-consistent, and would pass with the wrong project's values.
 *  - `--self-test` proves a WorkOS environment verifies the PHC string built
 *    below the way Firebase would.
 *
 * ── The PHC string (WorkOS's documented format) ──
 *
 *   $firebase-scrypt$v=1$r=<rounds>,m=<memCost>,ss=<B64 ss>,sk=<B64 sk>$<B64 salt>$<B64 hash>
 *
 * per https://workos.com/docs/migrate/firebase (verified 2026-10-12): the
 * project parameters ride in the PHC parameters, and every binary field is
 * PHC "B64" — standard base64 with the padding removed.
 */

/**
 * Firebase's own published example: the project parameters and the exported
 * user in https://github.com/firebase/scrypt's README (WorkOS's migration
 * guide quotes the same signer key, salt and hash). A public specimen — the
 * signer key belongs to no real project. gitleaks 8.30.1 does not flag these
 * values (checked when they were added); if a later rule does, allowlist them
 * by exact value in `.gitleaks.toml`, as the other public specimens are. The
 * unit tests and the self-test both check this implementation against it
 * before it is trusted with anything else.
 */
export const FIREBASE_SCRYPT_PUBLISHED_EXAMPLE = {
  signerKey:
    'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
  saltSeparator: 'Bw==',
  rounds: 8,
  memCost: 14,
  salt: '42xEC+ixf3L2lw==',
  password: 'user1password',
  hash: 'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==',
} as const;

/** A project's Firebase scrypt parameters, decoded. Never log any field. */
export interface FirebaseScryptParams {
  readonly signerKey: Uint8Array;
  readonly saltSeparator: Uint8Array;
  readonly rounds: number;
  readonly memCost: number;
}

/** The environment variables the parameters are read from (Phase.dev). */
export const FIREBASE_SCRYPT_ENV = {
  signerKey: 'FIREBASE_SCRYPT_SIGNER_KEY',
  saltSeparator: 'FIREBASE_SCRYPT_SALT_SEPARATOR',
  rounds: 'FIREBASE_SCRYPT_ROUNDS',
  memCost: 'FIREBASE_SCRYPT_MEM_COST',
} as const;

/**
 * Decodes base64 in either alphabet, padded or not, and refuses anything else.
 *
 * Firebase hands these out as standard base64 and its REST API as base64url;
 * `firebase auth:export` normalises the per-user fields to standard, but a
 * strict decoder that refused one of them would fail on the other for no gain.
 * What it does refuse is anything that is not base64 at all, because Node's
 * own decoder silently skips invalid characters, and a parameter that quietly
 * lost a character is a hash that never verifies.
 *
 * `label` names the field in the error; the value never appears in it.
 */
export function decodeBase64(value: string, label: string): Uint8Array {
  const body = value.replace(/=+$/, '');
  if (body.length === 0 || !/^[A-Za-z0-9+/_-]+$/.test(body) || body.length % 4 === 1) {
    throw new Error(`${label} is not valid base64.`);
  }
  return new Uint8Array(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64'));
}

/** PHC "B64": standard base64 alphabet, no padding. */
export function phcB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
}

function parseIntegerParam(raw: string | undefined, name: string, min: number, max: number) {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`${name} is not set.`);
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer.`);
  }
  const value = Number(raw.trim());
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

/**
 * Reads and validates the project parameters from an environment.
 *
 * Ranges are Firebase's own for the scrypt hash (`rounds` 1–8, `mem_cost`
 * 1–14); every Firebase project's real values are 8 and 14. Errors name the
 * variable, never its value.
 */
export function parseFirebaseScryptParams(
  env: Readonly<Record<string, string | undefined>>,
): FirebaseScryptParams {
  const signerKeyRaw = env[FIREBASE_SCRYPT_ENV.signerKey];
  const separatorRaw = env[FIREBASE_SCRYPT_ENV.saltSeparator];
  if (!signerKeyRaw) throw new Error(`${FIREBASE_SCRYPT_ENV.signerKey} is not set.`);
  if (!separatorRaw) throw new Error(`${FIREBASE_SCRYPT_ENV.saltSeparator} is not set.`);
  return {
    signerKey: decodeBase64(signerKeyRaw.trim(), FIREBASE_SCRYPT_ENV.signerKey),
    saltSeparator: decodeBase64(separatorRaw.trim(), FIREBASE_SCRYPT_ENV.saltSeparator),
    rounds: parseIntegerParam(env[FIREBASE_SCRYPT_ENV.rounds], FIREBASE_SCRYPT_ENV.rounds, 1, 8),
    memCost: parseIntegerParam(
      env[FIREBASE_SCRYPT_ENV.memCost],
      FIREBASE_SCRYPT_ENV.memCost,
      1,
      14,
    ),
  };
}

/**
 * Firebase's scrypt hash of `password` under `salt`. For the self-test only.
 *
 * The derived key is truncated to 32 bytes for AES-256. scrypt's last step is
 * PBKDF2, whose output blocks are independent, so these 32 bytes are the same
 * whether 32 or Firebase's 64 are derived.
 */
export function firebaseScryptHash(
  password: string,
  salt: Uint8Array,
  params: FirebaseScryptParams,
): Uint8Array {
  const N = 2 ** params.memCost;
  const key = scryptSync(
    Buffer.from(password, 'utf8'),
    Buffer.concat([salt, params.saltSeparator]),
    32,
    { N, r: params.rounds, p: 1, maxmem: 256 * N * params.rounds },
  );
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16, 0));
  return new Uint8Array(Buffer.concat([cipher.update(params.signerKey), cipher.final()]));
}

/** Whether {@link firebaseScryptHash} reproduces Firebase's published example. */
export function matchesPublishedExample(): boolean {
  const example = FIREBASE_SCRYPT_PUBLISHED_EXAMPLE;
  const params = parseFirebaseScryptParams({
    [FIREBASE_SCRYPT_ENV.signerKey]: example.signerKey,
    [FIREBASE_SCRYPT_ENV.saltSeparator]: example.saltSeparator,
    [FIREBASE_SCRYPT_ENV.rounds]: String(example.rounds),
    [FIREBASE_SCRYPT_ENV.memCost]: String(example.memCost),
  });
  const hash = firebaseScryptHash(example.password, decodeBase64(example.salt, 'salt'), params);
  return phcB64(hash) === example.hash.replace(/=+$/, '');
}

/**
 * Whether `password` is the one Firebase hashed into `hash` under `salt`,
 * with these project parameters. Constant-time in the comparison.
 *
 * A `false` cannot say which of the two is wrong — the password or the
 * parameters — and that is fine: the check is run with a password the operator
 * knows to be right, so a mismatch indicts the parameters.
 */
export function verifyFirebasePassword(
  password: string,
  stored: { readonly hash: Uint8Array; readonly salt: Uint8Array },
  params: FirebaseScryptParams,
): boolean {
  const computed = firebaseScryptHash(password, stored.salt, params);
  return computed.length === stored.hash.length && timingSafeEqual(computed, stored.hash);
}

/**
 * A fingerprint of the project parameters: SHA-256 over a length-prefixed
 * encoding of all four. It names *which* parameters a check verified, so that
 * a verification recorded for one set does not vouch for another. One-way, and
 * of a 64-byte random key: it reveals nothing usable. Stored in the
 * verification marker, never printed.
 */
export function hashParamsFingerprint(params: FirebaseScryptParams): string {
  const digest = createHash('sha256');
  digest.update('xecret.firebase-scrypt-params.v1');
  for (const part of [params.signerKey, params.saltSeparator]) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part.length);
    digest.update(length);
    digest.update(part);
  }
  digest.update(`|r=${params.rounds}|m=${params.memCost}`);
  return digest.digest('hex');
}

/**
 * The PHC string WorkOS accepts as `password_hash` with
 * `password_hash_type: 'firebase-scrypt'`.
 *
 * Refuses a hash whose length differs from the signer key's: the hash *is* the
 * signer key encrypted under a stream cipher, so the two are always the same
 * length, and a mismatch means the export and the parameters came from
 * different projects (or the hash is not a Firebase scrypt hash at all). That
 * user's password would never verify — better to know now than at their
 * first sign-in.
 */
export function firebaseScryptPhc(
  hash: Uint8Array,
  salt: Uint8Array,
  params: FirebaseScryptParams,
): string {
  if (hash.length !== params.signerKey.length) {
    throw new Error(
      'Password hash length does not match the signer key: the export and the hash parameters are from different projects.',
    );
  }
  if (salt.length === 0) {
    throw new Error('Password salt is empty.');
  }
  const parameters = [
    `r=${params.rounds}`,
    `m=${params.memCost}`,
    `ss=${phcB64(params.saltSeparator)}`,
    `sk=${phcB64(params.signerKey)}`,
  ].join(',');
  return `$firebase-scrypt$v=1$${parameters}$${phcB64(salt)}$${phcB64(hash)}`;
}
