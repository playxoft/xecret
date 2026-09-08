'use client';

import {
  CURRENT_KDF_PARAMS,
  DecryptionError,
  decodePublicKey,
  derivePasskeyWrapKey,
  derivePassphraseWrapKey,
  deriveRecoveryKey,
  deriveStretchedKey,
  deriveUkUnlockVerifier,
  deriveUnlockVerifier,
  encodePublicKey,
  fromBase64Url,
  generateEncryptionKeyPair,
  generateKdfSalt,
  generateRecoveryCodes,
  generateSigningKeyPair,
  generateUserKey,
  parseKdfParams,
  parseRecoveryCode,
  RecoveryCodeError,
  recoveryLookupHash,
  toBase64Url,
  unwrapPrivateKey,
  unwrapUserKey,
  wrapPrivateKey,
  wrapUserKey,
  zeroize,
} from '@xecret/core/crypto/client';
import type { Argon2idProvider, Bytes, RecoveryCode } from '@xecret/core/crypto/client';

import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { argon2idProvider } from './argon2';
import { holdVaultKeys, releaseVaultKeys } from './key-store';
import type { VaultKeyMaterial } from './key-store';

/**
 * Every vault operation, as one composition of `@xecret/core/crypto/client` and
 * `/api/auth/vault*`.
 *
 * ── The rule this file exists to keep ──
 * No component reaches for a crypto primitive, and no component reaches for a
 * vault endpoint. Both happen here, in pairs, because the pairing is the part
 * that has to be right: a passphrase change that uploaded a new verifier without
 * the matching wrap would lock the account out of its own vault, and a recovery
 * that completed without reissuing the kit would leave four live codes on a
 * sheet of paper the user has just proved they mishandled. The endpoints enforce
 * what they can, but they hold no key — the invariant is this side's to keep.
 *
 * Nothing here reimplements a primitive. Every derive, wrap and unwrap is a call
 * into `packages/core`, whose test vectors are the definition of the format.
 *
 * ── The `argon2id` seam ──
 * Each function that stretches a passphrase takes an optional provider, the same
 * seam `deriveStretchedKey` defines, defaulting to the worker-backed one. It is
 * there so these compositions can be tested at negligible cost against real
 * HKDF, real AES-GCM and real recovery codes — the parts where a mistake is
 * silent — without paying a second of Argon2id per assertion.
 */

/* ────────────────────────────── wire shapes ────────────────────────────── */

/**
 * The bodies these routes answer with.
 *
 * Declared here rather than imported from `@/server/schemas/vault`, matching
 * every other screen in the application: the server module pulls in `zod/mini`
 * and the repository types, and a client bundle should not depend on a type-only
 * import staying type-only. `docs/architecture/api.md` §4 is the contract both
 * sides are written against.
 */
export interface VaultStatus {
  configured: boolean;
  unlocked: boolean;
  /** ISO 8601. When the current unlock lapses; `null` while locked. */
  unlockedUntil: string | null;
  /** Minutes of idleness before the dashboard locks itself; `0` never. */
  autoLockMinutes: number;
}

export interface VaultPasskey {
  id: string;
  credentialId: string;
  label: string;
  transports: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** The `prf` wrap this credential's PRF output opens. */
  wrap: string;
}

export interface VaultMaterial {
  encAlgorithm: string;
  encPublicKey: string;
  encPrivateKeyEnc: string;
  signAlgorithm: string;
  signPublicKey: string;
  signPrivateKeyEnc: string;
  kdfSalt: string;
  kdfParams: unknown;
  passphraseWrap: string;
  recoveryCodesRemaining: number;
  passkeys: VaultPasskey[];
}

export interface VaultResponse {
  vault: VaultStatus;
  material: VaultMaterial | null;
}

/** What every flow that ends in an unlocked vault hands back. */
export interface UnlockedVault {
  vault: VaultStatus;
  material: VaultMaterial;
  /** Present only where a new kit was issued — setup, recovery, regeneration. */
  codes?: readonly RecoveryCode[];
}

/* ─────────────────────────────── reading ─────────────────────────────── */

