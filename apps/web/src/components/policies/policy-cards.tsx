'use client';

import { canAdminister } from '@/app/(dashboard)/_components/session';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';
import { useOrgPolicies } from './secret-policy-context';
import { SecretPolicyCard } from './secret-policy-card';
import { TokenPolicyCard } from './token-policy-card';

/**
 * The organisation's two policies, on its settings page (P19 §6, §8).
 *
 * One request for both cards: `GET /policies` answers the token policy, the
 * secret policy and what the plan includes in one body, and each card saving
 * reloads it — the `PATCH` answers the same shape, but a reload is what keeps
 * the other card, which did not save, describing the same stored state.
 *
 * Readable by every member, because the people held to a rule should be able
 * to read it; editable by owners and admins (`org.update`, the route's gate).
 */
export function PolicyCards({
  orgSlug,
  organization,
}: {
  orgSlug: string;
  organization: SessionOrganization | null;
}) {
  const policies = useOrgPolicies(orgSlug);
  const canManage = canAdminister(organization, 'org.update');
  const reload = () => void policies.reload();

  return (
    <>
      <TokenPolicyCard
        orgSlug={orgSlug}
        policies={policies.data}
        error={policies.error}
        onRetry={reload}
        canManage={canManage}
        onSaved={reload}
      />
      <SecretPolicyCard
        orgSlug={orgSlug}
        policies={policies.data}
        error={policies.error}
        onRetry={reload}
        canManage={canManage}
        onSaved={reload}
      />
    </>
  );
}
