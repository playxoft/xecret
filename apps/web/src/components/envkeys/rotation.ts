'use client';

import { generateEnvironmentDataKey, zeroize } from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import { api, isApiError } from '@/lib/api';
import type { VaultKeyMaterial } from '@/components/vault/key-store';
import { decodeRecipientKey, rotatePath, sealGrantFor } from './env-keys';
import type { EnvironmentRef } from './env-keys';
import { withEnvKey } from './env-key-store';
import type { EnvKeyMaterial } from './env-key-store';
import type { GrantBody, Recipient } from './types';

/**
 * The rotation ceremony: a new data key, sealed to everybody who is still
 * entitled to it.
 *
 * ── What a rotation is for, stated plainly ──
 * Deleting somebody's grant stops them being *handed* the key again. It does
 * nothing about the copy they already have, which may be in a browser, in a
 * token string, or in a note somewhere. Only replacing the key stops that copy
 * opening what is written next — which is why `GET …/keys` reports
 * `needsRotation` until one lands, and why the copy in the dialog says the old
 * values were known to whoever was removed.
 *
 * ── The EHK is re-sealed, never replaced ──
 * `newEdk` below generates one key, not two. The Environment HMAC Key survives
 * rotation by design (spec §9): it is what makes "has this value changed?"
 * answerable across a revocation, and rotating it would record the first write
 * to every secret afterwards as a change when nothing changed. The same EHK
 * bytes are sealed into each new grant.
 *
 * ── Why the set is built here and checked there ──
 * The server recomputes the required set from `can()` and refuses an exact
 * mismatch in either direction, because a client that quietly omitted somebody
 * would produce a request that succeeds and silently revokes a colleague. This
 * module builds the set from `GET …/keys/recipients`, which is the same
 * computation served back — so the ordinary case matches, and a disagreement
 * means the roster changed between the two requests, which is a retry.
 */

/** Everything one rotation needs, once the recipients have been read. */
export interface RotationPlan {
  /** `current + 1`. Bound into every new grant's AAD, so the server checks it. */
  newVersion: number;
  /** Every principal the new key will be sealed to. */
  recipients: readonly Recipient[];
  /** Entitled members with no vault, who cannot be sealed to at all. */
  unsealable: readonly { kind: 'member'; id: string }[];
}

/**
 * The version a rotation must claim.
 *
 * Stated by the client rather than assigned by the server, because every grant
 * in the set has already been sealed with this number bound into its AAD. If the
 * server picked it, a rotation racing another would write grants whose AAD names
 * version 4 into a row numbered 5 — every one of them unopenable, for ever, with
 * a 201 at write time.
 */
export function nextEdkVersion(currentVersion: number): number {
  return currentVersion + 1;
}

/**
 * Builds the complete grant set for a rotation.
 *
 * Pure but for the crypto: it takes the recipient list and produces exactly the
 * bodies `POST …/keys/rotate` expects, in the order the recipients arrived.
 * Extracted from the dialog so the one property that matters — *the set covers
 * every recipient and nobody else* — is testable without a network or a DOM.
 *
 * The new EDK and the existing EHK are both sealed to each principal. Members
 * and service tokens are treated identically, which is why a CI token keeps
 * working across a rotation without anybody re-minting it.
 */
export async function buildRotationGrants(params: {
  vault: VaultKeyMaterial;
  environmentId: string;
  newVersion: number;
  newEdk: Bytes;
  /** The environment's existing HMAC key, re-sealed unchanged. */
  ehk: Bytes;
  recipients: readonly Recipient[];
}): Promise<GrantBody[]> {
  const grants: GrantBody[] = [];

  for (const recipient of params.recipients) {
    grants.push(
      await sealGrantFor({
        vault: params.vault,
        environmentId: params.environmentId,
        edkVersion: params.newVersion,
        edk: params.newEdk,
        ehk: params.ehk,
        recipientKind: recipient.kind,
        recipientId: recipient.id,
        recipientPublicKey: decodeRecipientKey(recipient.publicKey),
      }),
    );
  }

  return grants;
}

/** What a rotation attempt produced. */
export type RotationOutcome =
  | { status: 'rotated'; version: number; grantCount: number }
  /** The server's completeness check refused. `problems` names who. */
  | { status: 'incomplete'; problems: readonly string[] }
  | { status: 'failed'; error: unknown };