/** The vault's state, and — when it exists — the material an unlock needs. */
export function fetchVault(): Promise<VaultResponse> {
  return api.get<VaultResponse>(apiPath.vault());
}

/* ─────────────────────────── the setup ceremony ─────────────────────────── */

/**
 * Everything the browser generates at setup, before anything is uploaded.
 *
 * Split out from {@link setupVault} so the ceremony's cryptography can be
 * asserted against the wraps it produces — that the passphrase wrap opens with a
 * re-derived key, that each of the five recovery wraps opens with its own code,
 * that the private keys come back out under the User Key — without a network.
 * The API call is the part that has nothing left to get wrong.
 */
export async function buildVaultCreate(params: {
  userId: string;
  passphrase: string;
  argon2id?: Argon2idProvider;
}): Promise<{ body: unknown; codes: RecoveryCode[]; keys: VaultKeyMaterial }> {
  const userKey = generateUserKey();
  const encryption = generateEncryptionKeyPair();
  const signing = generateSigningKeyPair();

  const kdfSalt = generateKdfSalt();
  const stretched = await stretch(params.passphrase, kdfSalt, CURRENT_KDF_PARAMS, params.argon2id);

  try {
    const [wrapKey, unlockVerifier] = await Promise.all([
      derivePassphraseWrapKey(stretched),
      deriveUnlockVerifier(stretched),
    ]);

    // The second unlock proof, recorded by this ceremony and only by this one.
    // A passkey unlock opens the User Key directly and never derives `SK`, so it
    // cannot produce `unlockVerifier`; this is the branch it sends instead. It
    // survives a passphrase change and a recovery untouched, because both
    // re-wrap the User Key rather than replacing it.
    const ukUnlockVerifier = await deriveUkUnlockVerifier(userKey);

    const [passphraseWrap, encPrivateKeyEnc, signPrivateKeyEnc] = await Promise.all([
      wrapUserKey({ wrapKey, userKey, context: { userId: params.userId, wrapKind: 'passphrase' } }),
      wrapPrivateKey({
        userKey,
        privateKey: encryption.privateKey,
        userId: params.userId,
        purpose: 'encryption',
      }),
      wrapPrivateKey({
        userKey,
        privateKey: signing.privateKey,
        userId: params.userId,
        purpose: 'signing',
      }),
    ]);

    zeroize(wrapKey);

    const { codes, wraps } = await buildRecoveryKit({ userId: params.userId, userKey });

    return {
      body: {
        encPublicKey: encodePublicKey(encryption.publicKey),
        encPrivateKeyEnc,
        signPublicKey: encodePublicKey(signing.publicKey),
        signPrivateKeyEnc,
        kdfSalt: toBase64Url(kdfSalt),
        kdfParams: CURRENT_KDF_PARAMS,
        unlockVerifier: toBase64Url(unlockVerifier),
        ukUnlockVerifier: toBase64Url(ukUnlockVerifier),
        passphraseWrap,
        recoveryWraps: wraps,
      },
      codes,
      keys: {
        userId: params.userId,
        userKey,
        encPrivateKey: encryption.privateKey,
        encPublicKey: encryption.publicKey,
        signPrivateKey: signing.privateKey,
        signPublicKey: signing.publicKey,
      },
    };
  } finally {
    zeroize(stretched);
  }
}

/**
 * Runs the ceremony: generate, upload, and hold the keys.
 *
 * One request, because a vault is not meaningful in pieces — see
 * `vaultCreateSchema`. The keys are held only after the upload succeeds: a
 * browser holding a User Key the server never recorded would present an unlocked
 * dashboard over a vault that does not exist.
 */
export async function setupVault(params: {
  userId: string;
  passphrase: string;
  argon2id?: Argon2idProvider;
}): Promise<UnlockedVault> {
  const { body, codes, keys } = await buildVaultCreate(params);

  try {
    const response = await api.post<VaultResponse>(apiPath.vault(), body);
    holdVaultKeys(keys);
    return { vault: response.vault, material: requireMaterial(response), codes };
  } catch (cause) {
    // The upload failed, so these keys open nothing anybody will ever store.
    zeroize(keys.userKey);
    zeroize(keys.encPrivateKey);
    zeroize(keys.signPrivateKey);
    throw cause;
  }
}

