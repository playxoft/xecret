import { AuthorizationError } from '@xecret/core/authz';
import {
  RepositoryError,
  softDeleteOrganization,
  updateOrganization,
} from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { errors } from '@/server/errors';
import { json, noContent, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import {
  assertSlugImmutable,
  confirmationMatches,
  destructiveRequestSchema,
  organizationPatchSchema,
  toOrganization,
} from '@/server/schemas/resources';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * One organisation: the settings page, the only field of it that can change, and
 * its removal.
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

/**
 * Soft-deletes an organisation.
 *
 * This is the largest blast radius in the product. One column changes and every
 * project, environment and secret beneath it stops resolving at once — for every
 * member, not only for the person who pressed the button — because each read
 * joins back through `organizations` with a `deleted_at is null` filter. The
 * applications holding those secrets keep working until their next deploy, which
 * is what makes the mistake expensive: it is discovered late, by somebody else,
 * during an outage.
 *
 * Three gates, each doing a different job:
 *
 *  - **A browser session.** Same rule as `DELETE /api/auth/account`: a CLI token
 *    acts as its user for secrets, not for existence. A credential left on a
 *    build machine must not be able to erase the organisation it reads from.
 *  - **`org.delete`.** Owners only, and only owners — it is the single action an
 *    admin is denied (`roles.ts`). Nothing a grant can widen.
 *  - **The slug, typed back.** A permission check answers "may they?"; this
 *    answers "did they mean to?", and it is the second question that goes wrong.
 *    The owner entitled to do this is exactly the person clicking through a
 *    settings page at speed.
 *
 * Never a hard delete. The audit records that say this organisation existed —
 * including the one written below — are filed against `org_id`, and a row that
 * vanished would take the history of everything that ever happened inside it out
 * of an operator's reach. The wrapped keys stay wrapped; nothing here touches key
 * material, so this is not cryptographic erasure and does not pretend to be.
 */
export const DELETE = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    if (principal.kind !== 'user') {
      throw errors.forbidden('Deleting an organisation requires a signed-in browser session.');
    }

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;
    const resource = { type: 'org' as const, id: orgId };

    try {
      authorize(scope, 'org.delete');
    } catch (cause) {
      // An admin reaching for this is the denial most worth having on record:
      // it is one role short of permitted, so it is the shape both a confused
      // colleague and a partially-successful account takeover produce.
      if (cause instanceof AuthorizationError) {
        record(audit(orgId).denied('org.deleted', resource, cause.decision));
      }
      throw cause;
    }

    const body = await parseJsonBody(request, destructiveRequestSchema);
    if (!confirmationMatches(scope.organization.slug, body.confirm)) {
      // Recorded rather than merely refused: a run of unconfirmed attempts
      // against one organisation is a signal, and it only exists if the refusal
      // writes a record too.
      record(audit(orgId).error('org.deleted', resource, 'invalidInput'));

      throw errors.badRequest(
        'Deleting an organisation removes every project and secret in it for every member. ' +
          'Repeat the request with {"confirm": "<organisation slug>"}.',
      );
    }

    // Idempotent by construction — the update filters on `deleted_at is null`,
    // so a second call changes nothing. `resolveOrg` has already answered 404
    // for an organisation deleted before this request arrived.
    await softDeleteOrganization(services.db, orgId);

    record(audit(orgId).success('org.deleted', resource));

    return noContent();
  },
);
