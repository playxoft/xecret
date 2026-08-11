import { findSecretByName, softDeleteSecret } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { secretNameFromPath, updateSecretBody } from '@/server/schemas/secrets';
import {
  auditSource,
  authorizeSecretAction,
  decryptOne,
  enforceSecretRateLimit,
  writeSecretValue,
  writerUserId,
} from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * One secret: reveal, new version, delete.
 *
 * `[name]` is a name, not an id — the whole path carries the tenancy chain, so
 * there is no primary-key lookup here that a missing check could turn into an
 * IDOR (threat T2). It is validated against `SECRET_NAME_PATTERN` before it
 * reaches a query, and it arrives percent-encoded; both are handled by
 * `secretNameFromPath`.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  name: string;
}

/**
 * Reveal: the one GET in the product that returns a plaintext credential.
 *
 * Every reveal is audited, every time, and the record is queued before the value
 * leaves this function. An unaudited reveal is the failure that matters most
 * here — the audit trail is what turns "someone read production's database
 * password" from an unanswerable question into a row.
 *
 * The honest limitation: `record()` queues, and the route wrapper flushes after
 * the response via `waitUntil`. A worker killed between the two loses the
 * record. Awaiting the write instead would put a database round trip on the
 * latency path of every reveal and still lose records to a crash one instruction
 * earlier, so the spine buffers deliberately — see `BufferedAuditRecorder`.
 *
 * `Cache-Control: no-store` is set by `json()` on every response it builds,
 * which is why this handler does not set it: one place to get right, and
 * `secrets-service.test.ts` asserts it rather than trusting the comment.
 */
export const GET = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    authorizeSecretAction(scope, principal, 'secret.read');
    await enforceSecretRateLimit(services, principal, 'read');

    const name = secretNameFromPath(params.name);

    const material = await findSecretByName(
      services.db,
      scope.organization.id,
      scope.environment.id,
      name,
    );
    if (!material) throw errors.notFound('no live secret with that name in environment');

    const value = await decryptOne(scope, services, material);

    record(
      audit(scope.organization.id).success(
        'secret.revealed',
        {
          type: 'secret',
          id: material.secretId,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          secretName: material.name,
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          source: auditSource(principal),
        },
      ),
    );

    return json({
      secret: {
        name: material.name,
        value,
        version: material.version,
        updatedAt: material.createdAt.toISOString(),
        updatedBy: material.createdBy,
      },
    });
  },
);

/**
 * Appends a new version.
 *
 * A value identical to the current one is a no-op: `writeSecretValue` compares
 * `value_hmac` without decrypting anything and returns `unchanged`. The response
 * still reports the current version, so a client that retries a failed request
 * sees success rather than a spurious conflict.
 */
export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    authorizeSecretAction(scope, principal, 'secret.update');

    const writer = writerUserId(principal);
    await enforceSecretRateLimit(services, principal, 'write');

    const name = secretNameFromPath(params.name);
    const body = await parseJsonBody(request, updateSecretBody);

    // Returns ciphertext this path never decrypts. It is the repository's only
    // name-to-id resolver, and it is the same query the reveal path uses — so
    // the alternative is a second lookup function that exists purely to fetch
    // less. The bytes stay inside the Worker and reach no response.
    const current = await findSecretByName(
      services.db,
      scope.organization.id,
      scope.environment.id,
      name,
    );
    if (!current) throw errors.notFound('no live secret with that name in environment');

    const result = await writeSecretValue(scope, services, {
      writer,
      name: current.name,
      value: body.value,
      existing: {
        secretId: current.secretId,
        version: current.version,
        valueHmac: current.valueHmac,
      },
    });

    // Recorded whether or not a version was appended. The caller asked for a
    // change and the request was accepted; `reason` distinguishes the two
    // outcomes so a rotation review can tell "rotated" from "re-submitted the
    // value that was already there".
    record(
      audit(scope.organization.id).success(
        'secret.updated',
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
          ...(result.status === 'unchanged' ? { reason: 'unchanged' } : {}),
        },
      ),
    );

    return json({
      secret: { name: result.name, version: result.version, status: result.status },
    });
  },
);

/**
 * Soft delete.
 *
 * The versions are left untouched — they are the record of what the value used
 * to be, and `restore` depends on them surviving. `secrets_env_name_idx` is
 * partial on `deleted_at IS NULL`, so the name is released immediately and a
 * user who deleted `DATABASE_URL` by mistake can create it again.
 */
export const DELETE = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    // `secret.delete` is absent from `SERVICE_TOKEN_ACTIONS`, so a CI credential
    // is refused here by the policy engine rather than by a check in this file.
    authorizeSecretAction(scope, principal, 'secret.delete');
    await enforceSecretRateLimit(services, principal, 'write');

    const name = secretNameFromPath(params.name);

    const current = await findSecretByName(
      services.db,
      scope.organization.id,
      scope.environment.id,
      name,
    );
    if (!current) throw errors.notFound('no live secret with that name in environment');

    await softDeleteSecret(services.db, scope.organization.id, current.secretId);

    record(
      audit(scope.organization.id).success(
        'secret.deleted',
        {
          type: 'secret',
          id: current.secretId,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          secretName: current.name,
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          source: auditSource(principal),
        },
      ),
    );

    return json({ secret: { name: current.name, deleted: true } });
  },
);