/**
 * Generates the new key, seals the set, and posts it.
 *
 * The EDK is zeroized on **every** exit, including success: the caller re-reads
 * `GET …/keys` afterwards and opens the new grant through the ordinary path, so
 * there is exactly one way key material enters the store and no second copy of a
 * live data key sitting in a closure.
 *
 * ── Leased for the whole ceremony ──
 * The **old** EHK is carried forward into every new grant (spec §9), and it is
 * the store's array, not a copy. Sealing to thirty recipients is thirty awaits;
 * a lock landing at recipient twelve used to overwrite that array in place, and
 * the remaining eighteen grants would then have sealed an all-zero HMAC key
 * without any of them failing. `withEnvKey` makes the whole ceremony one leased
 * operation, so the wipe waits for it and a lock that got there first refuses it.
 */
export async function rotateEnvironment(params: {
  target: EnvironmentRef;
  vault: VaultKeyMaterial;
  /** The currently-open material. Its EHK is carried forward. */
  material: EnvKeyMaterial;
  plan: RotationPlan;
  /** Progress, for the dialog. Called before each phase. */
  onProgress?: (phase: 'generating' | 'sealing' | 'writing') => void;
}): Promise<RotationOutcome> {
  params.onProgress?.('generating');
  const newEdk = generateEnvironmentDataKey();

  try {
    return await withEnvKey(params.material, async () => {
      params.onProgress?.('sealing');
      const grants = await buildRotationGrants({
        vault: params.vault,
        environmentId: params.material.environmentId,
        newVersion: params.plan.newVersion,
        newEdk,
        ehk: params.material.ehk,
        recipients: params.plan.recipients,
      });

      params.onProgress?.('writing');
      // The route answers `{ activeEdk: { id, version }, grants }` — the same
      // `activeEdk` shape every other key endpoint uses. Reading it as a flat
      // `{ version, grantCount }` produced two `undefined`s that reached the
      // success toast as "key version undefined".
      const result = await api.post<{ activeEdk: { id: string; version: number }; grants: number }>(
        rotatePath(params.target),
        { newVersion: params.plan.newVersion, grants },
      );

      return {
        status: 'rotated' as const,
        version: result.activeEdk.version,
        grantCount: result.grants,
      };
    });
  } catch (cause) {
    const problems = completenessProblems(cause);
    if (problems !== null) return { status: 'incomplete', problems };
    return { status: 'failed', error: cause };
  } finally {
    zeroize(newEdk);
  }
}

/**
 * The 422's field errors, or `null` when this was some other failure.
 *
 * The completeness refusal is the one error in this API that names request
 * content, and it does so because the alternative is unusable: "your grant set
 * is wrong", against a set of forty, gives a client nothing to correct. Every
 * message is filed under the `grants` field and reads "Missing a grant for
 * member:…" or "Unexpected grant for token:…", so they are surfaced verbatim
 * rather than summarised — the ids are the actionable part.
 */
export function completenessProblems(cause: unknown): readonly string[] | null {
  if (!isApiError(cause) || cause.code !== 'validation_failed') return null;

  const problems = cause.fields
    .filter((field) => field.field === 'grants')
    .map((field) => field.message);

  return problems.length > 0 ? problems : null;
}

/**
 * Turns a recipients read into the plan a rotation runs on.
 *
 * The whole list, not the ones without a grant: a rotation replaces the key, so
 * everybody needs the new one whether or not they held the old.
 */
export function planRotation(params: {
  currentVersion: number;
  recipients: readonly Recipient[];
  unsealable: readonly { kind: 'member'; id: string }[];
}): RotationPlan {
  return {
    newVersion: nextEdkVersion(params.currentVersion),
    recipients: params.recipients,
    unsealable: params.unsealable,
  };
}

/**
 * The grants a *share* needs: only the principals that do not hold one.
 *
 * The mirror of a rotation, and deliberately the opposite filter. A share seals
 * the **existing** key to somebody new, so the version does not change and the
 * set must not include people who already have it — `env_key_grants` has a
 * unique index per principal per key, and re-sending an existing grant fails the
 * whole batch.
 */
export function shareTargets(recipients: readonly Recipient[]): Recipient[] {
  return recipients.filter((recipient) => !recipient.holdsGrant);
}
