'use client';

import {
  decodePublicKey,
  deriveInviteKeyPair,
  encodePublicKey,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  openGrant,
  sealGrant,
  signGrant,
  zeroize,
} from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { withVaultKeys } from '@/components/vault/key-store';
import type { VaultKeyMaterial } from '@/components/vault/key-store';
import { holdEnvKey, readEnvKey, withEnvKey } from './env-key-store';
import type { EnvKeyMaterial } from './env-key-store';
import type {
  EnvironmentKeys,
  EnvironmentKeysResponse,
  GrantBody,
  InviteKeyGrant,
  RecipientsResponse,
} from './types';

/**
 * The environment half of the key hierarchy, from a browser.
 *
 * This is to `env_key_grants` what `components/vault/vault-client.ts` is to the
 * user vault: the one module that composes cryptography, so that no screen ever
 * does. A component asks for "the key for this environment" or "a grant for this
 * person"; the seal, the signature, the AAD components and the zeroization are
 * all decided here.
 *
 * ── The three operations, and what each one requires ──
 *
 *  - **Opening.** `GET …/keys` returns a blob sealed to the caller's X25519
 *    public key. Opening it needs the vault's private half, so it needs an
 *    unlocked vault, and it produces the EDK and the EHK. Cached in
 *    `env-key-store.ts`, keyed on the environment *and* the key version.
 *  - **Sealing.** Producing a grant for somebody else needs their public key —
 *    which is why `GET …/keys/recipients` exists — plus the EDK and EHK this
 *    browser has already opened, plus the vault's Ed25519 key to sign with.
 *  - **Creating.** A brand-new environment has no grant to open, so the EDK and
 *    EHK are generated here and the creator's own grant is the first seal.
 *
 * ── Why every function takes `VaultKeyMaterial` explicitly ──
 * Rather than reaching into the key store. It makes "this operation cannot
 * happen with a locked vault" a type-level fact instead of a runtime check
 * repeated in eight callers, and it means the pure parts of this module are
 * testable with fabricated keys and no React.
 */

