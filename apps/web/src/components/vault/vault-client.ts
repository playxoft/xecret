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
import { PasskeyCancelledError, PasskeyUnsupportedError } from './passkey';
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

/**
 * Whether the second material is a *different vault state* from the first.
 *
 * ── The wrong error message this exists to stop ──
 * A tab open since this morning holds the wraps it read this morning. Change the
 * passphrase on a laptop, or recover on a phone, and the salt and the passphrase
 * wrap both move — so the correct new passphrase, typed into the old tab,
 * derives the wrong key and fails to unwrap. What that tab used to say was
 * "check for a typo": it sent somebody to doubt a passphrase they had just set,
 * and every retry spent another attempt from a server-side lockout budget that
 * no correct passphrase could ever satisfy.
 *
 * Two fields, and only two. The salt is what the passphrase is stretched with
 * and the wrap is what the derived key opens; any change to either makes every
 * previously-valid credential fail against this copy. `recoveryCodesRemaining`
 * and the passkey list move for reasons that have nothing to do with whether a
 * passphrase still works, and treating them as supersession would tell somebody
 * their passphrase had changed because they enrolled a passkey elsewhere.
 */
export function materialSupersedes(before: VaultMaterial, after: VaultMaterial): boolean {
  return before.kdfSalt !== after.kdfSalt || before.passphraseWrap !== after.passphraseWrap;
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
    proof: { kind: 'passphrase', verifier: unlockVerifier },
  });
}

/**
 * Opens the User Key with a passkey's PRF output, and nothing more.
 *
 * The unwrap on its own, without the endpoint and without touching the key
 * store, because it has a second caller that wants exactly this: enrolment
 * proving that the wrap it just uploaded actually opens. {@link
 * unlockWithPasskey} is the same unwrap with the unlock built on top.
 *
 * The PRF output is zeroized on the way out either way. It is the key to this
 * account's vault and it has no further use once the wrap is open.
 */
