import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { MAX_AUTO_LOCK_MINUTES, MIN_AUTO_LOCK_MINUTES } from '@xecret/core/auth';
import type { Argon2idParams } from '@xecret/core/crypto/client';
import { bytea } from './columns';
import { users } from './identity';

/**
 * The user vault — the zero-knowledge key hierarchy, as the server holds it.
 *
 * See docs/adr/0009-zero-knowledge-encryption.md and the byte-level definitions
 * in docs/security/e2ee-crypto-spec.md, which is normative for everything here.
 *
 *   Master passphrase ──Argon2id──► SK      [client only, never transmitted]
 *                                    │
 *     Recovery code ──HKDF──► RCK    │      Passkey PRF ──HKDF──► PK
 *                        │           │                       │
 *                        └───────────┼───────────────────────┘
 *                                    ▼
 *                          wraps of the User Key          → user_key_wraps.wrap
 *                                    │
 *              UK encrypts the X25519 and Ed25519 private keys → user_keys
 *
 * ── What these tables are, read as a whole ──
 * **Every column below is either a public value or an opaque ciphertext.** There
 * is no column, and no combination of columns, from which a server — or anyone
 * holding a full dump of this database plus every server-side secret — can
 * derive a User Key, a private key, or a secret value. That is the entire point
 * of the design, and it is the property to check any future column against.
 *
 * The one column that even *looks* like a credential is `unlock_verifier_hash`,
 * and it is not one: it holds `SHA-256` of a sibling HKDF branch of the wrap key
 * (spec §8). Possessing it opens nothing. It exists so the server can gate its
 * own API, throttle attempts, and write an audit trail — see `auth/vault.ts`.
 *
 * ── How binary columns are used ──
 * Three different things live in `bytea` here, and the distinction matters when
 * reading a row by hand:
 *
 *  - **Raw key bytes** — `enc_public_key`, `sign_public_key` (32 bytes each, the
 *    X25519 u-coordinate and the Ed25519 public key), `kdf_salt` (16),
 *    `unlock_verifier_hash` (32), `lookup_hash` (32), `credential_id`.
 *  - **Blob strings** — `enc_private_key_enc`, `sign_private_key_enc`, `wrap`.
 *    These hold the **ASCII bytes of an `xk2.…` blob** (spec §2), not raw
 *    ciphertext. The version prefix travels with the value, so a row written by
 *    a future format fails to parse rather than being misread as this one — and
 *    `bytea` rather than `text` keeps every ciphertext column in this schema one
 *    type, so nothing here can be mistaken for a loggable string.
 *
 * The server never parses either kind. It validates length and prefix at the API
 * boundary and stores what it is given.
 */

/**
 * One row per account that has completed the vault setup ceremony.
 *
 * Absence is meaningful and drives the whole first-run flow: no row means "this
 * account has no vault yet", which is the state that routes a user to the setup
 * ceremony before any secret can be read or written.
 *
 * A separate table rather than columns on `users`, for the reasons the retired
 * `user_pins` table gave and one more: `users` is joined on every authenticated
 * request, and this material is read on a handful of endpoints. Widening the hot
 * path by eleven columns to serve the lock screen would be a cost paid forever.
 *
 * There is no `DELETE` path in the ordinary product. Removing this row abandons
 * every environment key sealed to `enc_public_key`, which is a "reset my vault,
 * I have lost everything" ceremony rather than a settings toggle.
 */