/* ──────────────────────────────── unlock ──────────────────────────────── */

/**
 * Opens the vault with a passphrase, and tells the server it happened.
 *
 * ── The order matters ──
 * The User Key is unwrapped *first*, in the browser. Only if that succeeds is
 * the verifier sent. Doing it the other way round would spend one of the
 * account's rate-limited attempts on a passphrase this client could have
 * rejected for free, and would report "unlocked" to the server in the one case
 * where the browser cannot decrypt anything.
 */
export async function unlockWithPassphrase(params: {
  userId: string;
  passphrase: string;
  material: VaultMaterial;
  argon2id?: Argon2idProvider;
}): Promise<VaultStatus> {
  const kdfParams = parseKdfParams(params.material.kdfParams);
  const stretched = await stretch(
    params.passphrase,
    fromBase64Url(params.material.kdfSalt),
    kdfParams,
    params.argon2id,
  );

  let unlockVerifier: Bytes;
  let userKey: Bytes;
  try {
    const wrapKey = await derivePassphraseWrapKey(stretched);
    try {
      userKey = await unwrapUserKey({
        wrapKey,
        blob: params.material.passphraseWrap,
        context: { userId: params.userId, wrapKind: 'passphrase' },
      });
    } finally {
      zeroize(wrapKey);
    }
    unlockVerifier = await deriveUnlockVerifier(stretched);
  } finally {
    zeroize(stretched);
  }

  return finishUnlock({
    userId: params.userId,
    userKey,
    material: params.material,
    unlockVerifier,
  });
}

/**
 * Why the passkey button on the unlock screen is still a notice.
 *
 * ── What used to be true, and no longer is ──
 * This constant was written when the asymmetry was a **server** one.
 * `POST /api/auth/vault/unlock` accepted only the unlock verifier, which is
 * `HKDF(SK, "xecret.v2.unlock-verifier")` — a branch of the Stretched Key, which
 * exists only when a passphrase has been typed. A passkey unlock derives no
 * `SK`: what its PRF output opens is blob type 3, and blob type 3 holds the User
 * Key, with no derivation back to `SK` by construction. So a browser could
 * genuinely open the vault with a passkey and still hold nothing the endpoint
 * would accept.
 *
 * That gap is now closed. The specification registers a second branch,
 * `xecret.v2.uk-unlock-verifier`, taking the UK as input keying material;
 * `user_keys.uk_unlock_verifier_hash` stores its digest; and the unlock route
 * accepts `{ ukUnlockVerifier }` as an alternative body, compared against that
 * digest and counted against the same lockout. {@link buildVaultCreate} already
 * uploads it, so every vault created by this build can be unlocked either way.
 *
 * ── What is left, and it is client work ──
 * The screen. {@link unlockWithPasskey} opens the User Key and deliberately does
 * not hold it or call the endpoint, because its other caller is enrolment, which
 * needs the unwrap as a proof and nothing more. Turning that into a real unlock
 * needs a caller that derives `deriveUkUnlockVerifier(userKey)`, hands both to
 * {@link finishUnlock}, and a `vault-unlock.tsx` that offers a button with PRF
 * feature detection and its own failure states rather than the notice below.
 *
 * Until that exists this sentence is what the screen says, and it stays accurate
 * about the part that matters to the person reading it: the button is not there
 * yet. It no longer claims the server cannot accept one.
 */
export const PASSKEY_UNLOCK_UNAVAILABLE =
  'One-touch unlock with a passkey is not available in this build yet. Your enrolled passkeys ' +
  'already hold a working copy of your key and nothing needs re-enrolling — use your passphrase ' +
  'for now.';

/**
 * Opens the User Key with a passkey's PRF output.
 *
 * Used by enrolment to prove the wrap it just uploaded actually opens, and it is
 * the half of one-touch unlock that works today. It deliberately does **not**
 * call the unlock endpoint or hold the keys, because enrolment needs the unwrap
 * as a proof and nothing more. The unlock the server would now accept is
 * `deriveUkUnlockVerifier` of what this returns — see {@link
 * PASSKEY_UNLOCK_UNAVAILABLE} for what is left to build on top of it.
 *
 * The PRF output is zeroized on the way out either way. It is the key to this
 * account's vault and it has no further use once the wrap is open.
 */
