import { findSecretByName, getSecretVersion } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { restoreSecretBody, secretNameFromPath } from '@/server/schemas/secrets';
import {
  auditSource,
  authorizeSecretAction,
  enforceSecretRateLimit,
  restoreSecretVersion,
  writerUserId,
} from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Restores an earlier value as a new current version.
 *
 * History is never rewritten: the old row stays exactly where it is, and the
 * restored value is appended. That keeps "this value was current between Tuesday
 * and Friday, then again from Monday" a fact the table can express.
 *
 * **The old ciphertext is decrypted and encrypted again — never copied.** The
 * AAD binds `version`, so bytes produced for version 3 and stored as version 7
 * would fail to decrypt for the rest of their life, silently, with the failure
 * surfacing weeks later as an unreadable secret. `restoreSecretVersion` does the
 * decrypt and the re-encrypt under one unwrapped key and builds each context
 * from its own row, which is what makes the copy impossible to write by
 * accident.
 *
 * Audited as `secret.rotated`: from the environment's point of view the current
 * value changed, which is exactly what a rotation review needs to see.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  name: string;
}

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    authorizeSecretAction(scope, principal, 'secret.rotate');

    const writer = writerUserId(principal);
    await enforceSecretRateLimit(services, principal, 'write');

    const name = secretNameFromPath(params.name);
    const body = await parseJsonBody(request, restoreSecretBody);

    const current = await findSecretByName(
      services.db,
      scope.organization.id,
      scope.environment.id,
      name,
    );
    if (!current) throw errors.notFound('no live secret with that name in environment');

    // Scoped by `orgId` as well as by the secret id resolved above, because the
    // repository takes the organisation as its tenancy predicate and a version
    // number from a request body must not be able to reach past it.
    const previous = await getSecretVersion(
      services.db,
      scope.organization.id,
      current.secretId,
      body.version,
    );
    // A version that never existed and one that belongs to another tenant give
    // the same answer, for the same reason everything else here does.
    if (!previous) throw errors.notFound('no such version of that secret');

    const result = await restoreSecretVersion(scope, services, { writer, current, previous });

    record(
      audit(scope.organization.id).success(
        'secret.rotated',
        {
          type: 'secret',
          id: result.secretId,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          secretName: result.name,
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          source: auditSource(principal),
          // The version restored *from*, and whether it actually changed
          // anything. `AuditMetadata` has no field for a secret version, and
          // `keyVersion` names key material rather than a secret's, so the fact
          // is carried as a category string instead of stretching a field to
          // mean something it does not.
          reason:
            result.status === 'unchanged'
              ? `restored-from-v${previous.version}-unchanged`
              : `restored-from-v${previous.version}`,
        },
      ),
    );

    return json({
      secret: {
        name: result.name,
        version: result.version,
        status: result.status,
        restoredFrom: previous.version,
      },
    });
  },
);