export const userKeys = pgTable(
  'user_keys',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * The construction `enc_public_key` belongs to. `X25519` today.
     *
     * Stored per row rather than assumed, so introducing a second curve later
     * is a column value rather than a migration over everybody's keys — even
     * though ADR 0009 commits to one curve and one code path for v1.
     */
    encAlgorithm: text('enc_algorithm').notNull().default('X25519'),
    /** The 32-byte X25519 public key, in the clear. Everything seals to this. */
    encPublicKey: bytea('enc_public_key').notNull(),
    /** `xk2.gcm.` blob (type 4): the X25519 private scalar under the User Key. */
    encPrivateKeyEnc: bytea('enc_private_key_enc').notNull(),

    signAlgorithm: text('sign_algorithm').notNull().default('Ed25519'),
    /** The 32-byte Ed25519 public key. Grant signatures verify against this. */
    signPublicKey: bytea('sign_public_key').notNull(),
    /** `xk2.gcm.` blob (type 5): the Ed25519 seed under the User Key. */
    signPrivateKeyEnc: bytea('sign_private_key_enc').notNull(),

    /** 16 random bytes, in the clear. An Argon2id salt is not a secret. */
    kdfSalt: bytea('kdf_salt').notNull(),
    /**
     * `{ alg, v, m, t, p, len }` exactly — the Argon2id cost this user's wraps
     * were derived at (spec §3.1).
     *
     * Stored per user rather than as a global constant so the cost can be raised
     * later without a migration that would have to know every passphrase: a row
     * at old parameters keeps unwrapping at those parameters, and the client
     * re-derives and re-wraps on the next successful unlock. The same reasoning
     * the retired PIN's self-describing hash had, and the reason `kdfNeedsUpgrade`
     * compares with `!==` rather than `<`.
     *
     * **These values are server-supplied input to a client-side KDF**, so the
     * client validates them against a fixed range before running Argon2id — an
     * unvalidated `m` is an arbitrary memory allocation ordered by whoever
     * controls this row. See `parseKdfParams`.
     */
    kdfParams: jsonb('kdf_params').$type<Argon2idParams>().notNull(),
    /** `SHA-256(unlockVerifier)`, 32 bytes. Opens nothing — see the header. */
    unlockVerifierHash: bytea('unlock_verifier_hash').notNull(),
    /**
     * `SHA-256(ukUnlockVerifier)`, 32 bytes — the proof an unlock that never
     * derived `SK` presents instead (spec §8.2).
     *
     * A second column rather than a second accepted value in the first, because
     * the two verifiers are different HKDF branches and must never be
     * interchangeable: one column would mean a value captured from either path
     * satisfies both, which is precisely the confusion the separate info strings
     * exist to prevent.
     *
     * It survives a passphrase change and a recovery untouched, and that is a
     * consequence of the hierarchy rather than an exception in the code: both
     * re-wrap the User Key, neither replaces it, so the value this digest is of
     * is unchanged. Only the setup ceremony writes it.
     */
    ukUnlockVerifierHash: bytea('uk_unlock_verifier_hash').notNull(),

    /**
     * Consecutive failed passphrase unlocks, and the lockout they earned.
     *
     * Durable columns rather than a counter in an isolate, for the reason the
     * PIN's were: a counter that lives in a Worker isolate is a counter an
     * attacker resets by waiting for the isolate to be recycled.
     */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /**
     * The same pair for recovery-code redemption, counted separately.
     *
     * Deliberately not shared with the passphrase counter: a recovery code is
     * 125 bits of uniform randomness, so its limit is abuse control rather than
     * a defence against guessing, and a mistyped code must not spend the budget
     * protecting the passphrase. See `auth/vault.ts` for the argument in full.
     */
    recoveryFailedAttempts: integer('recovery_failed_attempts').notNull().default(0),
    recoveryLockedUntil: timestamp('recovery_locked_until', { withTimezone: true }),

    /**
     * Minutes of idleness before the vault locks. `NULL` means "no preference".
     *
     * ── One number, read by both halves of the lock ──
     * The browser's idle timer counts against this, and so does the server's own
     * gate: `isVaultUnlocked` measures `sessions.vault_unlocked_at` against this
     * many minutes rather than against a constant nobody could see. That is why
     * the column stopped being a convenience when 0015 reshaped it — a client
     * that simply never ran its timer used to keep a session the server still
     * considered unlocked for the rest of the working day.
     *
     * `NULL` rather than a `DEFAULT`, because "never chose" and "chose an hour"
     * are different facts and only the first may be redefined later without
     * rewriting everybody's row. `DEFAULT_AUTO_LOCK_MINUTES` in
     * `@xecret/core/auth` is what a `NULL` resolves to.
     *
     * The CHECK is a range and not a set, matching `clampAutoLockMinutes`: the
     * menu the settings page offers is a product decision that may grow, while
     * the floor and the ceiling are the security ones. `0` — "never" — is
     * deliberately not expressible: a preference the server honours cannot be
     * allowed to mean "this session stays unlocked forever".
     */
    autoLockMinutes: integer('auto_lock_minutes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the passphrase was last changed — the last time the passphrase wrap,
     * the verifier and the KDF parameters were replaced together.
     *
     * `NULL` while the vault still has its original passphrase. Not `updatedAt`:
     * it answers a specific security question, and a timestamp that also moved
     * when somebody changed their auto-lock interval would not answer it.
     */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'user_keys_auto_lock_check',
      sql`${t.autoLockMinutes} is null or ${t.autoLockMinutes} between ${sql.raw(String(MIN_AUTO_LOCK_MINUTES))} and ${sql.raw(String(MAX_AUTO_LOCK_MINUTES))}`,
    ),
  ],
);

