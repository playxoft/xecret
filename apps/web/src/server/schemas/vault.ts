import * as z from 'zod/mini';
import { toBase64Url } from '@xecret/core/crypto';
import { toBytes } from '@xecret/db/repositories';
import type { PasskeyRecord, PinDeviceRecord, VaultRecord } from '@xecret/db/repositories';
import { uuidField } from './ids';

/**
 * The request schemas and response shapes of the vault routes.
 *
 * ── The rule that governs this file ──
 * **The server validates shape, never meaning.** Every cryptographic value below
 * is checked for its prefix, its alphabet and its length, and then stored or
 * returned verbatim. Nothing here decodes a blob, derives a key, or compares a
 * plaintext, because the server holds no key with which it could — and a
 * validator that "helpfully" parsed a wrap would be the first line of the code
 * path that ADR 0009 exists to make impossible.
 *
 * That is not laziness dressed up as principle. A length and a prefix are
 * exactly the checks a party with no key *can* make, and they are enough for
 * what they are for: keeping a malformed or oversized body out of the database,
 * so a column cannot come to hold something no client will ever parse.
 *
 * The real validation happens twice, in the two places that can do it. The
 * client refuses a blob it cannot parse (`parseBlob` rejects unknown versions
 * loudly), and AES-GCM refuses one whose AAD or key is wrong. Between them, a
 * value that passes these schemas and is still wrong fails closed at the only
 * point where failing means anything.
 *
 * The same rules as the other schema files otherwise: bodies are `strictObject`
 * with a fixed unknown-field message, and the serialisers list their fields, so
 * a column added to `user_keys` later cannot reach a client by accident.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

/**
 * Base64url, unpadded, per RFC 4648 §5 — the encoding every binary value in this
 * API travels as.
 *
 * The character class excludes `=` deliberately: padding is not part of the
 * encoding the crypto layer emits (`toBase64Url`), and accepting it here would
 * let two spellings of one value into the database, where a `bytea` equality
 * lookup would then miss one of them.
 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The unpadded base64url length of exactly `bytes` bytes.
 *
 * Length is checked on the *encoding* rather than by decoding, so a hostile body
 * is refused before anything allocates a buffer for it. The arithmetic is exact:
 * unpadded base64url is `ceil(n * 4 / 3)` characters, and no other byte count
 * produces that length.
 */
function base64UrlBytes(bytes: number, message: string) {
  const length = Math.ceil((bytes * 4) / 3);
  return z.string().check(z.regex(BASE64URL, message), z.length(length, message));
}

/** Base64url of a variable-length value, bounded at both ends. */
function base64UrlBetween(minBytes: number, maxBytes: number, message: string) {
  return z
    .string()
    .check(
      z.regex(BASE64URL, message),
      z.minLength(Math.ceil((minBytes * 4) / 3), message),
      z.maxLength(Math.ceil((maxBytes * 4) / 3), message),
    );
}

const MALFORMED_BLOB = 'That value is not a well-formed xk2 blob.';

/**
 * The shortest and longest `xk2.gcm.` blob this endpoint will accept.
 *
 * The floor is the format's own minimum — `iv(12) ‖ tag(16)`, an empty
 * plaintext — so a truncated blob is refused rather than stored. The ceiling is
 * generous rather than exact: every wrap this version writes is a 32-byte
 * plaintext, which is 88 characters, and pinning the bound to that would make a
 * future construction with a slightly larger payload a server change as well as
 * a client one. 512 is far above anything the format defines and far below a
 * size at which this column becomes a place to hide a payload.
 */
const MIN_GCM_BLOB_LENGTH = 'xk2.gcm.'.length + Math.ceil((28 * 4) / 3);
const MAX_GCM_BLOB_LENGTH = 512;

/**
 * An `xk2.gcm.` blob: a prefix, and base64url after it.
 *
 * Checked with a regular expression rather than by calling `parseBlob`, and the
 * distinction is the whole point of this module. `parseBlob` is the *client's*
 * parser; it decodes, and decoding a wrap is a step the server must not have a
 * function for. The two agree on what a well-formed blob looks like because both
 * follow spec §2, and they disagree about nothing else because this one stops
 * at the prefix.
 */
