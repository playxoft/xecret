'use client';

import { useState } from 'react';

import { errorMessage } from '@/lib/api';
import { pluralize } from '@/lib/format';
import { Alert, Button, useToast } from '@/components/ui';
import { useVaultKeys } from '@/components/vault';
import type { EnvironmentRef } from './env-keys';
import type { EnvKeyMaterial } from './env-key-store';
import { shareWithMissingRecipients } from './share';

/**
 * "N people are waiting for this environment's key", and the button that ends it.
 *
 * ── Why this exists at all ──
 * Access is decided by people who may not hold the key. An owner can grant a
 * developer access to production without ever having opened production
 * themselves, and if they hold no grant their browser has no key to seal.
 * Refusing the access change would make authorization depend on who happens to
 * hold which key; granting it with no key leaves somebody who can list every
 * secret name and decrypt none of them, with nothing anywhere saying why.
 *
 * So the access change lands and the server records the debt. This is where it
 * gets paid: by whoever is looking at the environment, holds its key, and can
 * therefore seal it — which is a different person from the one who created the
 * debt, and usually does not know they are the one who can fix it. Hence a
 * banner rather than a settings page.
 *
 * ── One click, and what it actually does ──
 * Reads the recipients, seals the **existing** key to everybody who does not
 * hold it, and posts. The version does not change — this is a share, not a
 * rotation — and the queued rows are deleted by the same transaction that writes
 * the grants, so the banner cannot outlive the key it was asking for.
 *
 * A key that has *changed* since this browser pinned it is refused rather than
 * sealed to. Handing an environment key to a substituted public key is precisely
 * the attack pinning exists to catch, and doing it from a one-click banner would
 * be the worst possible place to do it silently.
 */
export interface PendingSharesBannerProps {
  target: EnvironmentRef;
  /** The environment's opened key. Absent means this browser cannot help. */
  material: EnvKeyMaterial;
  /** How many the server says are waiting. Admins only — `null` hides this. */
  pendingCount: number;
  onShared: () => void;
}

export function PendingSharesBanner({
  target,
  material,
  pendingCount,
  onShared,
}: PendingSharesBannerProps) {
  const { toast } = useToast();
  const vault = useVaultKeys();
  const [sharing, setSharing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (pendingCount === 0) return null;

  async function share() {
    if (vault === null || sharing) return;

    setSharing(true);
    setProblem(null);

    try {
      // The same flow an upgrade to end-to-end encryption runs once it lands —
      // see `share.ts` for the rules it keeps.
      const outcome = await shareWithMissingRecipients({ target, vault, material });

      if (outcome.status === 'nothing-to-share') {
        // The queue and the recipient list disagree, which means somebody else
        // fulfilled it between the banner rendering and this click. Reloading is
        // the whole remedy.
        onShared();
        return;
      }

      if (outcome.status === 'substituted') {
        setProblem(
          `${pluralize(outcome.count, 'recipient')} presented a different public key from the one this browser recorded. Confirm it with them out of band, then share from the rotation dialog where the fingerprints are shown.`,
        );
        return;
      }

      toast({
        variant: 'success',
        title: `Shared this environment's key with ${pluralize(outcome.granted, 'person')}`,
        description: 'They can read its values from their next page load.',
      });
      onShared();
    } catch (cause) {
      setProblem(errorMessage(cause));
    } finally {
      setSharing(false);
    }
  }

  return (
    <Alert tone="info" title={`${pluralize(pendingCount, 'pending key share')}`}>
      <p>
        {pendingCount === 1 ? 'Somebody has' : 'People have'} been given access to this environment
        but {pendingCount === 1 ? 'has' : 'have'} no copy of its key yet. You hold it, so you can
        hand it over. Nothing is decrypted on the server, so somebody who holds the key has to.
      </p>
      {problem !== null ? <p className="text-danger-text mt-2">{problem}</p> : null}
      <div className="mt-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={share}
          loading={sharing}
          disabled={vault === null}
        >
          Share the key
        </Button>
      </div>
    </Alert>
  );
}
