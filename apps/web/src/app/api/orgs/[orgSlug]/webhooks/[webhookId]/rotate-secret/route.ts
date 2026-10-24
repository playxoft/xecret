import { auditingDenials } from '@xecret/core/authz';
import { generateWebhookSecret } from '@xecret/core/webhooks';
import { findWebhook, RepositoryError, updateWebhook } from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { endpointHostOf } from '@/server/schemas/webhooks';
import { authorize, resolveOrg } from '@/server/tenancy';
import {
  refuseServiceTokens,
  requireWebhookId,
  sealWebhookSecret,
  webhookResource,
} from '@/server/webhooks-service';

/**
 * Replaces an endpoint's signing secret: `POST` → `{ secret }`, the new
 * `whsec_…`, returned this once.
 *
 * The old secret stops signing at once — there is no overlap window, so the
 * receiver must be given the new one before it can verify the next delivery.
 * That is the right trade for the case rotation exists for, a secret that
 * leaked: a window in which the leaked one still signs is a window in which
 * somebody else's forgeries still verify.
 *
 * Owners and admins, a person's credential only. Not plan-gated: replacing a
 * credential is a security act, and an organisation whose endpoints are paused
 * must still be able to retire one that leaked. Filed as
 * `webhook.secret_rotated` — naming the host, never the secret.
 */

type Params = { orgSlug: string; webhookId: string };

export const POST = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    refuseServiceTokens(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;
    const builder = audit(orgId);
    requireWebhookId(params.webhookId);
    const resource = webhookResource(params.webhookId);

    auditingDenials(
      (decision) => record(builder.denied('webhook.secret_rotated', resource, decision)),
      () => authorize(scope, 'org.update'),
    );

    const existing = await findWebhook(services.db, orgId, params.webhookId);
    if (existing === null) throw errors.notFound('no webhook with id in organisation');

    const secret = generateWebhookSecret();
    const sealed = await sealWebhookSecret(services, orgId, existing.id, secret);
    await updateWebhook(services.db, orgId, existing.id, { secret: sealed }).catch(
      (cause: unknown) => {
        if (cause instanceof RepositoryError && cause.code === 'notFound') {
          throw errors.notFound('webhook deleted during rotation');
        }
        throw cause;
      },
    );

    record(
      builder.success('webhook.secret_rotated', resource, {
        endpointHost: endpointHostOf(existing.url),
      }),
    );
    return json({ secret });
  },
);
