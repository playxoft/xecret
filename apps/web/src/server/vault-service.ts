import {
  DEFAULT_AUTO_LOCK_MINUTES,
  clearedUnlockFailures,
  evaluateUnlockLockout,
  hashUnlockVerifier,
  isVaultUnlocked,
  nextUnlockFailure,
  unlockVerifierMatches,
  vaultUnlockExpiryFrom,
} from '@xecret/core/auth';
import { IdentityVerificationError } from '@xecret/core/auth';
import type { UnlockAttemptState, VerifiedIdentity } from '@xecret/core/auth';
import { fromBase64Url } from '@xecret/core/crypto';
import {
  changePassphrase as changePassphraseRows,
  completeRecovery as completeRecoveryRows,
  createVault as createVaultRows,
  enrollPasskey as enrollPasskeyRows,
  findRecoveryWrap,
  findUserByFirebaseUid,
  findVaultKeys,
  listOrganizationsForUser,
  listPasskeys,
  lockSessions,
  loadVault,
  markSessionUnlocked,
  recordRecoveryAttempt,
  recordUnlockAttempt,
  regenerateRecoveryCodes as regenerateRecoveryCodeRows,
  removePasskey as removePasskeyRow,
  RepositoryError,
  resetVault as resetVaultRows,
  setAutoLockMinutes,
  toBytes,
} from '@xecret/db/repositories';
import type { VaultKeyRecord } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { CLOCK_SKEW_SECONDS, firebaseIdentityProvider } from './firebase';
import { requeueKeySharesAfterVaultReset } from './member-keys';
import { decodeBlob, encodeBlob, toPasskey, toVaultMaterial } from './schemas/vault';
import { VAULT_RESET_MAX_AUTH_AGE_SECONDS } from './schemas/vault';
import type {
  PasskeyPayload,
  VaultCreateRequest,
  VaultMaterialPayload,
  VaultStatusPayload,
} from './schemas/vault';

/**
 * The vault operations, in one place.
 *
 * The routes above this are thin on purpose: unlocking is the one flow in the
 * product where the order of operations is itself the security control, and
 * spreading it across six handlers is how a step gets reordered by somebody who
 * does not know why it was where it was.
 *
 * The order below, and why each step is where it is:
 *
 *  1. **Load the record.** An account with no vault cannot be unlocked, and must
 *     not be told apart from one whose passphrase is wrong by timing alone.
 *  2. **Check the lockout before comparing.** Comparing first would let an
 *     attacker keep guessing through a lockout and simply ignore the response.
 *  3. **Compare.** Constant-time, inside `unlockVerifierMatches`.
 *  4. **Record the outcome before answering.** A failure that is not durably
 *     counted is a free guess, so the write happens before the response — not in
 *     `waitUntil`, which would let a client that disconnects early guess for
 *     nothing.
 *  5. **Only then unlock the session.**
 *
 * ── What this module cannot do, structurally ──
 * It cannot decrypt anything, and no amount of extending it could. Every value
 * it handles is a public key, a salt, a parameter set, or a ciphertext this
 * server holds no key for. `unlockVerifierMatches` is the only comparison in the
 * file that touches something passphrase-derived, and what it compares is a
 * *sibling* HKDF branch of the wrap key — knowing it opens nothing (spec §8).
 */

/** The session principal, or a refusal for a credential that cannot hold a vault. */
export function requireUserPrincipal(principal: Principal): Extract<Principal, { kind: 'user' }> {
  if (principal.kind !== 'user') {
    throw errors.forbidden('A vault belongs to a browser session, not to a token.');
  }
  return principal;
}

/**
 * The organisation an account-level audit record is filed under.
 *
 * `audit_logs.org_id` is NOT NULL, and a vault is not org-scoped — one vault
 * covers every organisation a person belongs to. So the record goes to their
 * primary membership, with the same honest limitation logout has: a member of
 * several organisations produces one record rather than one per organisation.
 * Writing it N times would be worse, because it would read as N separate acts.
 *
 * `null` when the account has no memberships, which is reachable only after
 * every one has been revoked. The act then goes unrecorded rather than blocking.
 */
