import {
  findMemberWithUser,
  listEnvironmentsForOrganization,
  listGrantsForMember,
} from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { effectiveAccess, requireMembership } from '@/server/members-service';
import { authenticatedRoute } from '@/server/route';
import { toMember } from '@/server/schemas/members';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * The effective-permission preview: what can this member actually reach?
 *
 * The feature that prevents misconfiguration. Every level in the response
 * comes from `resolveAccessLevel` — the same function `can()` calls at
 * enforcement time — so the preview cannot disagree with what a request will
 * experience. What is added here is only *attribution*: which grant, or which
 * role default, produced each level.
 *
 * ── Who may look ──
 * Anyone may look at their own row: what you can reach is not a secret from
 * you, and a developer wondering "why can't I see production?" deserves the
 * answer without filing a ticket. Looking at *someone else's* row requires
 * `member.update` — it is the configuration view of the person you are about
 * to change, and grant topology across members is an access map of the
 * organisation that a viewer has no business downloading.
 *
 * ── Cost ──
 * Three queries, whatever the organisation's size: the member, their grants,
 * and the environment grid. The resolution itself is pure computation.
 */

type Params = { orgSlug: string; memberId: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  const orgId = scope.organization.id;

  authorize(scope, 'member.read');
  const membership = requireMembership(scope);

  const target = await findMemberWithUser(services.db, orgId, params.memberId);
  if (!target) throw errors.notFound('no such member in organisation');

  if (target.id !== membership.memberId) {
    authorize(scope, 'member.update');
  }

  const [grants, environments] = await Promise.all([
    listGrantsForMember(services.db, orgId, target.id),
    listEnvironmentsForOrganization(services.db, orgId),
  ]);

  // The grid uses ids to resolve; the response never carries them. Slugs are
  // the public identifiers, as everywhere else in this API.
  const idToSlug = new Map(environments.map((env) => [env.id, env.slug]));
  const projectIdToSlug = new Map(environments.map((env) => [env.project.id, env.project.slug]));

  return json({
    member: toMember(target, scope.actor.kind === 'serviceToken' ? null : scope.actor.userId),
    grants: grants
      .map((grant) => ({
        projectSlug: projectIdToSlug.get(grant.projectId),
        environmentSlug:
          grant.environmentId === null ? null : (idToSlug.get(grant.environmentId) ?? null),
        accessLevel: grant.accessLevel,
      }))
      // A grant on a project whose last environment was deleted has no slug to
      // show; it still resolves in the engine, but the editor cannot address
      // it, so it is omitted rather than rendered as an unusable row.
      .filter((grant) => grant.projectSlug !== undefined),
    projects: effectiveAccess(target, grants, environments),
  });
});