/**
 * Passkeys enrolled for one-touch unlock via the WebAuthn PRF extension.
 *
 * This table holds the *identity* of a credential; the key material it protects
 * is the matching `prf` row in `user_key_wraps`. They are separate because a
 * passkey is a device the user manages — named, listed, revoked — while a wrap
 * is a ciphertext, and conflating the two would put a label and a `last_used_at`
 * on a row otherwise made entirely of opaque bytes.
 *
 * A passkey is never the only way into a vault. The passphrase wrap always
 * exists and cannot be removed, so unenrolling every passkey strands nobody.
 */
export const userPasskeys = pgTable(
  'user_passkeys',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The WebAuthn credential id, as raw bytes.
     *
     * Unique across the installation, not per user: a credential id identifies
     * an authenticator's credential globally, and the same one appearing under
     * two accounts means something has gone wrong rather than that two people
     * share a key. It is also interpolated (base64url) into the AAD of the
     * matching wrap, which binds that wrap to this credential and nothing else.
     */
    credentialId: bytea('credential_id').notNull().unique(),
    /** What the user called this device. Shown in the security screen. */
    label: text('label').notNull(),
    /**
     * The authenticator's advertised transports (`usb`, `nfc`, `internal`, …).
     *
     * A hint the browser uses to prompt sensibly, stored verbatim as the array
     * the client reported. `jsonb` and nullable because it is advisory: WebAuthn
     * does not require it, and inventing a value for an authenticator that
     * declared none would make the prompt worse rather than better.
     */
    transports: jsonb('transports').$type<string[] | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [index('user_passkeys_user_idx').on(t.userId, t.createdAt.desc())],
);

/** The three ways a User Key can be wrapped. Matches `WrapKind` in the crypto layer. */
export const USER_KEY_WRAP_KINDS = ['passphrase', 'recovery', 'prf'] as const;

export type UserKeyWrapKind = (typeof USER_KEY_WRAP_KINDS)[number];

/**
 * Every wrap of one account's User Key: one passphrase wrap, five recovery
 * wraps, and one per enrolled passkey.
 *
 * All of them encrypt the **same 32 bytes** under different keys, which is what
 * makes the whole design cheap: changing a passphrase rewrites one row, and
 * nothing else in the database re-encrypts.
 *
 * ── Why `kind` is text with a CHECK rather than a pgEnum ──
 * Every other categorical column in this schema is a `pgEnum`, and the header of
 * `enums.ts` explains why. This one is not, because the set is pinned by the
 * crypto specification (§4.1) rather than by the product: `wrapKind` is
 * interpolated into the AAD of every wrap, so adding a value is a spec change
 * and a new blob type, never a schema migration somebody runs on a Tuesday. A
 * CHECK says that plainly; a `pgEnum`, whose whole advertised virtue is that
 * values can be appended freely, would say the opposite.
 *
 * ── The kind-specific columns, and the CHECKs that hold them honest ──
 * Three of the columns belong to exactly one kind. Rather than three tables
 * sharing a lookup, or a `jsonb` bag, the constraints below state the shape
 * directly, so a row that claims to be a recovery wrap without a lookup hash —
 * or a passphrase wrap carrying one — cannot be written at all.
 */