const gcmBlobSchema = z
  .string()
  .check(
    z.regex(/^xk2\.gcm\.[A-Za-z0-9_-]+$/, MALFORMED_BLOB),
    z.minLength(MIN_GCM_BLOB_LENGTH, MALFORMED_BLOB),
    z.maxLength(MAX_GCM_BLOB_LENGTH, MALFORMED_BLOB),
  );

/** A 32-byte X25519 or Ed25519 public key. */
const publicKeySchema = base64UrlBytes(32, 'A public key is 32 bytes, base64url encoded.');

/** The 16-byte Argon2id salt (spec §3.1). */
const kdfSaltSchema = base64UrlBytes(16, 'A KDF salt is 16 bytes, base64url encoded.');

/** `HKDF(SK, "", "xecret.v2.unlock-verifier", 32)` — never `SK`, never a wrap key. */
const unlockVerifierSchema = base64UrlBytes(
  32,
  'An unlock verifier is 32 bytes, base64url encoded.',
);

/**
 * `HKDF(UK, "", "xecret.v2.uk-unlock-verifier", 32)` — the proof an unlock that
 * never derived `SK` presents instead (spec §8.2).
 *
 * Structurally identical to the passphrase verifier and semantically distinct,
 * which is exactly why the two travel under different field names and are stored
 * in different columns. The shapes cannot tell them apart; the field name is
 * what says which branch a value came from, and the server compares it against
 * the matching digest and no other.
 */
const ukUnlockVerifierSchema = base64UrlBytes(
  32,
  'An unlock verifier is 32 bytes, base64url encoded.',
);

/** `SHA-256("xecret.v2.recovery-lookup" ‖ codeBytes)` (spec §7.5). */
const lookupHashSchema = base64UrlBytes(32, 'A lookup hash is 32 bytes, base64url encoded.');

/**
 * Argon2id parameters, bounded to the range spec §3.1 defines.
 *
 * The specification calls this validation a *client-side* control, because the
 * attack it names is a hostile server ordering a browser to allocate a gigabyte.
 * It is enforced here as well, against the mirror image: these values arrive
 * from a client and are handed back to that same account's future sessions, so
 * an unbounded `m` written once is a denial of service against the one person
 * who can never work around it. Neither check makes the other redundant — they
 * defend against different parties.
 */
const kdfParamsSchema = z.strictObject(
  {
    alg: z.literal('argon2id'),
    v: z.literal(19),
    /** KiB. The floor is the OWASP 2025 minimum; the ceiling is 1 GiB. */
    m: z.int().check(z.gte(19_456), z.lte(1_048_576)),
    t: z.int().check(z.gte(1), z.lte(10)),
    /** Browsers derive on one thread, so this is not a range. */
    p: z.literal(1),
    len: z.literal(32),
  },
  UNEXPECTED_FIELD,
);

/**
 * How many recovery codes a kit holds (spec §7).
 *
 * Exactly five, checked rather than merely bounded. A client that uploaded four
 * would leave its owner one code short of the kit they were shown and printed;
 * one that uploaded fifty would turn a lookup table into a place to store data.
 */
export const RECOVERY_CODE_COUNT = 5;

const recoveryWrapSchema = z.strictObject(
  { lookupHash: lookupHashSchema, wrap: gcmBlobSchema },
  UNEXPECTED_FIELD,
);

const recoveryWrapsSchema = z
  .array(recoveryWrapSchema)
  .check(
    z.length(RECOVERY_CODE_COUNT, `A recovery kit holds exactly ${RECOVERY_CODE_COUNT} codes.`),
  );

/**
 * The vault setup ceremony's upload — the complete key hierarchy, generated in
 * the browser and never derivable from what arrives here.
 *
 * One request rather than several, because a vault is not meaningful in pieces:
 * keys without a passphrase wrap can never be opened, and wraps without keys
 * open nothing. The repository writes them in one transaction for the same
 * reason.
 */
