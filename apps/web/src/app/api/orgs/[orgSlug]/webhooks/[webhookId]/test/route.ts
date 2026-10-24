import { findWebhook } from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { authorize, resolveOrg } from '@/server/tenancy';
import {
  refuseServiceTokens,
  refuseWhilePaused,
  requireWebhookId,
  sendTestDelivery,
  webhookActorOf,
} from '@/server/webhooks-service';

/**
 * Sends one `webhook.test` delivery to an endpoint, now, and answers how it
 * went: `{ delivery: { id, status, lastStatusCode, lastError } }`.
 *
 * Signed exactly as a real delivery is, with a payload naming only the
 * organisation and who asked — so a receiver can check its verification
 * end to end without anybody changing a secret. Tried once: a test that fails
 * is the answer the person asked for, and it is in the delivery log like any
 * other. Allowed on an endpoint that is switched off, which is when a person
 * most wants to know whether it works again.
 *
 * Owners and admins, a person's credential only, rate-limited like any write
 * — every call is an outgoing request this server makes on the caller's
 * behalf. Refused while the plan allows no webhooks. Not audited: a test
 * changes nothing, and its delivery log entry is the record of it.
 */

type Params = { orgSlug: string; webhookId: string };

export const POST = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  refuseServiceTokens(principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'org.update');
  refuseWhilePaused(scope.entitlements, () => undefined);

  requireWebhookId(params.webhookId);
  const webhook = await findWebhook(services.db, scope.organization.id, params.webhookId);
  if (webhook === null) throw errors.notFound('no webhook with id in organisation');

  const delivery = await sendTestDelivery(services, webhook, {
    organization: { id: scope.organization.id, slug: scope.organization.slug },
    actor: webhookActorOf(principal),
  });
  return json({ delivery });
});
