import type { AuditMetadata } from '@xecret/core/audit';
import { auditingDenials } from '@xecret/core/authz';
import { checkWebhookUrl } from '@xecret/core/webhooks';
import {
  deleteWebhook,
  findWebhook,
  RepositoryError,
  updateWebhook,
} from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { errors } from '@/server/errors';
import { json, noContent, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { endpointHostOf, toWebhookPayload, webhookPatchSchema } from '@/server/schemas/webhooks';
import { planRefusal } from '@/server/template-writes';
import { authorize, resolveOrg } from '@/server/tenancy';
import {
  refuseServiceTokens,
  refuseWhilePaused,
  requireWebhookId,
  webhookResource,
} from '@/server/webhooks-service';

/**
 * One webhook endpoint: read it, change it, delete it.
 *
 * Owners and admins (`org.update`) for all three, a person's credential only —
 * see `../route.ts` for why reading is gated as tightly as writing. A refused
 * change or deletion is filed as `denied`; a refused read files nothing.
 *
 * ── Editing on a plan that allows none ──
 * Switching an endpoint off, and deleting it, are always allowed: taking a
 * feature away from yourself never needs a plan. Anything else — a new URL, new
 * events, a new description, switching it back on — is refused as a plan limit
 * while the organisation's plan allows no webhooks, with the plan that does,
 * and the attempt is filed as `quotaExceeded`. A paused endpoint is kept exactly
 * as it was, ready for the day the plan includes it again.
 *
 * ── Switching back on ──
 * `enabled: true` clears the endpoint's run of failures, so one that was
 * switched off for failing starts again from nothing rather than one failure
 * from being switched off again.
 */

type Params = { orgSlug: string; webhookId: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  refuseServiceTokens(principal);
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'org.update');

  requireWebhookId(params.webhookId);
  const webhook = await findWebhook(services.db, scope.organization.id, params.webhookId);
  if (webhook === null) throw errors.notFound('no webhook with id in organisation');

  return json({
    webhook: toWebhookPayload(webhook, scope.entitlements.limits.webhooks === 0),
  });
});

export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    refuseServiceTokens(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;
    const builder = audit(orgId);
    requireWebhookId(params.webhookId);
    const resource = webhookResource(params.webhookId);

    auditingDenials(
      (decision) => record(builder.denied('webhook.updated', resource, decision)),
      () => authorize(scope, 'org.update'),
    );

    const patch = await parseJsonBody(request, webhookPatchSchema);
    const existing = await findWebhook(services.db, orgId, params.webhookId);
    if (existing === null) throw errors.notFound('no webhook with id in organisation');

    const endpointHost = endpointHostOf(patch.url ?? existing.url);
    const onlySwitchingOff = Object.keys(patch).length === 1 && patch.enabled === false;
    if (!onlySwitchingOff) {
      const { plan } = scope.entitlements;
      refuseWhilePaused(
        scope.entitlements,
        planRefusal(record, builder, 'webhook.updated', resource, 'webhooks', plan, {
          endpointHost,
        }),
      );
    }

    if (patch.url !== undefined) {
      const check = checkWebhookUrl(patch.url);
      if (!check.valid) {
        throw errors.validation([{ field: 'url', message: check.message ?? 'Invalid URL.' }]);
      }
    }

    const updated = await updateWebhook(services.db, orgId, params.webhookId, {
      url: patch.url,
      description: patch.description,
      eventTypes: patch.eventTypes,
      enabled: patch.enabled,
    }).catch((cause: unknown) => {
      if (cause instanceof RepositoryError && cause.code === 'notFound') {
        throw errors.notFound('webhook deleted during update');
      }
      throw cause;
    });

    const metadata: AuditMetadata = { endpointHost, eventTypes: updated.eventTypes };
    if (patch.enabled !== undefined) metadata.enabled = patch.enabled;
    record(builder.success('webhook.updated', resource, metadata));

    return json({
      webhook: toWebhookPayload(updated, scope.entitlements.limits.webhooks === 0),
    });
  },
);

/** Deletes the endpoint and its delivery log. Never plan-gated. 204. */
export const DELETE = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    refuseServiceTokens(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;
    const builder = audit(orgId);
    requireWebhookId(params.webhookId);
    const resource = webhookResource(params.webhookId);

    auditingDenials(
      (decision) => record(builder.denied('webhook.deleted', resource, decision)),
      () => authorize(scope, 'org.update'),
    );

    const deleted = await deleteWebhook(services.db, orgId, params.webhookId);
    if (deleted === null) throw errors.notFound('no webhook with id in organisation');

    record(
      builder.success('webhook.deleted', resource, {
        endpointHost: endpointHostOf(deleted.url),
        eventTypes: deleted.eventTypes,
      }),
    );
    return noContent();
  },
);
