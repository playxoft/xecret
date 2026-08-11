import { AuthorizationError } from '@xecret/core/authz';
import { createEnvironment, listEnvironments, RepositoryError } from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import {
  environmentCreateSchema,
  resolveEnvironmentSlug,
  toEnvironment,
} from '@/server/schemas/resources';
import { authorize, resolveProjectPath } from '@/server/tenancy';

/**
 * The environments of one project.
 */

type Params = { orgSlug: string; projectSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveProjectPath(principal, params, services);

  // `environment.read` is environment-scoped and there is no environment in
  // scope yet, so the gate on the listing is the project it belongs to. Reading
  // what is *in* an environment is a separate decision, made per environment by
  // the routes that return contents.
  authorize(scope, 'project.read');

  // Ordered by `sort_order` in SQL, so every client — dashboard, CLI, CI — shows
  // the same sequence without each re-implementing it.
  return json({
    environments: (
      await listEnvironments(services.db, scope.organization.id, scope.project.id)
    ).map(toEnvironment),
  });
});

/**
 * Creates an environment together with its Env Data Key.
 *
 * The key is not optional and not deferred: `secret_versions.env_key_id` is NOT
 * NULL, so an environment without one silently rejects every write it will ever
 * receive, and repairing it requires an operator holding the Root KEK.
 * `createEnvironment` writes both inside one transaction for that reason.
 */
export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveProjectPath(principal, params, services);
    const orgId = scope.organization.id;

    try {
      authorize(scope, 'environment.create');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(
          audit(orgId).denied(
            'environment.created',
            { type: 'environment', id: null, projectId: scope.project.id },
            cause.decision,
          ),
        );
      }
      throw cause;
    }

    const body = await parseJsonBody(request, environmentCreateSchema);
    const slug = resolveEnvironmentSlug(body);

    // `isProduction` is accepted at creation under the same `environment.create`
    // permission that any other environment needs, and deliberately not raised
    // to the admin-level action that *flipping* it later requires. A new
    // environment holds nothing: the flag narrows who may read an empty box, and
    // the person creating it is the first to be locked out if they are a
    // developer. What has to be guarded is the other direction — reclassifying
    // an environment that already holds production secrets — and that is
    // `PATCH …/environments/{envSlug}`.
    const environment = await createEnvironment(services.db, {
      orgId,
      projectId: scope.project.id,
      name: body.name,
      slug,
      isProduction: body.isProduction,
      sortOrder: body.sortOrder,
      envelope: services.envelope,
    }).catch((cause: unknown) => {
      if (cause instanceof RepositoryError && cause.code === 'conflict') {
        throw errors.conflict(`An environment with the slug "${slug}" already exists.`);
      }
      // `notFound` here means the project was deleted between resolution and
      // this write. The repository raises the same code when an organisation has
      // no active master key, which is an operator-level fault — the two are not
      // distinguishable without matching on a message, and a message is not an
      // API contract. The first is the one that actually happens.
      if (cause instanceof RepositoryError && cause.code === 'notFound') {
        throw errors.notFound('project deleted concurrently');
      }
      throw cause;
    });

    record(
      audit(orgId).success(
        'environment.created',
        {
          type: 'environment',
          id: environment.id,
          projectId: scope.project.id,
          environmentId: environment.id,
        },
        { projectSlug: scope.project.slug, environmentSlug: environment.slug },
      ),
    );

    return json({ environment: toEnvironment(environment) }, { status: 201 });
  },
);