export async function primaryOrgId(
  services: ServiceContext,
  userId: string,
): Promise<string | null> {
  const memberships = await listOrganizationsForUser(services.db, userId);
  const primary = memberships[0];
  return primary ? primary.organization.id : null;
}

export async function vaultStatus(
  services: ServiceContext,
  principal: Principal,
  now = new Date(),
): Promise<VaultStatusPayload> {
  // A bearer credential is never locked and has no vault to set up — reporting
  // it as `configured: false` would send the CLI into a ceremony it has no
  // screen for. See `isUnlocked` in `actor.ts`. `autoLockMinutes: 0` for the
  // same reason: a token has no screen to lock.
  if (principal.kind !== 'user') {
    return { configured: true, unlocked: true, unlockedUntil: null, autoLockMinutes: 0 };
  }

  const keys = await findVaultKeys(services.db, principal.user.id);
  return statusFrom(keys, principal.vaultUnlockedAt, now);
}

function statusFrom(
  keys: VaultKeyRecord | null,
  vaultUnlockedAt: Date | null,
  now: Date,
): VaultStatusPayload {
  // A session cannot be unlocked into a vault that does not exist. Without this
  // conjunction a user who deleted and re-created a vault would carry the old
  // session's timestamp into the new one, skipping the unlock entirely.
  const unlocked = keys !== null && isVaultUnlocked(vaultUnlockedAt, now);

  return {
    configured: keys !== null,
    unlocked,
    unlockedUntil:
      unlocked && vaultUnlockedAt !== null
        ? vaultUnlockExpiryFrom(vaultUnlockedAt).toISOString()
        : null,
    autoLockMinutes: keys?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES,
  };
}

/** The wraps and public material a locked client needs to attempt an unlock. */
export async function vaultMaterial(
  services: ServiceContext,
  userId: string,
): Promise<VaultMaterialPayload | null> {
  const vault = await loadVault(services.db, userId);
  return vault === null ? null : toVaultMaterial(vault);
}

/**
 * Whose vault material this principal may read: their own, and nobody else's.
 *
 * A **session** reads its own, which is the lock screen's whole job. A **CLI
 * token** reads its issuing user's, and that is a Phase 4 addition rather than
 * an oversight corrected: a CLI token acts as its user, its grants are sealed to
 * that user's X25519 public key, and the private half of that key exists only as
 * a wrap under the User Key. Without this the headless `xecret login
 * --passphrase` path could authenticate perfectly and then decrypt nothing,
 * because it would have no wrap to open.
 *
 * It concedes exactly what serving the material to a locked session concedes,
 * and no more — `VaultMaterialPayload` sets that out. The wraps are useless
 * without the passphrase, the recovery codes, or a passkey; a CLI token holds
 * none of those, and this endpoint hands out no verifier and no plaintext key.
 *
 * A **service token** reads nothing. It is not a person, has no vault, and its
 * own key travels in its token string (spec §13.1) rather than under anybody's
 * User Key — so there is no material that would mean anything to it.
 */
export function vaultMaterialOwner(principal: Principal): string | null {
  if (principal.kind === 'user') return principal.user.id;
  if (principal.kind === 'cliToken') return principal.userId;
  return null;
}

/**
 * Creates the vault, and unlocks the session that created it.
 *
 * Unlocking immediately is deliberate: the user has just proved presence twice
 * over — they were signed in and they chose the passphrase — and sending them
 * straight to a lock screen to retype what they typed a second ago is friction
 * with no corresponding gain.
 *
 * Creating over an existing vault is a **409, never an overwrite**. The old
 * public key has environment keys sealed to it, and replacing it silently would
 * revoke the account's access to every one of them while reporting success. The
 * check is inside the repository's transaction; this only translates the answer.
 */
