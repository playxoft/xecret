import { AuthorizationError } from '@xecret/core/authz';
import { RepositoryError, updateOrganization } from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import {
  assertSlugImmutable,
  organizationPatchSchema,
  toOrganization,
} from '@/server/schemas/resources';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * One organisation: the settings page, and the only field of it that can change.
 *
 * `resolveOrg` is what makes a slug from another tenant indistinguishable from
 * one that never existed — it looks the organisation up and then requires a
 * membership, reporting the same `not_found` for a miss at either step.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);

  // `member.read`, not `project.read`. The `Action` union has no `org.read`, and
  // a project-scoped action asked about an organisation is denied outright by
  // `can()` — correctly, since there is no project to resolve a grant against.
  // `member.read` is the org-scoped read capability: every role holds it, and a
  // suspended member holds nothing, which is exactly the question to settle
  // before returning anything about the organisation at all.
  authorize(scope, 'member.read');

  return json({
    organization: toOrganization(scope.organization, scope.membership?.role ?? null),
  });
});

/**
 * Renames an organisation.
 *
 * The name only. The slug is immutable, and an attempt to change it is refused
 * with an explanation rather than ignored — see `assertSlugImmutable`.
 */
export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    // Before the lookup: the limit exists to bound how much work an authenticated
    // caller can make the database do, so spending a query first would defeat it.
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    try {
      authorize(scope, 'org.update');
    } catch (cause) {
      // A refused attempt to change the organisation is exactly what an audit
      // log is for: a system that records only what succeeded cannot show an
      // attack in progress (api.md §7). The record is queued before the throw,
      // and the wrapper flushes in a `finally`, so the failure still writes it.
      if (cause instanceof AuthorizationError) {
        record(audit(orgId).denied('org.updated', { type: 'org', id: orgId }, cause.decision));
      }
      throw cause;
    }

    const patch = await parseJsonBody(request, organizationPatchSchema);
    assertSlugImmutable(patch, 'organisation');

    const organization = await updateOrganization(services.db, orgId, {
      name: patch.name,
    }).catch((cause: unknown) => {
      // The organisation resolved a moment ago, so a miss here means it was
      // deleted concurrently. Reported as absent rather than as the 500 an
      // unmapped repository error would otherwise become.
      if (cause instanceof RepositoryError && cause.code === 'notFound') {
        throw errors.notFound('organisation deleted during update');
      }
      throw cause;
    });

    record(audit(orgId).success('org.updated', { type: 'org', id: orgId }));

    return json({
      organization: toOrganization(organization, scope.membership?.role ?? null),
    });
  },
);
