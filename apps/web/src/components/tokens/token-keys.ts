'use client';

import { joinServiceToken } from '@xecret/core/auth';
import {
  encodePublicKey,
  generateEncryptionKeyPair,
  toBase64Url,
  zeroize,
} from '@xecret/core/crypto/client';
import { api } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  fetchEnvironmentKeys,
  grantsPath,
  openEnvironmentKeys,
  sealGrantFor,
} from '@/components/envkeys';
import type { VaultKeyMaterial } from '@/components/vault';
import type { CreateServiceTokenResponse, ServiceToken } from './types';

/**
 * Minting a service token that can read an end-to-end encrypted environment.
 *
 * This is `env-keys.ts`'s rule applied one level out: the cryptography lives in
 * a module and never in a screen. `CreateTokenDialog` is a form; everything
 * about which half of the token goes where is decided here.
 *
 * ── The two halves, and who mints which ──
 *
 * A service token is the only principal that holds an environment's keys with
 * no person behind it, so it carries its own X25519 private scalar (spec §13.1).
 * There is nowhere else to put it: a CI runner has no vault and no passphrase,
 * and a key it has to fetch is a key the server could withhold or substitute.
 *
 *  - The **server** mints the auth half, because a client-chosen credential is a
 *    credential with client-chosen entropy, and stores only its SHA-256.
 *  - This **browser** mints the key half, derives the public key it uploads, and
 *    keeps the private half exactly long enough to render it once. A server that
 *    generated the key half would hold every environment key sealed to it, which
 *    is the whole of ADR 0009.
 *
 * The two meet in `joinServiceToken`, in this process, and the joined string is
 * shown once and never reconstructible — losing it means minting another token,
 * exactly as before, except that now the loss is cryptographic rather than
 * merely procedural.
 */

export interface MintedServiceToken {
  /** Shown once. Carries the key half when the environment is `e2ee`. */
  token: string;
  serviceToken: ServiceToken;
  /**
   * Whether the environment's key reached the token.
   *
   * False means the token exists and authenticates but decrypts nothing: the
   * mint committed and the grant did not. That is a recoverable state — an admin
   * shares or rotates the environment key and the token starts working — and it
   * is reported rather than hidden, because the alternative is a credential
   * somebody puts in a pipeline that fails on its first run for no visible
   * reason.
   */
  keyShared: boolean;
}

/** Raised before anything is minted, when this browser cannot do the sealing. */
export class TokenKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenKeyUnavailableError';
  }
}

export interface MintServiceTokenParams {
  orgSlug: string;
  projectSlug: string;
  environmentSlug: string;
  name: string;
  accessLevel: 'read' | 'write';
  /** From the environment listing. Only `'e2ee'` triggers the key ceremony. */
  encryptionMode: string;
  /** The unlocked vault, or null. Required for an `e2ee` environment. */
  vault: VaultKeyMaterial | null;
}

/**
 * Mints one service token, pinned to one environment.
 *
 * For a `server`-mode environment this is the request it always was. For an
 * `e2ee` one the order is deliberate: **the environment key is opened before
 * anything is created.** A locked vault or a missing grant fails here, with
 * nothing minted, rather than leaving behind a token nobody can ever make
 * useful — and a token cannot be un-minted.
 */
export async function mintServiceToken(
  params: MintServiceTokenParams,
): Promise<MintedServiceToken> {
  const path = apiPath.serviceTokens(params.orgSlug);
  const body = {
    name: params.name,
    projectSlug: params.projectSlug,
    environmentSlug: params.environmentSlug,
    accessLevel: params.accessLevel,
  };

  if (params.encryptionMode !== 'e2ee') {
    const issued = await api.post<CreateServiceTokenResponse>(path, body);
    return { token: issued.token, serviceToken: issued.serviceToken, keyShared: true };
  }

  const target = {
    orgSlug: params.orgSlug,
    projectSlug: params.projectSlug,
    envSlug: params.environmentSlug,
  };

  if (params.vault === null) {
    throw new TokenKeyUnavailableError(
      'Unlock your vault first — a token for an end-to-end encrypted environment is given its key by this browser, not by the server.',
    );
  }
  const vault = params.vault;

  const opened = await openEnvironmentKeys(await fetchEnvironmentKeys(target), vault);
  if (opened.status !== 'open') {
    throw new TokenKeyUnavailableError(
      opened.reason === 'pending'
        ? 'You have access to this environment but nobody has shared its key with you, so there is no key to pass on. Ask a teammate to share it first.'
        : 'This environment has no key you can read, so a token minted here would decrypt nothing.',
    );
  }
  const material = opened.material;

  // The private half of the token's keypair *is* its key half. X25519 clamps
  // internally, so the 32 random bytes are the scalar directly — no derivation,
  // and therefore no new HKDF branch (spec §3.3 keeps a closed registry).
  const keypair = generateEncryptionKeyPair();

  try {
    const keyHalf = toBase64Url(keypair.privateKey);

    const issued = await api.post<CreateServiceTokenResponse>(path, {
      ...body,
      publicKey: encodePublicKey(keypair.publicKey),
    });

    const token = joinServiceToken(issued.token, keyHalf);

    // Past this point the token exists. A failure to seal is reported, never
    // thrown: throwing would discard a value that has already been created and
    // can never be shown again.
    let keyShared = false;
    try {
      const grant = await sealGrantFor({
        vault,
        environmentId: material.environmentId,
        edkVersion: material.edkVersion,
        edk: material.edk,
        ehk: material.ehk,
        recipientKind: 'token',
        recipientId: issued.serviceToken.id,
        recipientPublicKey: keypair.publicKey,
      });

      await api.post(grantsPath(target), {
        envDataKeyId: material.envDataKeyId,
        grants: [grant],
      });
      keyShared = true;
    } catch {
      // Nothing about the cause is kept — see `lib/api.ts` on response bodies.
      // The token's public key is already stored, so the environment now reports
      // `needsRotation` and the rotation dialog will offer to finish the job.
      keyShared = false;
    }

    return { token, serviceToken: issued.serviceToken, keyShared };
  } finally {
    // The scalar's only remaining copy is inside the token string the caller is
    // about to render, which is a JavaScript string and cannot be wiped. This
    // closes the one buffer that can be.
    zeroize(keypair.privateKey);
  }
}