export async function createVault(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  body: VaultCreateRequest,
): Promise<void> {
  try {
    await createVaultRows(services.db, {
      userId: user.user.id,
      encAlgorithm: 'X25519',
      encPublicKey: fromBase64Url(body.encPublicKey),
      encPrivateKeyEnc: encodeBlob(body.encPrivateKeyEnc),
      signAlgorithm: 'Ed25519',
      signPublicKey: fromBase64Url(body.signPublicKey),
      signPrivateKeyEnc: encodeBlob(body.signPrivateKeyEnc),
      kdfSalt: fromBase64Url(body.kdfSalt),
      kdfParams: body.kdfParams,
      unlockVerifierHash: await hashUnlockVerifier(fromBase64Url(body.unlockVerifier)),
      // Both digests, and only here. The setup ceremony is the one moment a
      // User Key comes into existence, so it is the one moment its verifier
      // branch can be recorded.
      ukUnlockVerifierHash: await hashUnlockVerifier(fromBase64Url(body.ukUnlockVerifier)),
      passphraseWrap: encodeBlob(body.passphraseWrap),
      recoveryWraps: body.recoveryWraps.map((entry) => ({
        lookupHash: fromBase64Url(entry.lookupHash),
        wrap: encodeBlob(entry.wrap),
      })),
    });
  } catch (cause) {
    throw mapVaultError(cause);
  }

  await markSessionUnlocked(services.db, user.sessionId, new Date());
}

/** Which proof an unlock presented, and therefore which digest it is compared against. */
export type UnlockMethod = 'passphrase' | 'passkey';

/**
 * Verifies an unlock verifier and unlocks the session.
 *
 * ── Two proofs, one gate ──
 * A passphrase unlock derives `SK` and sends `unlockVerifier`; a passkey unlock
 * opens the User Key directly, never derives `SK`, and sends `ukUnlockVerifier`
 * (spec §8.2). Which one arrived is decided by the request schema, not here —
 * the union has already refused a body carrying both or neither, so this reads a
 * settled question.
 *
 * They are compared against **different stored digests**, so neither can be
 * replayed for the other, and counted against the **same** lockout, because they
 * attest to the same thing: this client can open this vault. Giving the passkey
 * path its own counter would hand an attacker two budgets against one gate.
 *
 * Returns when the unlock lapses, so the client can schedule its own re-lock
 * rather than discovering the expiry through a failed request mid-edit.
 */
export async function unlockVault(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  body: { unlockVerifier: string } | { ukUnlockVerifier: string },
): Promise<{ unlockedUntil: string; method: UnlockMethod }> {
  const keys = await requireVault(services, user.user.id);

  const method: UnlockMethod = 'unlockVerifier' in body ? 'passphrase' : 'passkey';
  const presented = 'unlockVerifier' in body ? body.unlockVerifier : body.ukUnlockVerifier;
  const expected = method === 'passphrase' ? keys.unlockVerifierHash : keys.ukUnlockVerifierHash;

  await assertVerifierMatches(services, keys, presented, expected, method);

  const now = new Date();
  await markSessionUnlocked(services.db, user.sessionId, now);

  return { unlockedUntil: vaultUnlockExpiryFrom(now).toISOString(), method };
}

/**
 * Locks a session, or every session the account has.
 *
 * Distinct from signing out, and worth having as its own action precisely
 * because it is cheap: locking costs one passphrase to undo, while signing out
 * costs a full trip through Firebase. Making the safe action the cheap one is
 * what gets it used.
 */
export async function lockVault(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  everywhere: boolean,
): Promise<number> {
  return lockSessions(
    services.db,
    everywhere ? { userId: user.user.id } : { sessionId: user.sessionId },
  );
}

export interface ChangePassphraseInput {
  currentUnlockVerifier: string;
  unlockVerifier: string;
  kdfSalt: string;
  kdfParams: VaultCreateRequest['kdfParams'];
  passphraseWrap: string;
}

/**
 * Re-wraps the User Key under a new passphrase, and replaces the verifier with
 * it, in one transaction.
 *
 * The current verifier is required even though the route already demands an
 * unlocked session, and the two are not the same check. The gate proves this
 * session unlocked at some point in the last eight hours; this proves the person
 * typing knows the passphrase now. Without it, an unattended desk is a
 * passphrase change — which is the exact scenario the lock exists for.
 *
 * It goes through the same lockout and counting as an unlock. A change form that
 * did not would be an unmetered oracle for guessing the current passphrase.
 *
 * The **User Key is unchanged**, so recovery codes keep working, sessions on
 * other devices stay valid, and nothing sealed to this account's public key is
 * touched.
 */
