'use client';

import type { VaultKeyMaterial } from '@/components/vault/key-store';
import { decodeRecipientKey, fetchRecipients, sealGrantFor, submitGrants } from './env-keys';
import type { EnvironmentRef } from './env-keys';
import type { EnvKeyMaterial } from './env-key-store';
import { readPins, recordSealedPins, substitutedRecipients } from './pins';
import { shareTargets } from './rotation';

/**
 * Seals an environment's **existing** key to everybody entitled to it who does
 * not hold it yet — the act the pending-shares banner performs on a click, and
 * the one an upgrade to end-to-end encryption performs straight after it lands.
 *
 * One implementation for both, because the rules are the security of it:
 *
 *  - **The recipient list comes from the server** (`GET …/keys/recipients`) —
 *    the same computation the server checks a rotation against — and only the
 *    principals without a grant on the active key are sealed to.
 *  - **A key that changed since this browser pinned it stops the share.**
 *    Handing an environment key to a substituted public key is exactly the
 *    attack pinning exists to catch, and a one-click share is the worst place to
 *    do it silently. Nothing is sealed; the caller says who, and the rotation
 *    dialog — where fingerprints are shown and confirmed one at a time — is the
 *    way through.
 *  - **Pins are recorded only after the seal lands**, for the keys it sealed
 *    to, never on render.
 *  - **A rotation between reading the key and posting** is handled by
 *    `submitGrants`, which re-reads and seals once more against the new one.
 *
 * Members without a vault have no public key and are not in `recipients` at
 * all: they stay in the server's pending queue until they set one up, and the
 * banner offers this again then.
 */
export type ShareOutcome =
  | { status: 'shared'; granted: number }
  /** Everybody entitled already holds the key. */
  | { status: 'nothing-to-share' }
  /** Refused: these recipients presented a different key from the one pinned here. */
  | { status: 'substituted'; count: number };

export async function shareWithMissingRecipients(params: {
  target: EnvironmentRef;
  vault: VaultKeyMaterial;
  /** The environment's opened key. Sealed as it is; the version does not change. */
  material: EnvKeyMaterial;
}): Promise<ShareOutcome> {
  const response = await fetchRecipients(params.target);
  const targets = shareTargets(response.recipients);
  if (targets.length === 0) return { status: 'nothing-to-share' };

  const substituted = substitutedRecipients(targets, readPins());
  if (substituted.length > 0) return { status: 'substituted', count: substituted.length };

  const outcome = await submitGrants({
    target: params.target,
    vault: params.vault,
    material: params.material,
    seal: (current) =>
      Promise.all(
        targets.map((recipient) =>
          sealGrantFor({
            vault: params.vault,
            environmentId: current.environmentId,
            edkVersion: current.edkVersion,
            edk: current.edk,
            ehk: current.ehk,
            recipientKind: recipient.kind,
            recipientId: recipient.id,
            recipientPublicKey: decodeRecipientKey(recipient.publicKey),
          }),
        ),
      ),
  });

  recordSealedPins(targets);
  return { status: 'shared', granted: outcome.granted };
}
