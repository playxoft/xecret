import { listOverrides } from '@xecret/db/repositories';
import { featureStatus } from '@/server/entitlements';
import { json } from '@/server/http';
import { overrideOwner } from '@/server/overrides-service';
import { authenticatedRoute } from '@/server/route';
import { toOverride } from '@/server/schemas/overrides';
import { enforceSecretRateLimit } from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * The caller's own personal overrides in one environment (P19 §2) — what
 * `xecret run` fetches beside the bundle, and what the dashboard lists.
 *
 * Sealed boxes addressed to the caller and to nobody else, so serving them
 * concedes nothing; not audited, for the reason the masked listing is not — it
 * is the caller's own ciphertext, and recording every `xecret run` fetching it
 * would bury the records that matter. Setting and removing one are audited.
 *
 * Never gated on the plan: reading, and removing, what you already have is not
 * a feature. `canSet` says whether setting a new one is.
 */

type Params = { orgSlug: string; projectSlug: string; envSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveEnvironmentPath(principal, params, services);
  const owner = overrideOwner(scope, principal);
  await enforceSecretRateLimit(services, principal, 'read');

  const overrides = await listOverrides(services.db, owner);
  const plan = featureStatus(scope.entitlements, 'personalOverrides');
  return json({
    overrides: overrides.map(toOverride),
    canSet: plan.enabled,
    upgradeTo: plan.upgradeTo,
  });
});