export async function changePassphrase(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  body: ChangePassphraseInput,
): Promise<void> {
  const keys = await requireVault(services, user.user.id);

  await assertVerifierMatches(services, keys, body.currentUnlockVerifier);

  try {
    await changePassphraseRows(services.db, {
      userId: user.user.id,
      kdfSalt: fromBase64Url(body.kdfSalt),
      kdfParams: body.kdfParams,
      unlockVerifierHash: await hashUnlockVerifier(fromBase64Url(body.unlockVerifier)),
      // No `ukUnlockVerifierHash`. This re-wraps the User Key rather than
      // replacing it, so the digest of the branch derived from it is still
      // correct — and a passkey enrolled before the change keeps working, which
      // is the property the whole wrap indirection exists to buy.
      passphraseWrap: encodeBlob(body.passphraseWrap),
    });
  } catch (cause) {
    throw mapVaultError(cause);
  }
}

/**
 * Step one of recovery: turn a presented code's lookup hash into the wrap it
 * opens.
 *
 * ── One answer for every failure ──
 * Unknown hash, already-redeemed code, a code belonging to another account, no
 * vault at all: every one of these is the same refusal with the same message.
 * Distinguishing them would tell somebody probing the endpoint which part of
 * their guess was right, and — because a recovery lookup is not scoped by user
 * in the database — a distinguishable "no such code" would additionally be an
 * oracle for whether an account exists.
 *
 * The row is resolved globally by hash and then **checked against the session's
 * own account**. A code is a credential for one vault, and a session is a
 * credential for one account; requiring both means a leaked kit cannot be
 * redeemed by whoever finds it without also holding that person's session.
 */
export async function beginRecovery(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  lookupHash: string,
): Promise<{ wrap: string; material: VaultMaterialPayload }> {
  const keys = await requireVault(services, user.user.id);

  const lockout = evaluateUnlockLockout(recoveryState(keys), new Date());
  if (lockout.locked) throw errors.vaultLocked(lockout.retryAfterMs);

  const match = await findRecoveryWrap(services.db, fromBase64Url(lookupHash));

  if (match === null || match.userId !== user.user.id) {
    await failRecovery(services, keys);
    throw errors.badRequest('That recovery code is not valid.');
  }

  const vault = await loadVault(services.db, user.user.id);
  if (vault === null) throw errors.badRequest('That recovery code is not valid.');

  // Not yet cleared: the counter is reset by `completeRecovery`, because a
  // lookup that resolves and is then abandoned has not proved anything about
  // whether the holder can actually open the wrap.
  return { wrap: decodeBlob(match.wrap), material: toVaultMaterial(vault) };
}

export interface CompleteRecoveryInput extends ChangePassphraseInput {
  lookupHash: string;
  recoveryWraps: VaultCreateRequest['recoveryWraps'];
}

/**
 * Step two: redeem the code, set the new passphrase, reissue the whole kit, and
 * unlock the session — atomically, and in that order.
 *
 * The forced passphrase reset is not a nicety the UI could skip. Somebody here
 * has lost control of their passphrase; leaving the account without one would
 * mean its only remaining credential is a piece of paper. Reissuing every code
 * follows from the same fact: all five wrap the same User Key, so a kit with one
 * code spent is a kit four other pieces of paper still open.
 *
 * `currentUnlockVerifier` is absent from this path by design — the recovery code
 * *is* the proof, and demanding the passphrase would defeat the purpose.
 */