export async function unlockWithPasskey(params: {
  userId: string;
  material: VaultMaterial;
  credentialId: string;
  prfOutput: Bytes;
}): Promise<Bytes> {
  const passkey = params.material.passkeys.find(
    (candidate) => candidate.credentialId === params.credentialId,
  );
  if (passkey === undefined) {
    // The same error a failed unwrap raises, and deliberately: "that passkey is
    // not one of yours" and "that passkey's wrap did not open" are the same
    // outcome to the person holding it, and telling them apart would be an
    // oracle for which credential ids belong to this account.
    throw new DecryptionError();
  }

  const wrapKey = await derivePasskeyWrapKey(params.prfOutput);
  try {
    return await unwrapUserKey({
      wrapKey,
      blob: passkey.wrap,
      context: {
        userId: params.userId,
        wrapKind: 'prf',
        credentialIdB64Url: passkey.credentialId,
      },
    });
  } finally {
    zeroize(wrapKey);
    zeroize(params.prfOutput);
  }
}

/**
 * Unwraps the private keys, holds everything, and marks the session unlocked.
 *
 * Shared by every route into an unlocked vault — passphrase, recovery, and the
 * setup ceremony's implicit unlock — because each of them has to do all three,
 * and the one that forgot the third would leave a browser full of keys against a
 * session the API refuses.
 */
async function finishUnlock(params: {
  userId: string;
  userKey: Bytes;
  material: VaultMaterial;
  unlockVerifier: Bytes;
}): Promise<VaultStatus> {
  const keys = await openPrivateKeys(params.userId, params.userKey, params.material);

  const response = await api.post<{ vault: VaultStatus }>(apiPath.vaultUnlock(), {
    unlockVerifier: toBase64Url(params.unlockVerifier),
  });

  holdVaultKeys(keys);
  return response.vault;
}

/** The User Key plus both private keys, ready for {@link holdVaultKeys}. */
export async function openPrivateKeys(
  userId: string,
  userKey: Bytes,
  material: VaultMaterial,
): Promise<VaultKeyMaterial> {
  const [encPrivateKey, signPrivateKey] = await Promise.all([
    unwrapPrivateKey({ userKey, blob: material.encPrivateKeyEnc, userId, purpose: 'encryption' }),
    unwrapPrivateKey({ userKey, blob: material.signPrivateKeyEnc, userId, purpose: 'signing' }),
  ]);

  return {
    userId,
    userKey,
    encPrivateKey,
    encPublicKey: decodePublicKey(material.encPublicKey),
    signPrivateKey,
    signPublicKey: decodePublicKey(material.signPublicKey),
  };
}

/* ───────────────────────────────── lock ───────────────────────────────── */

/**
 * Locks: the server's flag, and this browser's keys.
 *
 * The zeroization happens in a `finally`, so a failed request still clears the
 * keys. That direction is the only safe one — a browser that kept its User Key
 * because the network was down would be exactly the unattended laptop the idle
 * timer exists for.
 */
export async function lockVault(everywhere = false): Promise<number> {
  try {
    const response = await api.post<{ locked: number }>(apiPath.vaultLock(), { everywhere });
    return response.locked;
  } finally {
    releaseVaultKeys();
  }
}

/* ────────────────────────── passphrase change ────────────────────────── */

/**
 * Re-wraps the User Key under a new passphrase.
 *
 * The User Key does not change, which is the whole point of the wrap
 * indirection: nothing sealed to this account is re-encrypted, the recovery
 * codes keep working, and other devices stay unlocked. A new salt and the
 * current parameters travel with it, because a passphrase change is the natural
 * moment to re-derive at today's cost.
 */
