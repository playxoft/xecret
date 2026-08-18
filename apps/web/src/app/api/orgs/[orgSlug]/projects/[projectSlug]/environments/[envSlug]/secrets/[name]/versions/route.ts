import { findSecretByName, listSecretVersions } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { listQuery, secretNameFromPath } from '@/server/schemas/secrets';
import { authorizeSecretAction } from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * A secret's version history. **Metadata only.**
 *
 * No ciphertext, no IV, no HMAC, and above all no values. That is not a
 * simplification of a richer endpoint that might arrive later — it is the point
 * of the endpoint.
 *
 * **Why history must not hand back old values.** A rotated secret is not a dead
 * secret. `AWS_SECRET_ACCESS_KEY` version 3 keeps working until somebody
 * disables it at AWS, and the gap between "rotated in xecret" and "revoked at
 * the provider" is measured in weeks for most teams and never for some. A
 * history endpoint that returned values would therefore serve live credentials
 * under an interface people reason about as an archive — and it would do so at
 * an access level nobody thinks of as sensitive, because "showing the history"
 * sounds like showing timestamps.
 *
 * The deliberate consequence: recovering an old value is `POST …/restore`, which
 * re-encrypts it as a new current version and writes `secret.rotated` to the
 * audit log. Reading the past is therefore always an act with a record, and
 * `listSecretVersions` selects no ciphertext column at all — so rendering this
 * page is not a decryption opportunity even for a caller who could reach one.
 *
 * `envKeyId` is included because an operator investigating a rotation needs to
 * know which data key a version was written under. It is an opaque identifier
 * that confers no access; the key itself never leaves `env_keys` unwrapped.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  name: string;
}

export const GET = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  const scope = await resolveEnvironmentPath(principal, params, services);
  authorizeSecretAction(scope, principal, 'secret.read');

  const name = secretNameFromPath(params.name);
  const { limit, cursor } = parseQuery(request, listQuery);
  const page = cursor ?? 1;

  // Resolves name to id. `findSecretByName` excludes soft-deleted secrets, so
  // the history of a deleted secret is not reachable through this path even
  // though `listSecretVersions` would serve it — recovering that is a restore of
  // the secret first, which is an audited act. Investigating a deletion is the
  // audit log's job, and it holds the `secret.deleted` record.
  const secret = await findSecretByName(
    services.db,
    scope.organization.id,
    scope.environment.id,
    name,
  );
  if (!secret) throw errors.notFound('no live secret with that name in environment');

  const versions = await listSecretVersions(services.db, scope.organization.id, secret.secretId, {
    page,
    ...(limit === undefined ? {} : { pageSize: limit }),
  });

  return json({
    data: versions.items.map((version) => ({
      version: version.version,
      algorithm: version.algorithm,
      envKeyId: version.envKeyId,
      createdAt: version.createdAt.toISOString(),
      createdBy: version.createdBy,
      createdByServiceTokenId: version.createdByServiceTokenId,
      current: version.version === secret.version,
    })),
    nextCursor: versions.hasMore ? String(page + 1) : null,
  });
});
