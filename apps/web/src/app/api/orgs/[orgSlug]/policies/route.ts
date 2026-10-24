import { auditingDenials } from '@xecret/core/authz';
import { SecretPolicyError, tokenPolicyTightens, validateSecretPolicy } from '@xecret/core/policy';
import { loadOrgPolicies, saveSecretPolicy, saveTokenPolicy } from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { requireFeature } from '@/server/entitlements';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { secretPolicyChangeNeedsPlan, toOrgPoliciesPayload } from '@/server/policies-service';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { orgPoliciesPatchSchema } from '@/server/schemas/policies';
import { planRefusal } from '@/server/template-writes';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * The organisation's policies (P19 §6 and §8): the token policy — require an IP
 * allowlist, cap a token's lifetime — and the secret naming and strength policy.
 *
 * ── Reading ──
 * Every member, and every service token. The clients enforce the secret value
 * rules before they encrypt, so whatever writes needs to know them, and a
 * policy is not a secret: it is the organisation's rulebook, and the people held
 * to it should be able to read it.
 *
 * ── Changing ──
 * `org.update` — owners and admins — from a browser session. Tightening the
 * token policy needs `tokenIpAllowlist` (Pro); switching the secret policy on, or
 * changing it while it is on, needs `secretPolicy` (Team). Loosening either, or
 * switching it off, needs no plan, and a downgrade switches nothing off: see
 * `policies-service.ts`.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  const policies = await loadOrgPolicies(services.db, scope.organization.id);
  return json(toOrgPoliciesPayload(scope.entitlements, policies));
});

export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;
    const builder = audit(orgId);
    const resource = { type: 'org' as const, id: orgId };

    auditingDenials(
      (decision) => record(builder.denied('org.policy_changed', resource, decision)),
      () => authorize(scope, 'org.update'),
    );
    if (principal.kind !== 'user') {
      throw errors.forbidden('Change an organisation policy from the dashboard, not with a token.');
    }

    const body = await parseJsonBody(request, orgPoliciesPatchSchema);
    if (body.tokens === undefined && body.secrets === undefined) {
      throw errors.validation([{ field: 'tokens', message: 'Send a token or a secret policy.' }]);
    }

    const current = await loadOrgPolicies(services.db, orgId);

    // Everything is checked before anything is written, so a request carrying
    // both policies cannot store one and be refused on the other.
    if (body.tokens !== undefined && tokenPolicyTightens(current.tokens, body.tokens)) {
      requireFeature(
        scope.entitlements,
        'tokenIpAllowlist',
        planRefusal(
          record,
          builder,
          'org.policy_changed',
          resource,
          'tokenIpAllowlist',
          scope.entitlements.plan,
          {
            policyName: 'tokens',
          },
        ),
      );
    }

    if (body.secrets !== undefined) {
      try {
        validateSecretPolicy(body.secrets);
      } catch (cause) {
        if (cause instanceof SecretPolicyError) {
          throw errors.validation([{ field: `secrets.${cause.field}`, message: cause.message }]);
        }
        throw cause;
      }
      if (secretPolicyChangeNeedsPlan(current.secrets, body.secrets)) {
        requireFeature(
          scope.entitlements,
          'secretPolicy',
          planRefusal(
            record,
            builder,
            'org.policy_changed',
            resource,
            'secretPolicy',
            scope.entitlements.plan,
            {
              policyName: 'secrets',
            },
          ),
        );
      }
    }

    const updatedBy = principal.user.id;
    await services.db.transaction(async (tx) => {
      if (body.tokens !== undefined) {
        await saveTokenPolicy(tx, { orgId, policy: body.tokens, updatedBy });
      }
      if (body.secrets !== undefined) {
        await saveSecretPolicy(tx, { orgId, policy: body.secrets, updatedBy });
      }
    });

    if (body.tokens !== undefined) {
      record(builder.success('org.policy_changed', resource, { policyName: 'tokens' }));
    }
    if (body.secrets !== undefined) {
      record(builder.success('org.policy_changed', resource, { policyName: 'secrets' }));
    }

    const policies = await loadOrgPolicies(services.db, orgId);
    return json(toOrgPoliciesPayload(scope.entitlements, policies));
  },
);