export async function changePassphrase(params: {
  userId: string;
  userKey: Bytes;
  material: VaultMaterial;
  currentPassphrase: string;
  newPassphrase: string;
  argon2id?: Argon2idProvider;
}): Promise<{ vault: VaultStatus; material: VaultMaterial }> {
  const currentParams = parseKdfParams(params.material.kdfParams);
  const currentStretched = await stretch(
    params.currentPassphrase,
    fromBase64Url(params.material.kdfSalt),
    currentParams,
    params.argon2id,
  );

  let currentUnlockVerifier: Bytes;
  try {
    // Proved locally before it is proved to the server, for the same reason
    // unlock does it in that order: a wrong current passphrase must not spend an
    // attempt from the account's lockout budget.
    const currentWrapKey = await derivePassphraseWrapKey(currentStretched);
    try {
      zeroize(
        await unwrapUserKey({
          wrapKey: currentWrapKey,
          blob: params.material.passphraseWrap,
          context: { userId: params.userId, wrapKind: 'passphrase' },
        }),
      );
    } finally {
      zeroize(currentWrapKey);
    }
    currentUnlockVerifier = await deriveUnlockVerifier(currentStretched);
  } finally {
    zeroize(currentStretched);
  }

  const kdfSalt = generateKdfSalt();
  const stretched = await stretch(
    params.newPassphrase,
    kdfSalt,
    CURRENT_KDF_PARAMS,
    params.argon2id,
  );

  try {
    const [wrapKey, unlockVerifier] = await Promise.all([
      derivePassphraseWrapKey(stretched),
      deriveUnlockVerifier(stretched),
    ]);

    const passphraseWrap = await wrapUserKey({
      wrapKey,
      userKey: params.userKey,
      context: { userId: params.userId, wrapKind: 'passphrase' },
    });
    zeroize(wrapKey);

    const response = await api.post<VaultResponse>(apiPath.vaultPassphrase(), {
      currentUnlockVerifier: toBase64Url(currentUnlockVerifier),
      unlockVerifier: toBase64Url(unlockVerifier),
      kdfSalt: toBase64Url(kdfSalt),
      kdfParams: CURRENT_KDF_PARAMS,
      passphraseWrap,
    });

    return { vault: response.vault, material: requireMaterial(response) };
  } finally {
    zeroize(stretched);
  }
}

/* ──────────────────────────────── recovery ──────────────────────────────── */

/** The five codes, and the wraps that address them. */
export async function buildRecoveryKit(params: { userId: string; userKey: Bytes }): Promise<{
  codes: RecoveryCode[];
  wraps: { lookupHash: string; wrap: string }[];
}> {
  const codes = generateRecoveryCodes();

  const wraps = await Promise.all(
    codes.map(async (code) => {
      const lookupHash = await recoveryLookupHash(code.codeBytes);
      const wrapKey = await deriveRecoveryKey(code.codeBytes);
      try {
        return {
          lookupHash: toBase64Url(lookupHash),
          wrap: await wrapUserKey({
            wrapKey,
            userKey: params.userKey,
            context: { userId: params.userId, wrapKind: 'recovery', lookupHash },
          }),
        };
      } finally {
        zeroize(wrapKey);
      }
    }),
  );

  return { codes, wraps };
}

/**
 * Parses a typed recovery code, forgivingly.
 *
 * A thin wrapper over `parseRecoveryCode` that turns its two failure reasons
 * into the two sentences the form shows. It exists so the form never has to
 * catch a crypto error, and so the distinction the primitive draws — "you
 * mistyped it" versus "that is not one of our codes" — survives into the UI,
 * which is where it does its work.
 */
export function readRecoveryCode(input: string): { code: RecoveryCode } | { problem: string } {
  try {
    return { code: parseRecoveryCode(input) };
  } catch (cause) {
    if (cause instanceof RecoveryCodeError) return { problem: cause.message };
    return { problem: 'That is not a valid code' };
  }
}

/** Step one: resolve the code to the wrap it opens, and the material beside it. */
export async function beginRecovery(
  code: RecoveryCode,
): Promise<{ wrap: string; material: VaultMaterial; lookupHash: Bytes }> {
  const lookupHash = await recoveryLookupHash(code.codeBytes);
  const response = await api.post<{ wrap: string; material: VaultMaterial }>(
    apiPath.vaultRecovery(),
    { lookupHash: toBase64Url(lookupHash) },
  );
  return { ...response, lookupHash };
}

