import { auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import {
  lockProjectEnvironments,
  RepositoryError,
  setEnvironmentParent,
} from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { requireFeature } from '@/server/entitlements';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import {
  assertParentChange,
  assertTokenReach,
  findParentCandidate,
  mayActOn,
  parentSlugOf,
} from '@/server/references-service';
import { authenticatedRoute } from '@/server/route';
import { environmentParentSchema, toEnvironment } from '@/server/schemas/resources';
import { planRefusal } from '@/server/template-writes';
import { authorize, resolveEnvironmentPath } from '@/server/tenancy';

/**
 * An environment's parent (P19 §1): `PUT {"parent": "<slug>"}` to inherit from
 * another environment of the same project, `PUT {"parent": null}` to stop.
 *
 * ── Who may ──
 * `environment.update` on this environment — the administrative act that also
 * reclassifies it as production, because it changes what every reader of the
 * environment receives — and `secret.read` on the parent, so nobody makes an
 * environment inherit values they could not read themselves.
 *
 * ── What is refused, before anything is written ──
 *  - a parent outside this project, or not end-to-end encrypted;
 *  - a loop, or a chain past five parents;
 *  - a change that would leave any view a template reaches unresolvable —
 *    including views in other projects that read into this one;
 *  - an environment with an active service token, which being pinned here could
 *    not read the parent.
 *
 * The check and the write happen under a lock on the project's environment
 * rows, so two re-parentings that would together form a loop cannot both pass.
 *
 * ── The plan ──
 * Setting a parent needs `secretReferencing`. Clearing one never does: taking a
 * feature away from an environment is always allowed, and an organisation that
 * downgraded keeps every parent it set — the pull never asks the plan.
 */

type Params = { orgSlug: string; projectSlug: string; envSlug: string };

export const PUT = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveEnvironmentPath(principal, params, services);
    const orgId = scope.organization.id;
    const resource = {
      type: 'environment' as const,
      id: scope.environment.id,
      projectId: scope.project.id,
      environmentId: scope.environment.id,
    };
    const refused = (decision: Denial): void =>
      record(audit(orgId).denied('environment.parent_changed', resource, decision));

    auditingDenials(refused, () => authorize(scope, 'environment.update'));

    const body = await parseJsonBody(request, environmentParentSchema);

    if (scope.environment.encryptionMode !== 'e2ee') {
      throw errors.conflict(
        'e2ee_required: inheritance needs an end-to-end encrypted environment.',
      );
    }

    const previous = await parentSlugOf(services, orgId, scope.environment);

    let parentId: string | null = null;
    if (body.parent !== null) {
      requireFeature(
        scope.entitlements,
        'secretReferencing',
        planRefusal(
          record,
          audit(orgId),
          'environment.parent_changed',
          resource,
          'secretReferencing',
          scope.entitlements.plan,
          { environmentSlug: scope.environment.slug, projectSlug: scope.project.slug },
        ),
      );

      const parent = await findParentCandidate(scope, services, body.parent);
      if (!mayActOn(scope, principal, parent, 'secret.read')) {
        throw errors.forbidden(
          'You cannot read that environment, so you cannot make another inherit from it.',
        );
      }
      await assertTokenReach(scope, services, 'parent');
      parentId = parent.id;
    }

    if (parentId === scope.environment.parentEnvironmentId) {
      return json({ environment: toEnvironment(scope.environment, previous) });
    }

    const updated = await services.db
      .transaction(async (tx) => {
        await lockProjectEnvironments(tx, scope.project.id);
        await assertParentChange(scope, tx, parentId);
        return setEnvironmentParent(tx, orgId, scope.environment.id, parentId);
      })
      .catch((cause: unknown) => {
        if (cause instanceof RepositoryError && cause.code === 'notFound') {
          throw errors.notFound('environment deleted concurrently');
        }
        throw cause;
      });

    record(
      audit(orgId).success('environment.parent_changed', resource, {
        projectSlug: scope.project.slug,
        environmentSlug: scope.environment.slug,
        parentEnvironmentSlug: body.parent,
        previousParentEnvironmentSlug: previous,
      }),
    );

    return json({ environment: toEnvironment(updated, body.parent) });
  },
);