export async function completeRecovery(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  body: Omit<CompleteRecoveryInput, 'currentUnlockVerifier'>,
): Promise<void> {
  const keys = await requireVault(services, user.user.id);

  const lockout = evaluateUnlockLockout(recoveryState(keys), new Date());
  if (lockout.locked) throw errors.vaultLocked(lockout.retryAfterMs);

  const match = await findRecoveryWrap(services.db, fromBase64Url(body.lookupHash));

  if (match === null || match.userId !== user.user.id) {
    await failRecovery(services, keys);
    throw errors.badRequest('That recovery code is not valid.');
  }

  try {
    await completeRecoveryRows(services.db, {
      wrapId: match.wrapId,
      userId: user.user.id,
      kdfSalt: fromBase64Url(body.kdfSalt),
      kdfParams: body.kdfParams,
      unlockVerifierHash: await hashUnlockVerifier(fromBase64Url(body.unlockVerifier)),
      // No `ukUnlockVerifierHash`, for the same reason as the passphrase change:
      // redeeming a recovery code unwraps the User Key and re-wraps it under a
      // new passphrase. The key itself never moves, so its digest stays correct
      // and any enrolled passkey keeps working.
      passphraseWrap: encodeBlob(body.passphraseWrap),
      recoveryWraps: body.recoveryWraps.map((entry) => ({
        lookupHash: fromBase64Url(entry.lookupHash),
        wrap: encodeBlob(entry.wrap),
      })),
    });
  } catch (cause) {
    throw mapVaultError(cause);
  }

  await markSessionUnlocked(services.db, user.sessionId, new Date());
}

/**
 * Reissues the recovery kit from an unlocked session.
 *
 * Requires the passphrase again — the sudo-mode pattern — because printing a
 * fresh set of codes at an unattended desk is precisely the act a re-entry
 * requirement exists to stop. Previously redeemed codes keep their tombstones;
 * every live code is revoked in the same transaction that writes the new set.
 */
export async function regenerateRecoveryCodes(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  body: { unlockVerifier: string; recoveryWraps: VaultCreateRequest['recoveryWraps'] },
): Promise<number> {
  const keys = await requireVault(services, user.user.id);

  await assertVerifierMatches(services, keys, body.unlockVerifier);

  return regenerateRecoveryCodeRows(
    services.db,
    user.user.id,
    body.recoveryWraps.map((entry) => ({
      lookupHash: fromBase64Url(entry.lookupHash),
      wrap: encodeBlob(entry.wrap),
    })),
  );
}

export interface EnrollPasskeyInput {
  credentialId: string;
  label: string;
  transports?: string[] | undefined;
  wrap: string;
}

/**
 * Enrols a passkey and the wrap its PRF output opens.
 *
 * A passkey is never the only way into a vault: the passphrase wrap always
 * exists and has no removal path, so enrolling one adds a door rather than
 * replacing one. That is what makes unenrolment safe and what stops a lost
 * authenticator from being a lost account.
 */
export async function enrollPasskey(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  body: EnrollPasskeyInput,
): Promise<PasskeyPayload> {
  await requireVault(services, user.user.id);

  try {
    return toPasskey(
      await enrollPasskeyRows(services.db, {
        userId: user.user.id,
        credentialId: fromBase64Url(body.credentialId),
        label: body.label,
        transports: body.transports ?? null,
        wrap: encodeBlob(body.wrap),
      }),
    );
  } catch (cause) {
    throw mapVaultError(cause);
  }
}

export async function listVaultPasskeys(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
): Promise<PasskeyPayload[]> {
  return (await listPasskeys(services.db, user.user.id)).map(toPasskey);
}

/** Unenrols a passkey. Its wrap goes with it, by cascade. */
export async function removePasskey(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  passkeyId: string,
): Promise<void> {
  const removed = await removePasskeyRow(services.db, user.user.id, passkeyId);
  // 404 rather than a silent success, and the same 404 whether the id belongs to
  // somebody else or to nobody — the repository scopes by user, so the two are
  // indistinguishable here by construction (threat T2).
  if (!removed) throw errors.notFound('no such passkey');
}