/** Opens the User Key with a redeemed code. Throws `DecryptionError` on failure. */
export async function openRecoveryWrap(params: {
  userId: string;
  code: RecoveryCode;
  lookupHash: Bytes;
  wrap: string;
}): Promise<Bytes> {
  const wrapKey = await deriveRecoveryKey(params.code.codeBytes);
  try {
    return await unwrapUserKey({
      wrapKey,
      blob: params.wrap,
      context: {
        userId: params.userId,
        wrapKind: 'recovery',
        lookupHash: params.lookupHash,
      },
    });
  } finally {
    zeroize(wrapKey);
  }
}

/**
 * Step two: a new passphrase and a whole new kit, in one request.
 *
 * Inseparable by design. Somebody here has lost control of their passphrase, so
 * stopping at "you are in" would leave an account whose only credential is a
 * piece of paper — and all five wraps hold the same User Key, so a kit with one
 * code spent is a kit that four other pieces of paper still open. The endpoint
 * takes both halves in one body precisely so this client cannot skip one.
 */
export async function completeRecovery(params: {
  userId: string;
  userKey: Bytes;
  lookupHash: Bytes;
  newPassphrase: string;
  argon2id?: Argon2idProvider;
}): Promise<UnlockedVault> {
  const kdfSalt = generateKdfSalt();
  const stretched = await stretch(
    params.newPassphrase,
    kdfSalt,
    CURRENT_KDF_PARAMS,
    params.argon2id,
  );

  try {
    const [wrapKey, unlockVerifier] = await Promise.all([
      derivePassphraseWrapKey(stretched),
      deriveUnlockVerifier(stretched),
    ]);

    const passphraseWrap = await wrapUserKey({
      wrapKey,
      userKey: params.userKey,
      context: { userId: params.userId, wrapKind: 'passphrase' },
    });
    zeroize(wrapKey);

    const { codes, wraps } = await buildRecoveryKit({
      userId: params.userId,
      userKey: params.userKey,
    });

    const response = await api.post<VaultResponse>(apiPath.vaultRecoveryComplete(), {
      lookupHash: toBase64Url(params.lookupHash),
      unlockVerifier: toBase64Url(unlockVerifier),
      kdfSalt: toBase64Url(kdfSalt),
      kdfParams: CURRENT_KDF_PARAMS,
      passphraseWrap,
      recoveryWraps: wraps,
    });

    const material = requireMaterial(response);
    holdVaultKeys(await openPrivateKeys(params.userId, params.userKey, material));

    return { vault: response.vault, material, codes };
  } finally {
    zeroize(stretched);
  }
}

/**
 * Reissues the kit from an unlocked session, with the passphrase re-entered.
 *
 * The re-entry is the sudo-mode gate, not a formality: printing a fresh set of
 * codes at somebody's unattended desk is one of the few acts that would hand an
 * attacker durable access surviving a passphrase change.
 */
export async function regenerateRecoveryCodes(params: {
  userId: string;
  userKey: Bytes;
  material: VaultMaterial;
  passphrase: string;
  argon2id?: Argon2idProvider;
}): Promise<{ codes: readonly RecoveryCode[]; remaining: number }> {
  const kdfParams = parseKdfParams(params.material.kdfParams);
  const stretched = await stretch(
    params.passphrase,
    fromBase64Url(params.material.kdfSalt),
    kdfParams,
    params.argon2id,
  );

  let unlockVerifier: Bytes;
  try {
    unlockVerifier = await deriveUnlockVerifier(stretched);
  } finally {
    zeroize(stretched);
  }

  const { codes, wraps } = await buildRecoveryKit({
    userId: params.userId,
    userKey: params.userKey,
  });

  const response = await api.put<{ recoveryCodesRemaining: number }>(apiPath.vaultRecovery(), {
    unlockVerifier: toBase64Url(unlockVerifier),
    recoveryWraps: wraps,
  });

  return { codes, remaining: response.recoveryCodesRemaining };
}

