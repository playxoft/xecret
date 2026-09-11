import {
  clampAutoLockMinutes,
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
import { fromBase64Url, toBase64Url } from '@xecret/core/crypto';
import { generatePinPepper } from '@xecret/core/crypto/client';
import {
  attemptPinUnlock,
  changePassphrase as changePassphraseRows,
  completeRecovery as completeRecoveryRows,
  createVault as createVaultRows,
  disablePinPepper,
  enrollPasskey as enrollPasskeyRows,
  findRecoveryWrap,
  findUserByFirebaseUid,
  findVaultKeys,
  listOrganizationsForUser,
  listPasskeys,
  listPinPeppers,
  lockSessions,
  loadVault,
  markSessionUnlocked,
  mintPinPepper,
  recordRecoveryAttempt,
  recordUnlockAttempt,
  regenerateRecoveryCodes as regenerateRecoveryCodeRows,
  removePasskey as removePasskeyRow,
  RepositoryError,
  resetVault as resetVaultRows,
  revokeAllPinPeppers,
  setAutoLockMinutes,
  toBytes,
} from '@xecret/db/repositories';
import type { VaultKeyRecord } from '@xecret/db/repositories';
import { vaultUnlockStateOf } from './actor';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { CLOCK_SKEW_SECONDS, firebaseIdentityProvider } from './firebase';
import { requeueKeySharesAfterVaultReset } from './member-keys';
import { decodeBlob, encodeBlob, toPasskey, toPinDevice, toVaultMaterial } from './schemas/vault';
import { VAULT_RESET_MAX_AUTH_AGE_SECONDS } from './schemas/vault';
import type {
  PasskeyPayload,
  PinDevicePayload,
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
  return statusFrom(keys, principal, now);
}

function statusFrom(
  keys: VaultKeyRecord | null,
  principal: Extract<Principal, { kind: 'user' }>,
  now: Date,
): VaultStatusPayload {
  // The preference comes from the freshly read vault row rather than from the
  // principal's copy, which the session lookup took at the start of the request.
  // They differ on exactly one path — the PATCH below, which answers with the
  // status it has just written — and answering with the stale number there would
  // hand the client back the value it had asked to change.
  const state = {
    ...vaultUnlockStateOf(principal),
    autoLockMinutes: keys?.autoLockMinutes ?? null,
  };

  // A session cannot be unlocked into a vault that does not exist. Without this
  // conjunction a user who deleted and re-created a vault would carry the old
  // session's timestamp into the new one, skipping the unlock entirely.
  const unlocked = keys !== null && isVaultUnlocked(state, now);

  return {
    configured: keys !== null,
    unlocked,
    unlockedUntil: unlocked ? vaultUnlockExpiryFrom(state).toISOString() : null,
    // Resolved, never raw. The client schedules a timer against this number and
    // has no business re-implementing what a `null` means — there is one
    // definition of that, and it is `clampAutoLockMinutes`.
    autoLockMinutes: clampAutoLockMinutes(keys?.autoLockMinutes ?? null),
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

  // `markSessionUnlocked` writes both timestamps, so the idle allowance starts
  // here rather than from whenever this session last made a request.
  const unlockedUntil = vaultUnlockExpiryFrom({
    vaultUnlockedAt: now,
    lastSeenAt: now,
    autoLockMinutes: keys.autoLockMinutes,
  });

  return { unlockedUntil: unlockedUntil.toISOString(), method };
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

/* ─────────────────────────────── device PIN ─────────────────────────────── */

/** The pepper, handed over once, and the row it now belongs to. */
export interface PinEnrolmentPayload {
  device: PinDevicePayload;
  /** 32 bytes, base64url. The client wraps with it and never stores it. */
  pepper: string;
}

/**
 * Enrols this browser's six-digit PIN, or re-enrols it under a new one.
 *
 * ── What the server contributes, and why it is the whole of the security ──
 * A pepper: 32 bytes of CSPRNG output, minted here and **never derivable by the
 * browser**. The wrap the browser then builds is encrypted under
 * `HKDF(pinKey ‖ pepper)`, so the ciphertext it keeps in `localStorage` is not
 * attackable at any cost without this row — which is what makes it safe to
 * protect a User Key with six digits at all.
 *
 * The pepper crosses the wire exactly once, in this response. It is never
 * persisted by the client and is fetched again, one attempt at a time and under
 * a counter, by {@link attemptDevicePin}.
 *
 * ── Why the route that calls this requires an unlocked session ──
 * Because enrolment wraps the User Key, and a browser that cannot decrypt has no
 * User Key to wrap. A locked session reaching here could only produce a wrap of
 * nothing, and an enrolment row for a wrap that opens nothing is worse than no
 * enrolment: it suppresses the offer to set one up.
 */
export async function enrolDevicePin(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  body: { deviceId: string; verifier: string },
): Promise<PinEnrolmentPayload> {
  await requireVault(services, user.user.id);

  const pepper = generatePinPepper();
  const device = await mintPinPepper(services.db, {
    userId: user.user.id,
    deviceId: body.deviceId,
    pepper,
    // The digest, never the verifier. A column holding the verifier verbatim
    // would let a database dump release peppers, which is the one thing this
    // table's secrecy is for.
    verifierHash: await hashUnlockVerifier(fromBase64Url(body.verifier)),
  });

  return { device: toPinDevice(device), pepper: toBase64Url(pepper) };
}

/**
 * What one PIN attempt resolved to, in the client's terms.
 *
 * ── Why three of the four are not errors ──
 * The caller is authenticated; what is being decided is whether to release a
 * pepper, and every outcome below is state the browser must *act* on rather than
 * merely report. A wrong PIN leaves a working enrolment and a number to show; a
 * burn and an unknown device both mean the local wrap is now dead and has to be
 * cleared before the passphrase form is offered. Collapsing them into one 401
 * would leave a dead wrap in `localStorage` suppressing the PIN option forever,
 * or clear a perfectly good one on the first typo — and, because `lib/api.ts`
 * sends a 401 to the sign-in page, would sign somebody out for mistyping four
 * digits of six.
 *
 * The refusals that *are* errors stay errors: an unauthenticated caller never
 * reaches this, and the edge rate limiter throws before it does.
 */
export type PinAttemptResult =
  | {
      outcome: 'unlocked';
      /** The pepper this wrap was built under. Already superseded on the row. */
      pepper: string;
      /** The pepper the next wrap must be built under. The client re-wraps now. */
      nextPepper: string;
      unlockedUntil: string;
    }
  | { outcome: 'wrong'; attemptsRemaining: number }
  | { outcome: 'burned' }
  | { outcome: 'unknown' };

/**
 * Compares a presented PIN verifier, counts the attempt, and — on a match —
 * releases the pepper and unlocks the session.
 *
 * ── The counting is the control ──
 * Six digits is 10^6 candidates, so the only thing standing between a guesser
 * and a User Key is that the guesses are *online* and finite. The compare and
 * the increment happen inside one transaction on the row
 * (`attemptPinUnlock`), because a read-then-write would hand a scripted attacker
 * as many guesses per round trip as they cared to open connections. At five the
 * row is deleted rather than locked out: the pepper is gone, the browser's wrap
 * stops being openable by anybody who never saw its pepper, and the passphrase
 * is the only way back in.
 *
 * ── Why the session is unlocked here rather than after the unwrap ──
 * It has to be. Unlike the passphrase and passkey paths, this client cannot
 * prove it can open anything *before* the request — the pepper it needs is what
 * the request is for. So the verifier is the proof, exactly as it is for a
 * passphrase, and the session is marked unlocked on the same terms. A browser
 * whose wrap then fails to open calls `lockVault` itself rather than sitting on
 * an unlocked session it cannot use.
 *
 * ── Why a success hands back two peppers ──
 * Because a pepper that never changes is a pepper that only has to be captured
 * once. It crosses the wire on every unlock, so an attacker who saw one — a
 * compromised extension, a debug proxy, a heap dump — plus a copy of that
 * browser's `localStorage` would hold a pair that no longer needs this server,
 * and revoking the enrolment afterwards would not take it away from them. So the
 * row is given a fresh pepper inside the same transaction that released the old
 * one, and the client, which is holding the User Key at exactly that moment,
 * re-wraps under the new one. The verifier is untouched: the same PIN and the
 * same salt, so nothing the user does changes.
 */
export async function attemptDevicePin(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  body: { deviceId: string; verifier: string },
): Promise<PinAttemptResult> {
  const keys = await requireVault(services, user.user.id);
  const presented = fromBase64Url(body.verifier);

  const nextPepper = generatePinPepper();
  const outcome = await attemptPinUnlock(services.db, {
    userId: user.user.id,
    deviceId: body.deviceId,
    // Constant-time, and run inside the row lock so the count cannot be raced.
    matches: (verifierHash) => unlockVerifierMatches(presented, toBytes(verifierHash)),
    // Minted per request rather than per success: the row lock is where the
    // decision is made, and generating 32 bytes that a miss throws away is
    // cheaper than reaching back out of the transaction to ask for them.
    nextPepper,
  });

  if (outcome.status !== 'ok') {
    services.log.at('attemptDevicePin').warn(
      `Rejected a device PIN (${outcome.status}) — five wrong tries destroy the enrolment and ` +
        'leave the passphrase as the only way in',
      // The outcome, never the verifier and never the PIN. The user id is on
      // the line already, bound by the route wrapper.
      { reason: outcome.status },
    );

    return outcome.status === 'wrong'
      ? { outcome: 'wrong', attemptsRemaining: outcome.attemptsRemaining }
      : { outcome: outcome.status };
  }

  const now = new Date();
  await markSessionUnlocked(services.db, user.sessionId, now);

  return {
    outcome: 'unlocked',
    pepper: toBase64Url(toBytes(outcome.pepper)),
    nextPepper: toBase64Url(nextPepper),
    unlockedUntil: vaultUnlockExpiryFrom({
      vaultUnlockedAt: now,
      lastSeenAt: now,
      autoLockMinutes: keys.autoLockMinutes,
    }).toISOString(),
  };
}

/** Every browser this account has enrolled. Never a pepper, never a digest. */
export async function listDevicePins(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
): Promise<PinDevicePayload[]> {
  return (await listPinPeppers(services.db, user.user.id)).map(toPinDevice);
}

/**
 * Turns off one browser's PIN — this one, or another the account owns.
 *
 * The repository scopes by user, so a device id belonging to somebody else is
 * indistinguishable here from one belonging to nobody, and both answer the same
 * 404 (threat T2). It can never strand an account: the passphrase wrap always
 * exists and has no removal path.
 */
export async function disableDevicePin(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  deviceId: string,
): Promise<void> {
  const removed = await disablePinPepper(services.db, user.user.id, deviceId);
  if (!removed) throw errors.notFound('no such pin enrolment');
}

/** Turns off every PIN this account has. Returns how many browsers lost one. */
export async function revokeDevicePins(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
): Promise<number> {
  return revokeAllPinPeppers(services.db, user.user.id);
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

/**
 * Changes how long a vault may sit idle before it locks.
 *
 * `null` clears the preference back to the default rather than storing the
 * default's current value — the two are different facts, and only the first
 * follows the default if it is ever reconsidered.
 *
 * Anything else is **clamped, not refused**. The floor and the ceiling are a
 * security decision this server owns, and a 422 would be the wrong answer to a
 * request that expresses a perfectly clear intention ("lock me quickly"): it
 * would leave the account on whatever it had before, which is looser than what
 * was asked for. Failing towards the safer number is the only direction worth
 * having. The stored value is checked again by the table's CHECK.
 */
export async function setAutoLock(
  services: ServiceContext,
  user: Extract<Principal, { kind: 'user' }>,
  minutes: number | null,
): Promise<number> {
  const stored = minutes === null ? null : clampAutoLockMinutes(minutes);
  const updated = await setAutoLockMinutes(services.db, user.user.id, stored);
  // No vault row: there is nothing an idle lock could ask for. The setup
  // ceremony is the answer, not a silently created preference.
  if (updated === null) {
    throw errors.badRequest('Set up your vault first; auto-lock protects it.');
  }

  // The effective number, for the audit record and the response — the caller
  // asked for something that may have been clamped, and reporting what it asked
  // for would put a figure in the audit log that no gate ever used.
  return clampAutoLockMinutes(updated.autoLockMinutes);
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