/**
 * Destroys the vault, so an account with no way into it can start again.
 *
 * ── The dead end this exists for ──
 * Somebody who has lost their master passphrase *and* every recovery code holds
 * nothing that opens their User Key, and no one can produce one for them — not a
 * teammate, not an operator, not us. No copy of it exists outside the wraps this
 * destroys. That is the promise the product makes, and it is kept even here.
 *
 * So this does not lose their data; the last recovery code did. What it does is
 * let them out of the room: the row disappears, `vaultStatus` reports
 * `configured: false`, and the setup ceremony runs again with fresh keys. The
 * alternative is an account permanently parked at a lock screen with no action
 * on it, which is not safer — it is the same loss with no way to keep using the
 * account afterwards.
 *
 * ── What it costs, stated where the caller can see it ──
 * Every environment key ever sealed to the old public key becomes unopenable.
 * Their historical secrets stay in the database as ciphertext nobody can read,
 * and a teammate has to re-share each environment before they can work again.
 * The route says this in the confirmation phrase; this is the code that means it.
 *
 * ── The teammate is told, rather than hoped for ──
 * "A teammate has to re-share each environment" was the honest description of the
 * cost and a promise nothing kept: the reset deleted the account's grants *and*
 * every queued share, so the person came out entitled to environments, holding no
 * key for any of them, and named in no banner anywhere. `requeueKeySharesAfterVaultReset`
 * re-records the debt for every environment they may still read, in the same
 * transaction, so the sentence above describes something the product actually
 * does.
 *
 * Returns `false` when there was no vault, so the caller can answer "nothing to
 * reset" rather than reporting a destruction that did not happen.
 */
export async function resetVault(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
): Promise<boolean> {
  return resetVaultRows(services.db, user.user.id, {
    requeue: async (tx) => {
      await requeueKeySharesAfterVaultReset(tx, user.user.id);
    },
  });
}

/**
 * Refuses anything but a freshly re-authenticated owner of *this* account.
 *
 * ── Why a route that already has a session asks for a second credential ──
 * Because the two prove different things. The session cookie proves that this
 * browser was signed in at some point in the last thirty days; it does not prove
 * that the person holding it knows a password, and a cookie is the thing an
 * attacker steals. Everywhere else in the product that gap is closed by the vault
 * lock — a passphrase re-entry standing in front of anything destructive. The
 * reset route cannot use it: every caller is locked out by definition, which is
 * why they are there.
 *
 * So the second proof comes from the identity provider instead, verified exactly
 * as `POST /api/auth/session` verifies it — signature, issuer, audience and
 * expiry, against Google's public keys, through the same
 * `FirebaseIdentityProvider`. Nothing here decodes a token by hand.
 *
 * ── The two things asked of it ──
 * **Whose token is it.** The subject is resolved to a user row and compared with
 * the session's own account. Comparing the *email* would have been simpler and
 * wrong: an address can be changed at the provider, and two accounts can share
 * one over time, whereas `firebase_uid` is the identity this system is keyed by.
 *
 * **How fresh is it.** `auth_time`, not `iat`. A refresh token mints a new ID
 * token every hour with no human involved, so `iat` would be satisfied by a
 * browser that has been sitting idle — which is precisely the browser an attacker
 * stole. `auth_time` moves only when somebody actually authenticates.
 *
 * Every failure is the same refusal with the same message, for the reason the
 * session route gives: naming which part was wrong tells an attacker which part
 * of a forged token to fix next.
 */
export async function assertRecentAccountOwner(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  idToken: string,
  now: Date = new Date(),
): Promise<void> {
  const refuse = (reason: string): never => {
    services.log
      .at('assertRecentAccountOwner')
      .warn(
        `Refused a vault reset because the re-authentication was ${reason}. The caller was told ` +
          'only that they must sign in again — naming the reason would tell an attacker which ' +
          'part of a forged token to fix next.',
        { reason },
      );

    throw errors.unauthenticated(
      'Sign in again to confirm this is your account before resetting your vault.',
    );
  };

  let identity: VerifiedIdentity;
  try {
    identity = await firebaseIdentityProvider(services.env).verify(idToken);
  } catch (cause) {
    if (cause instanceof IdentityVerificationError) return refuse(cause.reason);
    throw cause;
  }

  const owner = await findUserByFirebaseUid(services.db, identity.subject);
  if (owner === null || owner.id !== user.user.id) return refuse('for another account');

  const ageSeconds = Math.floor(now.getTime() / 1000) - identity.authTime;
  if (ageSeconds > VAULT_RESET_MAX_AUTH_AGE_SECONDS) return refuse('too old');

  // A clock that says the user authenticated in the future is a clock nobody
  // should be destroying a vault on the word of. The tolerance matches the skew
  // the token verifier itself allows for `iat`.
  if (ageSeconds < -CLOCK_SKEW_SECONDS) return refuse('dated in the future');
}