export const vaultCreateSchema = z.strictObject(
  {
    encPublicKey: publicKeySchema,
    encPrivateKeyEnc: gcmBlobSchema,
    signPublicKey: publicKeySchema,
    signPrivateKeyEnc: gcmBlobSchema,
    kdfSalt: kdfSaltSchema,
    kdfParams: kdfParamsSchema,
    unlockVerifier: unlockVerifierSchema,
    /**
     * Uploaded by the same ceremony, so both unlock paths work from the moment a
     * vault exists. Only setup writes it: a passphrase change and a recovery
     * both re-wrap the User Key rather than replacing it, so the digest of this
     * branch stays valid across them.
     */
    ukUnlockVerifier: ukUnlockVerifierSchema,
    passphraseWrap: gcmBlobSchema,
    recoveryWraps: recoveryWrapsSchema,
  },
  UNEXPECTED_FIELD,
);

export type VaultCreateRequest = z.infer<typeof vaultCreateSchema>;

/**
 * Unlocking: exactly one verifier, and the field name says which kind.
 *
 * ── Why a union rather than one optional-either-way object ──
 * An unlock does not always involve a passphrase. A passkey opens blob type 3,
 * which holds the User Key, and there is no derivation from the User Key back to
 * the Stretched Key — so a passkey unlock cannot produce `unlockVerifier` and
 * sends `ukUnlockVerifier` instead (spec §8.2).
 *
 * Two `strictObject` branches rather than one object with both fields optional,
 * because the states that shape would additionally admit are both wrong and both
 * silent. **Neither** present is a body claiming an unlock it never proved, and
 * an object schema would hand the service two `undefined`s to notice at runtime.
 * **Both** present is a caller asking the server to decide which proof counts,
 * and the safe reading — "accept if either matches" — is the one that turns two
 * independent verifiers into a single weaker one. A union refuses both at the
 * boundary, so the service receives a body that has already answered the
 * question.
 */
export const vaultUnlockSchema = z.union([
  z.strictObject({ unlockVerifier: unlockVerifierSchema }, UNEXPECTED_FIELD),
  z.strictObject({ ukUnlockVerifier: ukUnlockVerifierSchema }, UNEXPECTED_FIELD),
]);

export type VaultUnlockRequest = z.infer<typeof vaultUnlockSchema>;

/**
 * The last resort: destroying a vault whose passphrase and every recovery code
 * are gone.
 *
 * The confirmation follows `DELETE /api/auth/account` — a `confirm` field
 * compared with `confirmationMatches`, which trims and lowercases because this
 * is a check against a mistake rather than against an attacker. What differs is
 * *what* is typed. The account route asks for the account's own email, which is
 * the right prompt when the thing being named is the account; here the account
 * survives and what ends is the ability to read anything encrypted under it, so
 * the phrase states the act rather than naming the actor. Somebody typing
 * their own email out of muscle memory has confirmed nothing they read.
 */
export const VAULT_RESET_CONFIRMATION = 'reset my vault';

/**
 * How recently the caller must have actually authenticated, in seconds.
 *
 * Long enough to type a passphrase into a Google popup and then a confirmation
 * phrase into ours; short enough that an ID token captured earlier in the session
 * is already useless. It is compared against Firebase's `auth_time`, which a
 * refresh does not move — so this is five minutes since somebody proved who they
 * were, not five minutes since a token was minted.
 */
export const VAULT_RESET_MAX_AUTH_AGE_SECONDS = 5 * 60;

/**
 * The reset body: a typed phrase, and proof of account ownership.
 *
 * ── Why the phrase alone was not enough ──
 * `confirmationMatches` guards against a *mistake*, and it says so: the phrase is
 * printed on the screen above the field, so anybody who can reach the route can
 * read it. Against an attacker it is worth nothing. And the route is `allowLocked`
 * by necessity — every caller is locked out by definition — so what a stolen
 * session cookie could reach was the single irreversible, unrecoverable action in
 * the product: destroy the vault, and with it every environment key the account
 * held, permanently, for an attacker who never knew the passphrase.
 *
 * So the request carries a **fresh Firebase ID token**, verified server-side
 * through exactly the path `POST /api/auth/session` uses — same signature, same
 * issuer, same audience. Two things are then required of it: that its subject is
 * this session's own account, and that its `auth_time` is inside
 * {@link VAULT_RESET_MAX_AUTH_AGE_SECONDS}. The first stops a token for another
 * account being presented; the second is what makes it *re-authentication* rather
 * than a second copy of the credential the attacker already has.
 *
 * The bound is the same 8192 the session route applies, and for the same reason:
 * an unauthenticated-sized blob must not be buffered and base64-decoded on the
 * strength of a length nobody checked.
 */