export const userKeyWraps = pgTable(
  'user_key_wraps',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<UserKeyWrapKind>().notNull(),
    /** `xk2.gcm.` blob (types 1–3): the User Key under this wrap's key. */
    wrap: bytea('wrap').notNull(),

    /**
     * `SHA-256("xecret.v2.recovery-lookup" ‖ codeBytes)`, 32 bytes. Recovery only.
     *
     * How a presented code finds its row without the server ever seeing the code
     * in a reversible form. A fast hash is correct here for the reason spec §7.5
     * gives: the input is 125 bits of uniform randomness with no structure to
     * attack, so a slow KDF would buy nothing and cost an indexed lookup.
     */
    lookupHash: bytea('lookup_hash'),
    /**
     * The passkey this wrap belongs to. `prf` only.
     *
     * `onDelete: 'cascade'` — unenrolling a passkey takes its wrap with it, and
     * a wrap whose passkey is gone is unopenable by anyone, so keeping it would
     * be keeping a row nothing can ever use.
     */
    passkeyId: uuid('passkey_id').references(() => userPasskeys.id, { onDelete: 'cascade' }),
    /**
     * When this recovery code was redeemed. `NULL` while unused. Recovery only.
     *
     * Marked rather than deleted, so "that code has already been used" is
     * distinguishable in an incident review from "that code never existed" —
     * even though the API deliberately gives both the same answer.
     */
    usedAt: timestamp('used_at', { withTimezone: true }),
    /**
     * When this wrap stopped being current. `NULL` while it is.
     *
     * Only a passphrase wrap is ever superseded, and only by a passphrase
     * change: the new wrap is written and the old one marked in one transaction,
     * so there is no instant at which an account has zero or two live
     * passphrase wraps. The partial unique index below is what enforces that.
     *
     * Superseded rows are kept rather than deleted because they are the record
     * that a passphrase changed, and because deleting the only wrap of a User
     * Key in a transaction that then fails is the one mistake in this table that
     * has no recovery.
     */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('user_key_wraps_kind_check', sql`${t.kind} in ('passphrase', 'recovery', 'prf')`),
    // A lookup hash belongs to a recovery wrap and to nothing else, in both
    // directions: a recovery wrap without one could never be found, and a
    // passphrase wrap with one would be findable by a code that does not open it.
    check(
      'user_key_wraps_lookup_check',
      sql`(${t.kind} = 'recovery') = (${t.lookupHash} is not null)`,
    ),
    // Same, for the passkey a PRF wrap is derived from. Without the equality a
    // passphrase wrap could be cascade-deleted by unenrolling a passkey.
    check('user_key_wraps_passkey_check', sql`(${t.kind} = 'prf') = (${t.passkeyId} is not null)`),
    // `usedAt` is one-shot redemption, which only a recovery code has. A
    // passphrase wrap is superseded, never used up.
    check('user_key_wraps_used_check', sql`${t.usedAt} is null or ${t.kind} = 'recovery'`),
    /**
     * **Exactly one live passphrase wrap per account.**
     *
     * The load-bearing constraint of this table. Two live wraps would mean two
     * passphrases open the same vault, and the older one would keep working long
     * after its owner believed they had changed it — a silent, permanent
     * downgrade with no symptom. Partial, so the superseded history is unbounded
     * while the present is unique.
     */
    uniqueIndex('user_key_wraps_passphrase_unique')
      .on(t.userId)
      .where(sql`${t.kind} = 'passphrase' and ${t.supersededAt} is null`),
    /**
     * The recovery lookup: one indexed equality on the presented code's hash.
     *
     * Unique across the whole table rather than per user, because the lookup has
     * no user to scope by — a person redeeming a code has forgotten their
     * passphrase, not their identity, but the query still finds the row by hash
     * alone. Two accounts colliding on a 32-byte digest is not a case worth a
     * code path; a unique index makes it an error rather than an ambiguity.
     */
    uniqueIndex('user_key_wraps_lookup_unique')
      .on(t.lookupHash)
      .where(sql`${t.lookupHash} is not null`),
    // Every wrap for one account, which is what the vault status endpoint reads.
    index('user_key_wraps_user_idx').on(t.userId, t.kind),
  ],
);