/* ──────────────────────────────── passkeys ──────────────────────────────── */

/** Wraps the User Key under a passkey's PRF output and enrols it. */
export async function enrollPasskeyWrap(params: {
  userId: string;
  userKey: Bytes;
  label: string;
  credentialId: string;
  transports: string[] | undefined;
  prfOutput: Bytes;
}): Promise<VaultPasskey> {
  const wrapKey = await derivePasskeyWrapKey(params.prfOutput);
  let wrap: string;
  try {
    wrap = await wrapUserKey({
      wrapKey,
      userKey: params.userKey,
      context: {
        userId: params.userId,
        wrapKind: 'prf',
        credentialIdB64Url: params.credentialId,
      },
    });
  } finally {
    zeroize(wrapKey);
    zeroize(params.prfOutput);
  }

  const body: Record<string, unknown> = {
    credentialId: params.credentialId,
    label: params.label,
    wrap,
  };
  // Absent rather than empty when the authenticator declared nothing — the
  // schema treats an absent list as "unknown", which is the truth.
  if (params.transports !== undefined) body['transports'] = params.transports;

  const response = await api.post<{ passkey: VaultPasskey }>(apiPath.vaultPasskeys(), body);
  return response.passkey;
}

export function removeVaultPasskey(passkeyId: string): Promise<void> {
  return api.delete<void>(`${apiPath.vaultPasskeys()}/${encodeURIComponent(passkeyId)}`);
}

export async function setAutoLockMinutes(minutes: number): Promise<VaultStatus> {
  const response = await api.patch<{ vault: VaultStatus }>(apiPath.vault(), {
    autoLockMinutes: minutes,
  });
  return response.vault;
}

/* ──────────────────────────── failure messages ──────────────────────────── */

/**
 * What to tell somebody whose unlock did not work.
 *
 * ── Honesty, and the one thing this must not say ──
 * A wrong passphrase, a wrap swapped in the database and a corrupted record are
 * one indistinguishable outcome in the browser — `unwrapUserKey` says so — and
 * inventing a distinction here would be a guess presented as a diagnosis. So a
 * failed unwrap gets one sentence, and it is the true one.
 *
 * The server's own message is passed through verbatim when it has one, and that
 * is deliberate: the lockout text (*"Too many failed attempts. Try again in 3
 * minutes."*) is computed from the account's real backoff state, and rewriting
 * it here would either drop the wait or invent a different one. What this never
 * does is report the *attempt count* — the lock screen's header says why: a
 * countdown tells somebody guessing exactly how much room they have left, and
 * the person who knows their own passphrase has no use for it.
 *
 * Pure, and exported, so the mapping can be asserted directly.
 */
export function describeUnlockFailure(cause: unknown): string {
  if (cause instanceof DecryptionError) {
    return 'That passphrase did not open your vault. Check for a typo, and remember it is case-sensitive.';
  }

  if (isApiError(cause)) {
    // `rate_limited` carries the backoff; `unauthenticated` is the server
    // disagreeing with a verifier the browser thought was right, which happens
    // when the material on screen is stale. Both are better in the server's
    // words than in ours.
    if (cause.code === 'network_error') {
      return 'Could not reach xecret. Your vault was not unlocked — check your connection and try again.';
    }
    return cause.message;
  }

  return 'Your vault could not be unlocked. Please try again.';
}

/* ──────────────────────────────── internals ──────────────────────────────── */

function stretch(
  passphrase: string,
  salt: Bytes,
  params: unknown,
  argon2id: Argon2idProvider | undefined,
): Promise<Bytes> {
  return deriveStretchedKey({
    passphrase,
    salt,
    params,
    argon2id: argon2id ?? argon2idProvider,
  });
}

/**
 * The material a mutation answers with, or a failure.
 *
 * These four routes always return it — `vault-service.ts` builds it after every
 * write — so a `null` here is a contract violation rather than a state worth
 * rendering, and failing loudly beats carrying a `null` into the key store.
 */
function requireMaterial(response: VaultResponse): VaultMaterial {
  if (response.material === null) {
    throw new Error('The server did not return the vault material.');
  }
  return response.material;
}
