'use client';

import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { InviteKeyStep } from './invite-key-step';
import type { InviteKeyGrant } from './types';

/**
 * "Have the code from your invitation? Enter it now."
 *
 * ── The dead end this removes ──
 * The two-channel flow assumes the second channel arrives second, and it
 * routinely does not. The link opens on a phone and the code sits in an email on
 * a laptop; somebody joins, sets their vault up, and only then finds the message;
 * somebody closes the tab. While the grants were consumed by the acceptance
 * response, every one of those was final — and silently so, because what the
 * invitee saw afterwards was an environment whose names they could list and whose
 * values they could not read, with nothing on the screen connecting it to the
 * code in their inbox.
 *
 * Now the grants survive until they are claimed, so this panel is simply the
 * second place they can be. It renders nothing at all unless the server says this
 * account has unclaimed invite keys **for this environment**, which is what keeps
 * it out of the way of the ninety-nine percent of people who never had a code.
 *
 * ── Why it belongs beside the pending-share message ──
 * That message tells somebody a teammate has to hand them a key. For an invitee
 * holding a code, that is true and also unnecessary: they can unlock it
 * themselves, right now, without anybody else being at their desk. Two routes out
 * of the same state, and the one that needs nobody else goes first.
 */
export interface ClaimInviteKeysProps {
  orgSlug: string;
  /** Only invitations carrying a grant for this environment are offered. */
  environmentId: string;
  /** Re-reads the environment's keys, after a successful claim. */
  onClaimed: () => void;
}

interface ClaimableResponse {
  invitations: {
    invitationId: string;
    organization: { slug: string; name: string };
    grants: readonly InviteKeyGrant[];
  }[];
}

type Offer = { invitationId: string; grants: readonly InviteKeyGrant[] };

export function ClaimInviteKeys({ orgSlug, environmentId, onClaimed }: ClaimInviteKeysProps) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const response = await api.get<ClaimableResponse>('/api/invitations/claimable', {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        // Narrowed to this environment, not merely this organisation. An
        // invitation covering four environments is claimed one at a time, so the
        // three already done must not keep offering themselves here.
        for (const invitation of response.invitations) {
          if (invitation.organization.slug !== orgSlug) continue;
          const grants = invitation.grants.filter((grant) => grant.environmentId === environmentId);
          if (grants.length === 0) continue;
          setOffer({ invitationId: invitation.invitationId, grants });
          return;
        }
      } catch {
        // Silent. This is an offer of a shortcut, not a load-bearing read: the
        // pending-share route out of this state is rendered beside it either way,
        // and an error toast about an affordance most people do not have would be
        // noise at exactly the wrong moment.
      }
    })();

    return () => controller.abort();
  }, [orgSlug, environmentId]);

  if (offer === null) return null;

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        I have a key code from my invitation
      </Button>
    );
  }

  return (
    <div className="border-line w-full max-w-lg rounded-lg border p-4 text-left">
      <InviteKeyStep
        orgSlug={orgSlug}
        invitationId={offer.invitationId}
        grants={offer.grants}
        onDone={() => {
          setOffer(null);
          setOpen(false);
          onClaimed();
        }}
      />
    </div>
  );
}