export async function openPasskeyWrap(params: {
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
 * One-touch unlock: a passkey's PRF output all the way to an unlocked session.
 *
 * ── Which proof this sends, and why it is a different one ──
 * Not `unlockVerifier`. That value is `HKDF(SK, "xecret.v2.unlock-verifier")`, a
 * branch of the Stretched Key, and a passkey unlock never derives `SK` — what
 * its PRF opens is blob type 3, which holds the **User Key**, and there is no
 * way back from the UK to `SK`. That one-way relationship is not an obstacle to
 * work around; it is the property that makes a passphrase change a single
 * re-wrap instead of a re-encryption of everything.
 *
 * So this sends `ukUnlockVerifier = HKDF(UK, "xecret.v2.uk-unlock-verifier")`,
 * the branch the specification registers for exactly this case, against a digest
 * the setup ceremony recorded. It concedes nothing to a server that stores it:
 * whoever can compute this already holds the User Key, so the proof is strictly
 * weaker than the capability it attests to.
 *
 * The unwrap happens first and the request second, for the same reason the
 * passphrase path does it in that order — a PRF output that opens nothing must
 * not spend one of the account's rate-limited attempts.
 */
export async function unlockWithPasskey(params: {
  userId: string;
  material: VaultMaterial;
  credentialId: string;
  prfOutput: Bytes;
}): Promise<VaultStatus> {
  const userKey = await openPasskeyWrap(params);

  return finishUnlock({
    userId: params.userId,
    userKey,
    material: params.material,
    proof: { kind: 'passkey', verifier: await deriveUkUnlockVerifier(userKey) },
  });
}

/**
 * Which of the two unlock proofs a flow holds.
 *
 * A tagged pair rather than two optional fields, mirroring the union
 * `vaultUnlockSchema` accepts: the server refuses a body carrying both or
 * neither, so a client type that could express either state would be one whose
 * mistakes are only caught by a 422.
 */
export type UnlockProof =
  { kind: 'passphrase'; verifier: Bytes } | { kind: 'passkey'; verifier: Bytes };

/**
 * The unlock request body: exactly one field, named for the branch it came from.
 *
 * Pure and exported so it can be validated against the server's own schema in a
 * test. The field name is the whole of the protocol here — the two verifiers are
 * both 32 bytes of HKDF output and are indistinguishable by shape, so a builder
 * that put one under the other's name would produce a body that parses, reaches
 * the service, and is compared against the wrong digest.
 */
export function unlockBody(proof: UnlockProof): Record<string, string> {
  return proof.kind === 'passphrase'
    ? { unlockVerifier: toBase64Url(proof.verifier) }
    : { ukUnlockVerifier: toBase64Url(proof.verifier) };
}

/**
 * Unwraps the private keys, holds everything, and marks the session unlocked.
 *
 * Shared by every route into an unlocked vault — passphrase, passkey, recovery,
 * and the setup ceremony's implicit unlock — because each of them has to do all
 * three, and the one that forgot the third would leave a browser full of keys
 * against a session the API refuses.
 *
 * ── The failure path zeroizes, matching `setupVault`'s discipline ──
 * Nothing takes ownership of these bytes until {@link holdVaultKeys} does, and
 * the request between the two can fail — a lockout, a dropped connection, a
 * session revoked in the moment between the local unwrap and the POST. Every one
 * of those used to return a rejected promise while a User Key and two private
 * keys stayed in a closure with no owner, no wipe, and no way for any later lock
 * to find them. The `catch` is not defensive tidying: it is the difference
 * between "the unlock failed" and "the unlock failed and left the keys resident
 * for the life of the page".
 */
async function finishUnlock(params: {
  userId: string;
  userKey: Bytes;
  material: VaultMaterial;
  proof: UnlockProof;
}): Promise<VaultStatus> {
  const keys = await openPrivateKeys(params.userId, params.userKey, params.material);

  let response;
  try {
    response = await api.post<{ vault: VaultStatus }>(
      apiPath.vaultUnlock(),
      unlockBody(params.proof),
    );
  } catch (cause) {
    zeroize(keys.userKey);
    zeroize(keys.encPrivateKey);
    zeroize(keys.signPrivateKey);
    throw cause;
  }

  holdVaultKeys(keys);
  return response.vault;
}

/**
 * The User Key plus both private keys, ready for {@link holdVaultKeys}.
 *
 * ── Why the two unwraps are settled rather than raced ──
 * `Promise.all` rejects on the first failure and abandons the other promise,
 * which still resolves — to a decrypted private key nobody is holding and nobody
 * will ever wipe. A corrupt signing wrap therefore leaked the encryption key, on
 * the one path where the caller has just been told the vault did not open and has
 * every reason to believe nothing was produced. `allSettled` lets both finish so
 * that whichever succeeded can be overwritten before the failure is re-thrown.
 *
 * The User Key goes with them. It is the caller's until this function returns
 * successfully, and a caller that has just received a rejection has no handle to
 * wipe it with.
 */
export async function openPrivateKeys(
  userId: string,
  userKey: Bytes,
  material: VaultMaterial,
): Promise<VaultKeyMaterial> {
  const [enc, sign] = await Promise.allSettled([
    unwrapPrivateKey({ userKey, blob: material.encPrivateKeyEnc, userId, purpose: 'encryption' }),
    unwrapPrivateKey({ userKey, blob: material.signPrivateKeyEnc, userId, purpose: 'signing' }),
  ]);

  if (enc.status === 'rejected' || sign.status === 'rejected') {
    if (enc.status === 'fulfilled') zeroize(enc.value);
    if (sign.status === 'fulfilled') zeroize(sign.value);
    zeroize(userKey);
    // The encryption wrap's failure is reported when both failed: they fail for
    // the same reason — a User Key that is not this vault's — and reporting the
    // second would make the message depend on which promise settled first.
    throw enc.status === 'rejected'
      ? (enc.reason as unknown)
      : (sign as PromiseRejectedResult).reason;
  }

  return {
    userId,
    userKey,
    encPrivateKey: enc.value,
    encPublicKey: decodePublicKey(material.encPublicKey),
    signPrivateKey: sign.value,
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

/* ──────────────────────────────── reset ──────────────────────────────── */

/**
 * The phrase somebody has to type to destroy their own vault.
 *
 * ── Why it is written here as well as on the server ──
 * The server owns it — `VAULT_RESET_CONFIRMATION` in `server/schemas/vault.ts`
 * is what the request is actually checked against, and this copy has no
 * authority. It is repeated because importing that module would pull `zod/mini`
 * and the repository types into a browser bundle for one string, which is the
 * same reason every wire shape in this file is declared locally rather than
 * imported. A test pins the two together, so a change on either side fails
 * loudly instead of producing a form that cannot be satisfied.
 *
 * The phrase states the *act* rather than naming the actor, unlike account
 * deletion's "type your email". What ends here is the ability to read anything
 * encrypted under this vault; the account itself survives. Somebody typing their
 * own email out of muscle memory would have confirmed nothing they read.
 */
export const VAULT_RESET_CONFIRMATION = 'reset my vault';

/**
 * Why the reset cannot be submitted yet, or `null` when it can.
 *
 * Trims and lower-cases, matching `confirmationMatches` on the server: this is a
 * guard against a mistake, not against an attacker — anybody who can reach the
 * screen can read the phrase off it. What it buys is that the sentence has to be
 * read and typed rather than clicked past, on the one action in the product with
 * no undo of any kind.
 */
export function resetConfirmationProblem(typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed.length === 0) return `Type “${VAULT_RESET_CONFIRMATION}” to confirm.`;
  if (trimmed.toLowerCase() !== VAULT_RESET_CONFIRMATION) {
    return `That does not match. Type “${VAULT_RESET_CONFIRMATION}” exactly.`;
  }
  return null;
}

/**
 * Destroys this account's vault: the keys, every wrap, every passkey.
 *
 * ── This is not recovery, and nothing here may imply that it is ──
 * Nothing is decrypted and nothing is restored, because nothing can be. The data
 * became unreadable when the last recovery code was lost; what this changes is
 * only whether the account can be *used* afterwards, instead of being parked at
 * a lock screen whose every action fails. The endpoint's own header says the
 * same thing at greater length.
 *
 * The keys are released first rather than in a `finally`. There is nothing held
 * in this state — every caller arrives from a locked session — but a reset that
 * left a User Key resident because the request failed would be holding the one
 * key that no longer opens anything on the server.
 *
 * ── `idToken` is proof this is still the account's owner ──
 * The typed phrase guards against a mistake and nothing else — it is printed on
 * the screen above the field. This route is necessarily reachable from a *locked*
 * session, so without a second credential the one irreversible act in the product
 * would be available to anybody holding a stolen session cookie. The caller
 * obtains the token from `reauthenticateWithPassword` or
 * `reauthenticateWithGoogle` immediately before calling this, and the server
 * verifies its signature, its subject and how recently it was minted.
 *
 * It is a parameter rather than something this function fetches, so the token
 * exists as a local `const` in one call frame and is never held anywhere this
 * module could log or cache it.
 */
export async function resetVault(confirm: string, idToken: string): Promise<VaultStatus> {
  releaseVaultKeys();
  const response = await api.post<{ vault: VaultStatus }>(apiPath.vaultReset(), {
    confirm,
    idToken,
  });
  return response.vault;
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

/**
 * Changes how long this account's vault may sit idle before it locks.
 *
 * `null` clears the preference rather than sending the default's number, which
 * is the difference between "I have no view" and "I want exactly an hour" — only
 * the first follows the default if it is ever reconsidered.
 *
 * The answer is the *effective* status: the server clamps to the range its own
 * unlock gate assumes, so what comes back is what will actually be enforced
 * rather than what was asked for.
 */
export async function setAutoLockMinutes(minutes: number | null): Promise<VaultStatus> {
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

/**
 * What a failed passkey unlock means, and how loudly to say it.
 *
 * Three outcomes, because the screen has to behave differently in each and
 * getting them confused is what makes an authentication surface feel broken:
 *
 *  - **Dismissed.** `silent`, and the button simply comes back. The user said
 *    no; telling them so is noise, and WebAuthn deliberately reports a dismissal
 *    and a timeout identically so a site cannot tell "no such credential" from
 *    "the user declined".
 *  - **This device cannot.** `permanent` for this browser or authenticator — no
 *    PRF extension, an insecure origin, a refused request. The passkey option is
 *    withdrawn for the rest of the session and the passphrase form carries on
 *    below it, which is the whole reason a passkey is never the only wrap.
 *  - **Everything else.** A wrap that did not open, a lockout, a network
 *    failure: {@link describeUnlockFailure} already says the right thing about
 *    each, including passing the server's backoff wait through verbatim.
 *
 * Pure and exported, so the branch a given throw takes is asserted directly
 * rather than by driving a browser prompt.
 */
export function describePasskeyUnlockFailure(cause: unknown): {
  silent: boolean;
  permanent: boolean;
  message: string;
} {
  if (cause instanceof PasskeyCancelledError) {
    return { silent: true, permanent: false, message: cause.message };
  }

  if (cause instanceof PasskeyUnsupportedError) {
    // Its message is written for this screen and is safe to show; see
    // `passkey.ts`. Everything else goes through `describeUnlockFailure`, which
    // collapses an arbitrary exception rather than reading a `message` that may
    // have been built from a request payload.
    return { silent: false, permanent: true, message: cause.message };
  }

  return { silent: false, permanent: false, message: describeUnlockFailure(cause) };
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
