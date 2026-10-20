import { auditingDenials } from '@xecret/core/authz';
import { checkLimit } from '@xecret/core/entitlements';
import { uuidv7 } from '@xecret/core/ids';
import { checkWebhookUrl, generateWebhookSecret } from '@xecret/core/webhooks';
import { countWebhooks, createWebhook, listWebhooks } from '@xecret/db/repositories';
import { actingUserId, actorId } from '@/server/actor';
import { requireCapacity } from '@/server/entitlements';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { endpointHostOf, toWebhookPayload, webhookCreateSchema } from '@/server/schemas/webhooks';
import { planRefusal } from '@/server/template-writes';
import { authorize, resolveOrg } from '@/server/tenancy';
import {
  refuseServiceTokens,
  sealWebhookSecret,
  webhookPlanStatus,
  webhookResource,
} from '@/server/webhooks-service';

/**
 * An organisation's webhook endpoints (P19 §5): the listing, and adding one.
 *
 * ── Who may ──
 * Owners and admins (`org.update`), for reading as well as writing: an
 * endpoint's URL routinely carries the receiver's own credential — a chat
 * integration's incoming-webhook URL *is* one — so listing them is not a
 * harmless read. A person's credential only; a service token is refused
 * (`refuseServiceTokens`). A refused write is filed as `denied`; a refused read
 * files nothing, as the SSO settings do — it could change nothing.
 *
 * ── The plan ──
 * `webhooks` is a count: Free 0, Pro 3, Team 25, Enterprise unlimited (fair use
 * 50). Adding one past it is refused with the plan that allows more, and the
 * attempt is filed as `quotaExceeded`. An organisation that downgraded keeps
 * every endpoint it has; on a plan that allows none they are *paused* — kept,
 * listed, and sent nothing — and the listing says so.
 */

type Params = { orgSlug: string };

/**
 * `{ webhooks, limit: { max, used }, paused, upgradeTo }`. No secret material:
 * the listing reads no secret column at all.
 */
export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  refuseServiceTokens(principal);
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'org.update');

  const records = await listWebhooks(services.db, scope.organization.id);
  const status = webhookPlanStatus(scope.entitlements, records.length);

  return json({
    webhooks: records.map((record) => toWebhookPayload(record, status.paused)),
    ...status,
  });
});

/**
 * Adds an endpoint: `{ url, description?, eventTypes }` → 201
 * `{ webhook, secret }`.
 *
 * `secret` is the `whsec_…` signing secret, returned here and from
 * `…/rotate-secret` and nowhere else, ever: it is sealed under the
 * organisation's master key before the row is written, and no route opens it.
 * Copy it now.
 *
 * The URL must be `https:`, carry no username or password, and name neither a
 * private, loopback or reserved address nor a local host name
 * (`checkWebhookUrl`); a refusal is a field error on `url`. The audit record
 * names the host and the events — never the URL, whose path or query may be a
 * credential.
 */
export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    refuseServiceTokens(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;
    const builder = audit(orgId);

    auditingDenials(
      (decision) => record(builder.denied('webhook.created', null, decision)),
      () => authorize(scope, 'org.update'),
    );

    const body = await parseJsonBody(request, webhookCreateSchema);
    const endpointHost = endpointHostOf(body.url);

    const used = await countWebhooks(services.db, orgId);
    if (checkLimit(scope.entitlements, 'webhooks', used).kind === 'exceeded') {
      planRefusal(record, builder, 'webhook.created', null, 'webhooks', scope.entitlements.plan, {
        endpointHost,
        eventTypes: body.eventTypes,
      })();
    }
    requireCapacity(scope.entitlements, 'webhooks', used);

    const check = checkWebhookUrl(body.url);
    if (!check.valid) {
      throw errors.validation([{ field: 'url', message: check.message ?? 'Invalid URL.' }]);
    }

    const id = uuidv7();
    const secret = generateWebhookSecret();
    const webhook = await createWebhook(services.db, {
      id,
      orgId,
      url: body.url,
      description: body.description ?? null,
      eventTypes: body.eventTypes,
      secret: await sealWebhookSecret(services, orgId, id, secret),
      createdBy: actingUserId(principal),
    });

    record(
      builder.success('webhook.created', webhookResource(id), {
        endpointHost,
        eventTypes: webhook.eventTypes,
      }),
    );

    return json({ webhook: toWebhookPayload(webhook, false), secret }, { status: 201 });
  },
);