/** Changes how long the dashboard may sit idle before locking itself. */
export async function setAutoLock(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  minutes: number,
): Promise<void> {
  const updated = await setAutoLockMinutes(services.db, user.user.id, minutes);
  // No vault row: there is nothing an idle lock could ask for. The setup
  // ceremony is the answer, not a silently created preference.
  if (updated === null) {
    throw errors.badRequest('Set up your vault first; auto-lock protects it.');
  }
}

async function requireVault(services: ServiceContext, userId: string): Promise<VaultKeyRecord> {
  const keys = await findVaultKeys(services.db, userId);
  if (keys === null) {
    throw errors.badRequest('This account has no vault yet. Set one up to continue.');
  }
  return keys;
}

function recoveryState(keys: VaultKeyRecord): UnlockAttemptState {
  return {
    failedAttempts: keys.recoveryFailedAttempts,
    lockedUntil: keys.recoveryLockedUntil,
  };
}

/**
 * Compares a presented verifier, enforcing and updating the lockout around it.
 *
 * Throws on failure and returns nothing on success — a boolean return would let
 * a caller forget to check it, and the one caller that forgot would be the one
 * that unlocks a session.
 */
async function assertVerifierMatches(
  services: ServiceContext,
  keys: VaultKeyRecord,
  presented: string,
  /** The stored digest to compare against — never inferred from the value itself. */
  expectedHash: Uint8Array = keys.unlockVerifierHash,
  surface: UnlockMethod = 'passphrase',
): Promise<void> {
  const now = new Date();

  const lockout = evaluateUnlockLockout(keys, now);
  if (lockout.locked) throw errors.vaultLocked(lockout.retryAfterMs);

  const matched = await unlockVerifierMatches(fromBase64Url(presented), toBytes(expectedHash));

  if (!matched) {
    // Awaited, not deferred. A failure recorded in `waitUntil` is one a client
    // can avoid paying for by hanging up, which turns the counter into a
    // suggestion.
    await recordUnlockAttempt(services.db, keys.userId, nextUnlockFailure(keys, now));

    services.log.at('assertVerifierMatches').warn(
      'Rejected an incorrect vault unlock — this account has now failed ' +
        `${keys.failedAttempts + 1} time(s) in a row and will be locked out if it keeps ` +
        'failing',
      // The count, never the verifier and never the user's email. The user id
      // is on the line already — the route wrapper bound it — which is what
      // makes "this account is being brute-forced" a query rather than a hunch.
      { failedAttempts: keys.failedAttempts + 1, surface },
    );

    throw errors.unauthenticated('incorrect unlock verifier');
  }

  if (keys.failedAttempts !== 0 || keys.lockedUntil !== null) {
    await recordUnlockAttempt(services.db, keys.userId, clearedUnlockFailures());
  }
}

/** Counts one failed recovery attempt against the separate recovery lockout. */
async function failRecovery(services: ServiceContext, keys: VaultKeyRecord): Promise<void> {
  const state = nextUnlockFailure(recoveryState(keys), new Date());
  await recordRecoveryAttempt(services.db, keys.userId, state);

  services.log
    .at('failRecovery')
    .warn(
      'Rejected a recovery code — this account has now failed ' +
        `${state.failedAttempts} time(s) in a row and will be locked out if it keeps failing`,
      { failedAttempts: state.failedAttempts, surface: 'recovery' },
    );
}

/**
 * Turns a repository invariant failure into a response.
 *
 * `conflict` is the interesting one: it means a second request got there first —
 * a vault created in another tab, a passphrase changed twice, a recovery code
 * redeemed while this request was in flight. All of them are the caller's to
 * resolve by reloading, and none of them is a 500.
 */
function mapVaultError(cause: unknown): unknown {
  if (!(cause instanceof RepositoryError)) return cause;

  switch (cause.code) {
    case 'conflict':
      return errors.conflict(cause.message);
    case 'notFound':
      return errors.notFound(cause.message);
    default:
      return errors.badRequest(cause.message);
  }
}