export const vaultResetSchema = z.strictObject(
  {
    confirm: z.string().check(z.maxLength(100)),
    idToken: z.string().check(z.minLength(1), z.maxLength(8192)),
  },
  UNEXPECTED_FIELD,
);

/**
 * Locking, optionally everywhere.
 *
 * The body is optional: locking this session is the overwhelmingly common case,
 * and requiring `{}` for it would be ceremony.
 */
export const vaultLockSchema = z.optional(z.object({ everywhere: z.optional(z.boolean()) }));

/**
 * Changing the master passphrase.
 *
 * `currentUnlockVerifier` is the sudo-mode re-authentication, and it is not
 * redundant with the unlock gate above it. The gate proves this session was
 * unlocked at some point in the last eight hours; this proves the person typing
 * knows the passphrase *now* — which is the difference between a change made by
 * the account's owner and one made by whoever sat down at their desk.
 *
 * A new salt and new parameters travel with it because a passphrase change is
 * the natural moment to re-derive at the current cost. Sending the old ones back
 * unchanged is equally valid and equally accepted.
 */
export const vaultPassphraseSchema = z.strictObject(
  {
    currentUnlockVerifier: unlockVerifierSchema,
    unlockVerifier: unlockVerifierSchema,
    kdfSalt: kdfSaltSchema,
    kdfParams: kdfParamsSchema,
    passphraseWrap: gcmBlobSchema,
  },
  UNEXPECTED_FIELD,
);

/** Step one of recovery: a lookup hash, and nothing else. */
export const recoveryBeginSchema = z.strictObject(
  { lookupHash: lookupHashSchema },
  UNEXPECTED_FIELD,
);

/**
 * Step two: the new passphrase and a whole new kit, in one request.
 *
 * They are inseparable by design (ADR 0009). Somebody redeeming a code has lost
 * control of their passphrase, so recovery that stopped at "you are in" would
 * leave an account whose only credential is a piece of paper with four codes
 * left on it. The lookup hash is repeated so the server re-resolves the row
 * itself rather than trusting a client to name which wrap it opened.
 */
export const recoveryCompleteSchema = z.strictObject(
  {
    lookupHash: lookupHashSchema,
    unlockVerifier: unlockVerifierSchema,
    kdfSalt: kdfSaltSchema,
    kdfParams: kdfParamsSchema,
    passphraseWrap: gcmBlobSchema,
    recoveryWraps: recoveryWrapsSchema,
  },
  UNEXPECTED_FIELD,
);

/**
 * Reissuing the kit from an unlocked session, with the passphrase re-entered.
 *
 * `unlockVerifier` for the same sudo-mode reason as the passphrase change:
 * printing a fresh set of codes at somebody's unattended desk is precisely the
 * act a re-entry requirement exists to stop.
 */
export const recoveryRegenerateSchema = z.strictObject(
  { unlockVerifier: unlockVerifierSchema, recoveryWraps: recoveryWrapsSchema },
  UNEXPECTED_FIELD,
);

/**
 * Enrolling a passkey for one-touch unlock.
 *
 * `credentialId` is bounded at WebAuthn's own ceiling of 1023 bytes rather than
 * at whatever today's authenticators emit: the specification permits it, and a
 * limit tighter than the standard would refuse a conforming device for no
 * reason. The floor of 16 refuses an obviously fabricated id.
 */