/**
 * The server's half of a browser's six-digit device PIN.
 *
 * ── Why a six-digit secret is not a six-digit secret here ──
 * 10^6 guesses is no protection offline, so the PIN never opens anything on its
 * own. The wrap that actually holds the User Key lives in that browser's
 * `localStorage` and **never reaches this server**, encrypted under
 * `HKDF(pinKey ‖ pepper)` where `pepper` is the 32 random bytes below. Holding
 * the device without the pepper is holding a ciphertext with nothing to attack;
 * holding this whole table without the device is holding bytes that decrypt
 * nothing, anywhere. The two meet only during an unlock, under
 * {@link vaultPinPeppers.attempts} — which is what turns a million offline
 * guesses into five online ones.
 *
 * ── The trade-off, stated rather than implied ──
 * A server colluding with whoever holds the device *can* brute-force six digits:
 * it has the pepper, they have the wrap. That is a genuine weakening of the
 * zero-knowledge property, which is why enrolling is opt-in per browser, why the
 * passphrase stays the root, and why nothing turns this on by default. The
 * settings screen says the same thing to the person choosing.
 *
 * ── What is *not* here ──
 * No wrap, no salt, no PIN, and nothing derived from the PIN that is reversible.
 * `verifier_hash` is `SHA-256` of a sibling HKDF branch of the PIN key, the same
 * construction — and the same argument — as `user_keys.unlock_verifier_hash`.
 */
export const vaultPinPeppers = pgTable(
  'vault_pin_peppers',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The browser's own identifier, generated client-side at enrolment.
     *
     * Part of the primary key rather than the whole of it. A client-generated id
     * is not a global name: two accounts enrolling on the same browser are two
     * independent enrolments, and a single-column key would let the second
     * collide with — or silently overwrite — the first.
     */
    deviceId: uuid('device_id').notNull(),
    /** 32 random bytes. Half of the PIN wrap key, and the half the device lacks. */
    pepper: bytea('pepper').notNull(),
    /** `SHA-256(HKDF(pinKey, "xecret.v2.pin-verifier"))`, 32 bytes. Opens nothing. */
    verifierHash: bytea('verifier_hash').notNull(),
    /**
     * Consecutive wrong PINs. At five the row is **deleted**, not locked out.
     *
     * Deletion rather than a lockout because there is nothing to come back to: the
     * pepper is gone, so the wrap in that browser is permanently unopenable and
     * the passphrase is the only way in. A timed lockout would imply the PIN
     * becomes usable again, and for a credential whose entire security budget is
     * this counter, "wait an hour and keep guessing" is not a budget.
     */
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.deviceId] }),
    check(
      'vault_pin_peppers_pepper_check',
      sql`octet_length(${t.pepper}) = 32 and octet_length(${t.verifierHash}) = 32`,
    ),
    check('vault_pin_peppers_attempts_check', sql`${t.attempts} >= 0 and ${t.attempts} <= 5`),
    // The settings list, and the revoke-everything sweep a passphrase change, a
    // recovery and a vault reset each have to run: all three may rotate the User
    // Key, and every stale wrap has to die server-side too.
    index('vault_pin_peppers_user_idx').on(t.userId, t.createdAt.desc()),
  ],
);
