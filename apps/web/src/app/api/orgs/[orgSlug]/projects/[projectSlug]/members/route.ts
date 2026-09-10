import { listEnvironments, listGrantsForOrganization, listMembers } from '@xecret/db/repositories';
import { json } from '@/server/http';
import { effectiveAccess } from '@/server/members-service';
import { authenticatedRoute } from '@/server/route';
import { toMember } from '@/server/schemas/members';
import { toEnvironment } from '@/server/schemas/resources';
import { authorize, resolveProjectPath } from '@/server/tenancy';

/**
 * Who can reach *this project*, and at what level in each of its environments.
 *
 * ── Why this exists rather than N calls to `members/{id}/access` ──
 * The member screen asks "what can this person reach?" and answers it one
 * member at a time. Managing a project asks the transpose — "who can reach
 * this?" — and answering it from the per-member endpoint would be one request
 * per member to build a single dialog, most of it describing projects the
 * dialog will throw away. This answers the whole question in three queries,
 * whatever the organisation's size, and narrows the grid to one project before
 * it leaves the server.
 *
 * ── Who may look ──
 * `member.update`, not `member.read`. This *is* the grant topology — the same
 * access map of the organisation that `members/{id}/access` refuses to anyone
 * who cannot change it — merely sliced by project instead of by person. The
 * dialog it feeds is opened from a project's Manage menu, which is drawn for
 * admins and owners only; the gate here is what makes that true rather than
 * merely tidy.
 *
 * ── Every level is the enforced level ──
 * They come from `effectiveAccess`, which calls the same `resolveAccessLevel`
 * the authorization engine calls. A member listed at "Read" on production is a
 * member whose next request to production will be permitted to read.
 */

type Params = { orgSlug: string; projectSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveProjectPath(principal, params, services);
  const orgId = scope.organization.id;

  authorize(scope, 'member.update');

  const [page, grants, environments] = await Promise.all([
    // One page, at the repository's ceiling. An organisation past 200 members
    // is past what a grant dialog can usefully show anyway, and the member
    // screen — which pages properly — remains the place to work through one.
    listMembers(services.db, orgId, { pageSize: 200 }),
    listGrantsForOrganization(services.db, orgId),
    listEnvironments(services.db, orgId, scope.project.id),
  ]);

  const viewerUserId = scope.actor.kind === 'serviceToken' ? null : scope.actor.userId;

  // `effectiveAccess` resolves the whole organisation's grid for a member; the
  // rows for other projects are computed and dropped here rather than being
  // asked for separately, because the grid is one pass over grants either way.
  const environmentRows = environments.map((environment) => ({
    ...environment,
    project: { id: scope.project.id, name: scope.project.name, slug: scope.project.slug },
  }));

  return json({
    project: { name: scope.project.name, slug: scope.project.slug },
    environments: environments.map(toEnvironment),
    members: page.members.map((member) => {
      const [project] = effectiveAccess(
        member,
        grants.filter((grant) => grant.memberId === member.id),
        environmentRows,
      );

      return {
        ...toMember(member, viewerUserId),
        // The member's own grant rows for this project, so the dialog knows
        // which of the levels below are written grants and which are role
        // defaults it would have to write over — the same distinction the
        // per-member access endpoint returns.
        grants: grants
          .filter((grant) => grant.memberId === member.id && grant.projectId === scope.project.id)
          .map((grant) => ({
            environmentSlug:
              grant.environmentId === null
                ? null
                : (environments.find((environment) => environment.id === grant.environmentId)
                    ?.slug ?? null),
            accessLevel: grant.accessLevel,
          })),
        // Absent only for a project with no environments at all, where there
        // is nothing to resolve and nothing to grant.
        environments: project?.environments ?? [],
      };
    }),
  });
});
