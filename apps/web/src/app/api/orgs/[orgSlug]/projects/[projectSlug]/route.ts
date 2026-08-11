import { AuthorizationError } from '@xecret/core/authz';
import {
  listEnvironments,
  RepositoryError,
  softDeleteProject,
  updateProject,
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
  projectPatchSchema,
  toEnvironment,
  toProject,
} from '@/server/schemas/resources';
import { authorize, resolveProjectPath } from '@/server/tenancy';

/**
 * One project: its detail, its editable fields, and its removal.
 *
 * `resolveProjectPath` walks organisation then project in that order, so a
 * project slug from another tenant is `not_found` before any permission is
 * consulted, and a service token cannot reach past the project it is pinned to.
 */

type Params = { orgSlug: string; projectSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveProjectPath(principal, params, services);
  authorize(scope, 'project.read');

  const environments = await listEnvironments(services.db, scope.organization.id, scope.project.id);

  return json({
    project: toProject(scope.project),
    // Listed in full for anyone who may read the project. An environment's name,
    // order and production flag are the shape of the project, not its contents;
    // reading anything *inside* one needs `environment.read` on that
    // environment, which production denies by default and which the environment
    // and secret routes enforce. Hiding the row would also contradict the
    // environment count returned by the project listing, which counts them all.
    environments: environments.map(toEnvironment),
  });
});

export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveProjectPath(principal, params, services);
    const orgId = scope.organization.id;
    const resource = {
      type: 'project' as const,
      id: scope.project.id,
      projectId: scope.project.id,
    };

    try {
      authorize(scope, 'project.update');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(audit(orgId).denied('project.updated', resource, cause.decision));
      }
      throw cause;
    }

    const patch = await parseJsonBody(request, projectPatchSchema);
    assertSlugImmutable(patch, 'project');

    const project = await updateProject(services.db, orgId, scope.project.id, {
      name: patch.name,
      description: patch.description,
    }).catch(rethrowVanished);

    record(audit(orgId).success('project.updated', resource, { projectSlug: project.slug }));

    return json({ project: toProject(project) });
  },
);

/**
 * Soft-deletes a project.
 *
 * Never a hard delete: the audit records that say this project existed, and who
 * removed it, must keep pointing at a row that is still there. The secrets it
 * held are hidden, not destroyed — cryptographic erasure is a separate,
 * deliberate operation on the environment keys.
 */
export const DELETE = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveProjectPath(principal, params, services);
    const orgId = scope.organization.id;
    const resource = {
      type: 'project' as const,
      id: scope.project.id,
      projectId: scope.project.id,
    };

    try {
      // The strongest permission a project has: `project.delete` is denied to
      // developers and viewers at the capability gate, where no grant can reach
      // it, and requires `admin` on this project besides.
      authorize(scope, 'project.delete');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(audit(orgId).denied('project.deleted', resource, cause.decision));
      }
      throw cause;
    }

    const body = await parseJsonBody(request, destructiveRequestSchema);
    const environments = await listEnvironments(services.db, orgId, scope.project.id);

    /**
     * A production environment raises the bar from "may they?" to "did they
     * mean to?".
     *
     * A permission check cannot tell those apart, and it is the second question
     * that goes wrong in practice: the admin who is entitled to delete this
     * project is exactly the person clicking through a list of projects at
     * speed. One soft delete hides every environment and every secret beneath
     * it at once, and the applications reading those secrets fail at their next
     * deploy rather than immediately, which makes the mistake expensive to
     * notice and awkward to explain. Typing the slug is the step that cannot
     * happen by accident — it is a guard against a misclick, not against an
     * attacker, who by definition already holds the permission.
     */
    if (environments.some((environment) => environment.isProduction)) {
      if (!confirmationMatches(scope.project.slug, body.confirm)) {
        // Recorded, not merely refused. A stream of unconfirmed deletion
        // attempts against production is a signal — either someone is confused
        // about a UI or someone is probing it.
        record(
          audit(orgId).error('project.deleted', resource, 'invalidInput', {
            projectSlug: scope.project.slug,
          }),
        );

        throw errors.badRequest(
          'This project contains a production environment. Repeat the request with {"confirm": "<project slug>"} to delete it.',
        );
      }
    }

    const project = await softDeleteProject(services.db, orgId, scope.project.id).catch(
      rethrowVanished,
    );

    record(audit(orgId).success('project.deleted', resource, { projectSlug: project.slug }));

    return noContent();
  },
);

/**
 * The project resolved a moment ago, so a repository miss means a concurrent
 * delete rather than a bug. Reported as absent — the same answer the caller
 * would have received had they arrived a second later — instead of the 500 an
 * unmapped `RepositoryError` would become at the route boundary.
 */
function rethrowVanished(cause: unknown): never {
  if (cause instanceof RepositoryError && cause.code === 'notFound') {
    throw errors.notFound('project deleted concurrently');
  }
  throw cause;
}