/** Where an environment lives, as the API addresses it. */
export interface EnvironmentRef {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

export function keysPath(target: EnvironmentRef): string {
  return `${apiPath.environment(target.orgSlug, target.projectSlug, target.envSlug)}/keys`;
}

export function recipientsPath(target: EnvironmentRef): string {
  return `${keysPath(target)}/recipients`;
}

export function grantsPath(target: EnvironmentRef): string {
  return `${keysPath(target)}/grants`;
}

export function rotatePath(target: EnvironmentRef): string {
  return `${keysPath(target)}/rotate`;
}

/** Reads an environment's key state. */
export async function fetchEnvironmentKeys(
  target: EnvironmentRef,
  options?: { signal?: AbortSignal },
): Promise<EnvironmentKeys> {
  const response = await api.get<EnvironmentKeysResponse>(keysPath(target), options);
  return response.keys;
}

/** Reads the principals a grant may be sealed to, and who already holds one. */
export function fetchRecipients(
  target: EnvironmentRef,
  options?: { signal?: AbortSignal },
): Promise<RecipientsResponse> {
  return api.get<RecipientsResponse>(recipientsPath(target), options);
}

/**
 * Why an environment cannot be opened right now.
 *
 * A closed set, because each one is a different screen and only one of them is
 * an error. `pending` in particular is a *designed* state — an admin granted
 * access without holding the key — and rendering it as a failure would send
 * somebody to ask for access they already have.
 */
export type EnvKeyUnavailable =
  /** Server-side encryption. There is no client key and there should not be. */
  | 'server-mode'
  /** The vault is locked, or this account has none. */
  | 'locked'
  /** Access, but no grant. Somebody has to share the key. */
  | 'pending'
  /** An `e2ee` environment with no active key at all — a broken creation. */
  | 'unkeyed'
  /**
   * The server answered `server` for an environment this browser has seen as
   * `e2ee`. Refused rather than obeyed: see `pins.ts` on the mode book.
   */
  | 'downgraded';

export type OpenEnvironmentResult =
  | { status: 'open'; material: EnvKeyMaterial; keys: EnvironmentKeys }
  | { status: 'unavailable'; reason: EnvKeyUnavailable; keys: EnvironmentKeys };

/**
 * Opens an environment's keys, from a key state already read.
 *
 * Split from the fetch because the pull bundle carries the key state *with* the
 * values (`GET …/pull` in `e2ee` mode), specifically so a rotation cannot land
 * between the two reads — and that path must open the grant it was handed rather
 * than fetching a second, possibly newer, one.
 *
 * A cache hit returns without touching the vault keys at all.
 */
export async function openEnvironmentKeys(
  keys: EnvironmentKeys,
  vault: VaultKeyMaterial | null,
): Promise<OpenEnvironmentResult> {
  if (keys.encryptionMode !== 'e2ee') {
    return { status: 'unavailable', reason: 'server-mode', keys };
  }
  if (keys.activeEdk === null) return { status: 'unavailable', reason: 'unkeyed', keys };

  const cached = readEnvKey(keys.environmentId, keys.activeEdk.id);
  if (cached !== null) return { status: 'open', material: cached, keys };

  // Checked after the cache, so a locked tab can still read from material it
  // opened before the lock — it cannot, because the lock empties the store, and
  // that ordering is what makes this a cache lookup rather than a permission
  // check pretending to be one.
  if (vault === null) return { status: 'unavailable', reason: 'locked', keys };
  if (keys.myGrant === null) return { status: 'unavailable', reason: 'pending', keys };

  const opened = await openGrant({
    recipient: {
      environmentId: keys.environmentId,
      edkVersion: keys.activeEdk.version,
      recipientKind: 'member',
      recipientId: vault.userId,
    },
    recipientPrivateKey: vault.encPrivateKey,
    grant: { edkSealed: keys.myGrant.edkSealed, ehkSealed: keys.myGrant.ehkSealed },
  });

  const material: EnvKeyMaterial = {
    environmentId: keys.environmentId,
    envDataKeyId: keys.activeEdk.id,
    edkVersion: keys.activeEdk.version,
    edk: opened.edk,
    ehk: opened.ehk,
  };

  // The store takes ownership; nothing here keeps a second reference.
  holdEnvKey(material);
  return {
    status: 'open',
    material: readEnvKey(keys.environmentId, keys.activeEdk.id) ?? material,
    keys,
  };
}

/**
 * Opens a **retired** key version, for reading history.
 *
 * A secret version written before a rotation is still sealed under the key that
 * was active then, and `GET …/versions/{version}` says so by naming a
 * `envDataKeyId` that is not the active one. There is no way to recover that
 * key: only the active grant is served, and the retired EDK was never stored
 * anywhere but in the browsers that held it.
 *
 * So this returns what is in the store and nothing else, and the caller renders
 * "this version was written under a key that has since been rotated away" rather
 * than an unexplained decryption failure. A session that was open across the
 * rotation still has the old key cached and can read it, which is exactly the
 * behaviour the pair-keyed cache exists to preserve.
 */
export function readRetiredKey(environmentId: string, envDataKeyId: string): EnvKeyMaterial | null {
  return readEnvKey(environmentId, envDataKeyId);
}

/**
 * Seals an EDK and an EHK to one principal and signs the result.
 *
 * The single place a grant is produced. Both halves happen together because a
 * grant without its signature is not a row this API accepts, and producing the
 * two in separate functions would let a caller sign a different pair of blobs
 * from the ones it sends — which is a signature that verifies over nothing.
 */
export async function sealGrantFor(params: {
  vault: VaultKeyMaterial;
  environmentId: string;
  edkVersion: number;
  edk: Bytes;
  ehk: Bytes;
  recipientKind: 'member' | 'token' | 'invite';
  recipientId: string;
  /** 32 raw bytes. `decodeRecipientKey` turns the API's base64url into these. */
  recipientPublicKey: Bytes;
}): Promise<GrantBody> {
  const sealed = await sealGrant({
    recipient: {
      environmentId: params.environmentId,
      edkVersion: params.edkVersion,
      recipientKind: params.recipientKind,
      recipientId: params.recipientId,
      recipientPublicKey: params.recipientPublicKey,
    },
    edk: params.edk,
    ehk: params.ehk,
  });

  const signature = signGrant({
    signerPrivateSeed: params.vault.signPrivateKey,
    fields: {
      environmentId: params.environmentId,
      edkVersion: params.edkVersion,
      recipientKind: params.recipientKind,
      recipientId: params.recipientId,
      recipientPublicKey: params.recipientPublicKey,
      edkSealedBlob: sealed.edkSealed,
      ehkSealedBlob: sealed.ehkSealed,
    },
  });

  return {
    recipientKind: params.recipientKind,
    recipientId: params.recipientId,
    // Sent because it is signed (spec §6.1). The server stores it verbatim, so
    // the stored row carries every field its signature covers and a verifier
    // never has to join to a table the server can rewrite.
    recipientPublicKey: encodePublicKey(params.recipientPublicKey),
    edkSealed: sealed.edkSealed,
    ehkSealed: sealed.ehkSealed,
    signature,
  };
}

/** The API's base64url public key as the 32 raw bytes every seal takes. */
export function decodeRecipientKey(value: string): Bytes {
  return decodePublicKey(value);
}

/**
 * Seals a grant set against the environment's key and posts it — re-sealing once
 * if the key moved underneath.
 *
 * ── The stale snapshot this closes ──
 * Every caller here seals against key material a screen has been holding: the
 * banner opened the environment when it rendered, the token dialog opened it
 * before minting. A rotation landing in the window between those two moments
 * makes the seal address a version the server no longer accepts. The server
 * refuses — `requireActiveKey` names both versions in a 409, precisely so this
 * is machine-readable — and the honest response is not to report failure to a
 * person who did nothing wrong. It is to re-read the key, seal again, and post.
 *
 * ── Why exactly once ──
 * A second rotation inside the same handful of seconds is not a race this browser
 * should keep chasing; it is two administrators rotating at the same time, and
 * the right answer then is to stop and say so. One retry covers the case that
 * actually happens and cannot loop.
 *
 * The re-seal produces *different* grants, not the same bytes re-posted: `seal`
 * is a function of the material rather than a value, because a grant carries the
 * key version in its AAD and re-sending the old blobs under a new key id would
 * store rows nobody can open.
 */
export async function submitGrants(params: {
  target: EnvironmentRef;
  vault: VaultKeyMaterial;
  /** What this browser currently believes the environment's key is. */
  material: EnvKeyMaterial;
  /** Consumed by this write, when it is an invitee claiming their own keys. */
  claimInvitationId?: string;
  seal: (material: EnvKeyMaterial) => Promise<GrantBody[]>;
}): Promise<{ material: EnvKeyMaterial; granted: number }> {
  try {
    const granted = await sealAndPost(params, params.material);
    return { material: params.material, granted };
  } catch (cause) {
    if (!isStaleKeyConflict(cause)) throw cause;

    const keys = await fetchEnvironmentKeys(params.target);
    const opened = await openEnvironmentKeys(keys, params.vault);
    // No grant on the new key means this browser cannot seal anything against
    // it, and the original refusal is the truthful thing to report — a retry
    // would fail for a second, less comprehensible reason.
    if (opened.status !== 'open') throw cause;

    const granted = await sealAndPost(params, opened.material);
    return { material: opened.material, granted };
  }
}

async function sealAndPost(
  params: {
    target: EnvironmentRef;
    claimInvitationId?: string;
    seal: (material: EnvKeyMaterial) => Promise<GrantBody[]>;
  },
  material: EnvKeyMaterial,
): Promise<number> {
  return withEnvKey(material, async () => {
    const grants = await params.seal(material);
    const response = await api.post<{ granted: number }>(grantsPath(params.target), {
      envDataKeyId: material.envDataKeyId,
      grants,
      ...(params.claimInvitationId === undefined
        ? {}
        : { claimInvitationId: params.claimInvitationId }),
    });
    return response.granted ?? grants.length;
  });
}

/** A 409 from the grants endpoint means one thing: the key version moved. */
function isStaleKeyConflict(cause: unknown): boolean {
  return isApiError(cause) && cause.code === 'conflict';
}

/**
 * The creator's own grant for a brand-new environment.
 *
 * ── Why the keys are generated here and not on the server ──
 * Because a server that generated them would hold them, which is the whole of
 * ADR 0009. The consequence is that these bytes exist in exactly one place —
 * this browser — until the creation request commits, and if it fails they are
 * gone. That is why `POST …/environments` writes the environment row and the key
 * rows in one transaction: an `e2ee` environment created without its keys cannot
 * be repaired by anybody.
 *
 * The material is **not** put in the store here. The environment has no id until
 * the server answers, and the id is what the store files under — the caller
 * re-opens through the ordinary path once the environment exists, which costs
 * one round trip and keeps a single code path for "how does a browser come to
 * hold an environment key".
 */
export async function createEnvironmentKeys(params: {
  vault: VaultKeyMaterial;
  /** The uuid the new environment will have. Minted by the client — see below. */
  environmentId: string;
}): Promise<{ grant: GrantBody; edk: Bytes; ehk: Bytes }> {
  const edk = generateEnvironmentDataKey();
  const ehk = generateEnvironmentHmacKey();

  try {
    const grant = await sealGrantFor({
      vault: params.vault,
      environmentId: params.environmentId,
      edkVersion: 1,
      edk,
      ehk,
      recipientKind: 'member',
      recipientId: params.vault.userId,
      recipientPublicKey: params.vault.encPublicKey,
    });

    return { grant, edk, ehk };
  } catch (cause) {
    // Nothing downstream will ever be able to use these, and they are 64 bytes
    // of key material sitting in a heap that is about to render an error.
    zeroize(edk);
    zeroize(ehk);
    throw cause;
  }
}

/**
 * The invitation half of the two-channel flow, from the inviter's side.
 *
 * The fragment's seed derives the keypair; only the **public** half is uploaded
 * with the invitation, and the fragment itself never appears in any request
 * body. `deriveInviteKeyPair` is HKDF over the 16-byte seed (spec §10), so the
 * invitee holding the same string derives the same private scalar.
 */
export async function sealInviteGrant(params: {
  vault: VaultKeyMaterial;
  fragmentSeed: Bytes;
  invitationId: string;
  environmentId: string;
  edkVersion: number;
  edk: Bytes;
  ehk: Bytes;
}): Promise<GrantBody> {
  const keypair = await deriveInviteKeyPair(params.fragmentSeed);

  try {
    return await sealGrantFor({
      vault: params.vault,
      environmentId: params.environmentId,
      edkVersion: params.edkVersion,
      edk: params.edk,
      ehk: params.ehk,
      recipientKind: 'invite',
      recipientId: params.invitationId,
      recipientPublicKey: keypair.publicKey,
    });
  } finally {
    // The private scalar was derived for one seal and is not wanted afterwards.
    // The seed itself belongs to the caller, which holds it for as long as the
    // dialog is showing it to a human.
    zeroize(keypair.privateKey);
  }
}

/** The public key an invitation is created with, from a fragment's seed. */
export async function invitePublicKey(fragmentSeed: Bytes): Promise<string> {
  const keypair = await deriveInviteKeyPair(fragmentSeed);
  try {
    return encodePublicKey(keypair.publicKey);
  } finally {
    zeroize(keypair.privateKey);
  }
}

/**
 * The invitee's side: open each invite-sealed grant and re-seal it to themselves.
 *
 * ── Why this is a re-seal and not a copy ──
 * The blob is addressed to the invitation's one-off X25519 key. Storing it under
 * the invitee's member grant would produce a row nobody can open — the AAD names
 * `invite` and the invitation's id, and their own private key is not the one it
 * was sealed to. So the EDK and EHK are recovered and sealed afresh, with the
 * AAD naming `member` and their user id, signed with their own Ed25519 key.
 *
 * ── Why each upload names the invitation it is consuming ──
 * `claimInvitationId` is what makes "the invitee now holds their own grant" and
 * "the invitation's copy is gone" a single committed fact. The alternative — the
 * server destroying the rows when it served them, which is what it used to do —
 * meant the only reachable copy of an environment's key was deleted before the
 * person who had just arrived could possibly use it. Consuming per environment
 * also makes a partial failure resumable: the four that worked stay claimed, the
 * one that did not keeps its row, and the code can be entered again later.
 *
 * If this fails entirely, the invitee simply holds no key and the pending-share
 * queue — written by the same acceptance — says so for a teammate to fulfil.
 *
 * A rotation landing mid-flight fails one environment and is *not* retried: the
 * EDK these grants carry is the retired one, so there is nothing here to re-seal
 * against the new key. That environment falls to the pending-share path, which is
 * the only route to a key this browser has never held.
 */
export async function reSealInviteGrants(params: {
  vault: VaultKeyMaterial;
  fragmentSeed: Bytes;
  invitationId: string;
  grants: readonly InviteKeyGrant[];
  orgSlug: string;
}): Promise<{ opened: number; failed: InviteKeyGrant[] }> {
  return withVaultKeys(params.vault, () => reSealAll(params));
}

async function reSealAll(params: {
  vault: VaultKeyMaterial;
  fragmentSeed: Bytes;
  invitationId: string;
  grants: readonly InviteKeyGrant[];
  orgSlug: string;
}): Promise<{ opened: number; failed: InviteKeyGrant[] }> {
  const keypair = await deriveInviteKeyPair(params.fragmentSeed);
  const failed: InviteKeyGrant[] = [];
  let opened = 0;

  try {
    for (const grant of params.grants) {
      let edk: Bytes | null = null;
      let ehk: Bytes | null = null;

      try {
        const material = await openGrant({
          recipient: {
            environmentId: grant.environmentId,
            edkVersion: grant.edkVersion,
            recipientKind: 'invite',
            recipientId: params.invitationId,
          },
          recipientPrivateKey: keypair.privateKey,
          grant: { edkSealed: grant.edkSealed, ehkSealed: grant.ehkSealed },
        });
        edk = material.edk;
        ehk = material.ehk;

        const body = await sealGrantFor({
          vault: params.vault,
          environmentId: grant.environmentId,
          edkVersion: grant.edkVersion,
          edk,
          ehk,
          recipientKind: 'member',
          recipientId: params.vault.userId,
          recipientPublicKey: params.vault.encPublicKey,
        });

        await api.post(
          grantsPath({
            orgSlug: params.orgSlug,
            projectSlug: grant.projectSlug,
            envSlug: grant.environmentSlug,
          }),
          {
            envDataKeyId: grant.envDataKeyId,
            grants: [body],
            // Consumed by the write that replaces it, never before it. See the
            // doc comment above, and `AddEnvKeyGrantsParams.claimInvitationId`.
            claimInvitationId: params.invitationId,
          },
        );

        opened += 1;
      } catch {
        // One environment failing must not abandon the rest: a wrong fragment
        // fails all of them and a rotation that landed mid-flight fails one, and
        // the second case should still leave the invitee holding the others.
        // Nothing about the thrown value is kept — see `lib/api.ts` on bodies.
        failed.push(grant);
      } finally {
        if (edk !== null) zeroize(edk);
        if (ehk !== null) zeroize(ehk);
      }
    }

    return { opened, failed };
  } finally {
    zeroize(keypair.privateKey);
  }
}
