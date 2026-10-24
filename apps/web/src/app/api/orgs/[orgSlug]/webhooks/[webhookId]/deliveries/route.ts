import { findWebhook, listDeliveries } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { listLimitQuerySchema, toDeliveryPayload } from '@/server/schemas/webhooks';
import { authorize, resolveOrg } from '@/server/tenancy';
import { refuseServiceTokens, requireWebhookId } from '@/server/webhooks-service';

/**
 * An endpoint's delivery log, newest first: `?limit=` (1–200, default 50) →
 * `{ deliveries: [...] }`.
 *
 * Each entry is what happened, not what was said back: the status, the attempt
 * count, the receiver's HTTP status, and a fixed error category. The
 * receiver's response body is never stored, so it cannot be shown. The body
 * *sent* is shown, capped — it carries names, slugs and counts, never a value.
 *
 * Owners and admins, a person's credential only; never plan-gated — the log is
 * the customer's, and a paused organisation still needs to read why.
 */

type Params = { orgSlug: string; webhookId: string };

const DEFAULT_LIMIT = 50;

export const GET = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  refuseServiceTokens(principal);
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'org.update');

  const { limit } = parseQuery(request, listLimitQuerySchema);
  requireWebhookId(params.webhookId);
  const webhook = await findWebhook(services.db, scope.organization.id, params.webhookId);
  if (webhook === null) throw errors.notFound('no webhook with id in organisation');

  const deliveries = await listDeliveries(
    services.db,
    scope.organization.id,
    webhook.id,
    limit ?? DEFAULT_LIMIT,
  );
  return json({ deliveries: deliveries.map(toDeliveryPayload) });
});
