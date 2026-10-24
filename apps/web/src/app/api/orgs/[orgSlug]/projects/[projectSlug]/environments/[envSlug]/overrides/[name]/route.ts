import type { Denial } from '@xecret/core/authz';
import { deleteOverride, RepositoryError, upsertOverride } from '@xecret/db/repositories';
import { requireFeature } from '@/server/entitlements';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { overrideOwner } from '@/server/overrides-service';
import { authenticatedRoute } from '@/server/route';
import { overrideBodySchema } from '@/server/schemas/overrides';
import { secretNameFromPath } from '@/server/schemas/secrets';
import { encodeBlob } from '@/server/schemas/vault';
import { auditSource, enforceSecretRateLimit } from '@/server/secrets-service';
import { planRefusal } from '@/server/template-writes';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * One personal override (P19 §2): `PUT` sets or replaces it, `DELETE` removes it.
 *
 * The name need not be a secret the environment holds — an override of a key
 * nobody has set yet is how a developer tries a new variable locally before
 * proposing it — but it follows the secret-name grammar, because it becomes an
 * environment variable.
 *
 * Setting one needs `personalOverrides` (Pro). Removing one never does, and an
 * organisation that downgrades keeps every override its members set: `xecret
 * run` applies them whatever the plan, because the data path never asks.
 */

type Params = { orgSlug: string; projectSlug: string; envSlug: string; name: string };

export const PUT = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    const builder = audit(scope.organization.id);
    const name = secretNameFromPath(params.name);
    const resource = {
      type: 'override' as const,
      id: null,
      projectId: scope.project.id,
      environmentId: scope.environment.id,
    };
    const context = {
      secretName: name,
      projectSlug: scope.project.slug,
      environmentSlug: scope.environment.slug,
    };

    const owner = overrideOwner(scope, principal, (decision: Denial) =>
      record(builder.denied('override.set', resource, decision, context)),
    );
    await enforceSecretRateLimit(services, principal, 'write');

    requireFeature(
      scope.entitlements,
      'personalOverrides',
      planRefusal(
        record,
        builder,
        'override.set',
        resource,
        'personalOverrides',
        scope.entitlements.plan,
        context,
      ),
    );

    const body = await parseJsonBody(request, overrideBodySchema);

    const { record: stored, created } = await upsertOverride(services.db, {
      ...owner,
      name,
      ciphertext: encodeBlob(body.ciphertext),
    }).catch((cause: unknown) => {
      if (cause instanceof RepositoryError && cause.code === 'quotaExceeded') {
        throw errors.conflict(cause.message);
      }
      if (cause instanceof RepositoryError && cause.code === 'notFound') {
        throw errors.notFound('environment deleted concurrently');
      }
      throw cause;
    });

    record(
      builder.success(
        'override.set',
        { ...resource, id: stored.id },
        { ...context, source: auditSource(principal), ...(created ? {} : { reason: 'replaced' }) },
      ),
    );

    return json({
      override: { name: stored.name, updatedAt: stored.updatedAt.toISOString(), created },
    });
  },
);

export const DELETE = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    const builder = audit(scope.organization.id);
    const name = secretNameFromPath(params.name);
    const resource = {
      type: 'override' as const,
      id: null,
      projectId: scope.project.id,
      environmentId: scope.environment.id,
    };
    const context = {
      secretName: name,
      projectSlug: scope.project.slug,
      environmentSlug: scope.environment.slug,
    };

    const owner = overrideOwner(scope, principal, (decision: Denial) =>
      record(builder.denied('override.removed', resource, decision, context)),
    );
    await enforceSecretRateLimit(services, principal, 'write');

    const removed = await deleteOverride(services.db, { ...owner, name });
    if (removed === null) throw errors.notFound('no override with that name');

    record(
      builder.success(
        'override.removed',
        { ...resource, id: removed.id },
        { ...context, source: auditSource(principal) },
      ),
    );

    return json({ override: { name, deleted: true } });
  },
);