export const passkeyEnrollSchema = z.strictObject(
  {
    credentialId: base64UrlBetween(16, 1023, 'That is not a WebAuthn credential id.'),
    label: z.string().check(z.trim(), z.minLength(1, 'Give this passkey a name.'), z.maxLength(64)),
    /**
     * The authenticator's advertised transports, if it declared any. A hint for
     * the browser's prompt, stored verbatim — an absent value is meaningful and
     * must not be replaced by a guess.
     */
    transports: z.optional(
      z
        .array(z.string().check(z.regex(/^[a-z-]{1,32}$/, 'Unrecognised transport.')))
        .check(z.maxLength(8)),
    ),
    wrap: gcmBlobSchema,
  },
  UNEXPECTED_FIELD,
);

/**
 * The browser a device PIN belongs to.
 *
 * Minted client-side, which is why it is half of a composite primary key rather
 * than a global name: two accounts enrolling on one browser are two independent
 * enrolments. Held to the uuid shape here so a hostile value cannot reach a
 * `uuid` column and surface as a 500 — see `schemas/ids.ts`.
 */
const deviceIdSchema = uuidField('A device is named by a UUID.');

/**
 * `HKDF(pinKey, "", "xecret.v2.pin-verifier", 32)` — never the PIN, never the
 * wrap, and never the wrap key.
 *
 * The same shape as an unlock verifier and the same argument: it is a sibling
 * HKDF branch of the key that opens the wrap, so the server storing its digest
 * learns nothing it could open anything with (crypto spec §3.3, §13.3).
 */
const pinVerifierSchema = base64UrlBytes(32, 'A PIN verifier is 32 bytes, base64url encoded.');

/**
 * Enrolling this browser's PIN, or re-enrolling it under a new one.
 *
 * One body for both, because they are one act: the browser already has a
 * `deviceId` and keeps it, and what changes is the pepper and the digest. The
 * salt the PIN was stretched with is deliberately **absent** — it lives beside
 * the wrap in that browser's `localStorage`, and a server that held it would
 * hold one more piece of an offline attack on six digits than it needs to.
 */
export const pinEnrollSchema = z.strictObject(
  { deviceId: deviceIdSchema, verifier: pinVerifierSchema },
  UNEXPECTED_FIELD,
);

/** One PIN attempt: which browser, and the proof. */
export const pinAttemptSchema = z.strictObject(
  { deviceId: deviceIdSchema, verifier: pinVerifierSchema },
  UNEXPECTED_FIELD,
);

/**
 * One enrolled browser, as the settings list sees it.
 *
 * No label and no user agent, and that absence is a decision rather than an
 * omission. A PIN enrolment is made by a browser, not by a person naming a
 * device, and inventing a name from the `User-Agent` of whichever request
 * happened to carry it would put a confident, frequently wrong label on the row
 * somebody uses to decide what to revoke. The dates and the short id are what
 * the row honestly knows.
 */
