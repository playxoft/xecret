import { listReadSightings } from '@xecret/db/repositories';
import { featureStatus } from '@/server/entitlements';
import { errors } from '@/server/errors';
import { json, parseQuery } from '@/server/http';
import { toSightingPayload } from '@/server/read-alerts';
import { authenticatedRoute } from '@/server/route';
import { readAlertsActive } from '@/server/schemas/resources';
import { listLimitQuerySchema } from '@/server/schemas/webhooks';
import { authorize, resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Where an environment has been read from (P19 §7): `?limit=` (1–200, default
 * 50) → `{ sightings, alerts: { active, entitled, upgradeTo } }`, newest first.
 *
 * The in-app half of the new-location alert: every (principal, address) that
 * has read this environment, when it was first and last seen, and whether an
 * alert covering it has gone out. `alerts.active` is whether this environment's
 * reads are noted at all (its own switch, else on for production only), and
 * `alerts.entitled` whether the plan includes the alert — the dashboard needs
 * both to say why the list is empty.
 *
 * ── Who may ──
 * `environment.update` — the owners and admins who also switch the alerts on
 * and off — through a person's credential. A service token is refused: the list
 * names every credential and address that reads the environment, which is a map
 * of its readers no build needs. A refused read files nothing.
 *
 * ── Not gated on the plan ──
 * What was recorded is the customer's, and a downgrade does not take it away:
 * an organisation that lost the alert keeps the list of what it had seen.
 */

type Params = { orgSlug: string; projectSlug: string; envSlug: string };

const DEFAULT_LIMIT = 50;

export const GET = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  if (principal.kind === 'serviceToken') {
    throw errors.forbidden('Read locations are listed for a person, not a service token.');
  }
  const scope = await resolveEnvironmentPath(principal, params, services);
  authorize(scope, 'environment.update');

  const { limit } = parseQuery(request, listLimitQuerySchema);
  const sightings = await listReadSightings(
    services.db,
    scope.organization.id,
    scope.environment.id,
    limit ?? DEFAULT_LIMIT,
  );
  const entitled = featureStatus(scope.entitlements, 'newIpReadAlerts');

  return json({
    sightings: sightings.map(toSightingPayload),
    alerts: {
      active: readAlertsActive(scope.environment),
      entitled: entitled.enabled,
      upgradeTo: entitled.upgradeTo,
    },
  });
});