export interface PinDevicePayload {
  deviceId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function toPinDevice(device: PinDeviceRecord): PinDevicePayload {
  return {
    deviceId: device.deviceId,
    createdAt: device.createdAt.toISOString(),
    lastUsedAt: device.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * The auto-lock preference, as a request may express it.
 *
 * ── Why this accepts any integer rather than the four on the menu ──
 * The menu is a product decision; the floor and the ceiling are the security
 * one, and `clampAutoLockMinutes` in the service is what a value is actually
 * held to. A schema that refused anything off-menu would turn "lock me after
 * five minutes" — a request whose intention is unmistakable and *safer* than
 * what the account currently has — into a 422 that leaves the looser setting in
 * place. Failing towards the tighter number is the only direction worth having,
 * and the bounds below exist so the clamp is never handed something absurd to
 * round.
 *
 * `null` is a distinct, meaningful value: clear the preference, and follow
 * whatever the default is. It is not the same as sending the default's current
 * number, which would pin the account to today's answer forever.
 */
export const autoLockSchema = z.strictObject(
  {
    autoLockMinutes: z.nullable(
      z.int().check(z.minimum(0, 'That is not a number of minutes.'), z.maximum(100_000)),
    ),
  },
  UNEXPECTED_FIELD,
);

/** What the dashboard needs to choose between setup, lock screen, and dashboard. */
export interface VaultStatusPayload {
  /** Whether this account has completed the setup ceremony at all. */
  configured: boolean;
  unlocked: boolean;
  /** When the current unlock lapses. `null` when locked. */
  unlockedUntil: string | null;
  /**
   * Minutes of idleness before the vault locks, already resolved and clamped.
   *
   * The timer runs in the client — idleness is a fact only the client can
   * observe — but this is the same number the *server's* gate measures
   * `vault_unlocked_at` against, which is what stops the two from disagreeing.
   * Never `null` on the wire: a client scheduling a timer has no business
   * re-implementing what "no preference" resolves to.
   */
  autoLockMinutes: number;
}

export interface PasskeyPayload {
  id: string;
  credentialId: string;
  label: string;
  transports: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** The `prf` wrap this credential's PRF output opens. */
  wrap: string;
}

/**
 * Everything a locked client needs in order to attempt an unlock.
 *
 * ── Why this is served to a session that has not unlocked ──
 * It has to be: unlocking is a client-side operation, and a client cannot try to
 * unwrap a User Key it has not been given. Every field here is either public or
 * useless without the passphrase, so serving it costs nothing the model did not
 * already concede — the wraps are in a database that a compelled or breached
 * server can read anyway, which is exactly why they are wrapped.
 *
 * What it does concede, stated plainly rather than left implicit: a stolen
 * session cookie yields the wraps, and therefore an *offline* Argon2id attack
 * against the master passphrase, unbounded by the lockout above. That is the
 * standing trade-off of every browser-delivered zero-knowledge product, and it
 * is why ADR 0009 sets the passphrase bar at zxcvbn score 4 rather than at a
 * composition rule.
 */
export interface VaultMaterialPayload {
  encAlgorithm: string;
  encPublicKey: string;
  encPrivateKeyEnc: string;
  signAlgorithm: string;
  signPublicKey: string;
  signPrivateKeyEnc: string;
  kdfSalt: string;
  kdfParams: unknown;
  passphraseWrap: string;
  /** A count, never the wraps and never the hashes that address them. */
  recoveryCodesRemaining: number;
  passkeys: PasskeyPayload[];
}

export function toPasskey(passkey: PasskeyRecord): PasskeyPayload {
  return {
    id: passkey.id,
    credentialId: toBase64Url(toBytes(passkey.credentialId)),
    label: passkey.label,
    transports: passkey.transports,
    createdAt: passkey.createdAt.toISOString(),
    lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
    wrap: decodeBlob(passkey.wrap),
  };
}

export function toVaultMaterial(vault: VaultRecord): VaultMaterialPayload {
  return {
    encAlgorithm: vault.keys.encAlgorithm,
    encPublicKey: toBase64Url(toBytes(vault.keys.encPublicKey)),
    encPrivateKeyEnc: decodeBlob(vault.keys.encPrivateKeyEnc),
    signAlgorithm: vault.keys.signAlgorithm,
    signPublicKey: toBase64Url(toBytes(vault.keys.signPublicKey)),
    signPrivateKeyEnc: decodeBlob(vault.keys.signPrivateKeyEnc),
    kdfSalt: toBase64Url(toBytes(vault.keys.kdfSalt)),
    kdfParams: vault.keys.kdfParams,
    passphraseWrap: decodeBlob(vault.passphraseWrap),
    recoveryCodesRemaining: vault.recoveryCodesRemaining,
    passkeys: vault.passkeys.map(toPasskey),
  };
}

/**
 * A blob column back to the ASCII string it holds.
 *
 * The `bytea` in these columns is not raw ciphertext: it is the bytes of an
 * `xk2.…` string, stored that way so every ciphertext column in the schema has
 * one type (see `columns.ts`). This is the one place that reverses it, and it is
 * a decode of ASCII, not of a payload.
 */
export function decodeBlob(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** The ASCII of a blob string, for storage. The mirror of `decodeBlob`. */
export function encodeBlob(blob: string): Uint8Array {
  return new TextEncoder().encode(blob);
}
