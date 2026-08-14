import { listSecrets } from '@xecret/db/repositories';
import { json, parseJsonBody, parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { toSecretValueType } from '@xecret/core/validation';
import { createSecretBody, listQuery } from '@/server/schemas/secrets';
import {
  auditSource,
  authorizeSecretAction,
  enforceSecretRateLimit,
  writeSecretValue,
  secretWriter,
} from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * An environment's secrets: the masked listing, and creation.
 *
 * The listing and the reveal (`secrets/[name]`) are separate routes on purpose.
 * Nothing in this file can produce a plaintext value except `POST`, which is
 * given one by the caller — so "which handler can decrypt a stored secret?" has
 * an answer that does not include this one.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

/**
 * The masked listing.
 *
 * `listSecrets` writes out its select list explicitly and never touches
 * `ciphertext`, `iv` or `value_hmac`. That matters more than it looks: loading
 * the whole row and dropping the ciphertext afterwards would be identical from
 * the outside and wrong in every way that counts — the bytes would still cross
 * the network, still land in a Worker buffer, and still appear in a slow-query
 * log. The environment's data key is never unwrapped on this path at all.
 *
 * **Not audited, deliberately.** §7 of the contract audits every mutation, every
 * decryption, and every denial; a masked listing is none of those. It produces
 * no plaintext, and the dashboard polls it on every navigation — auditing it
 * would bury the `secret.revealed` records that actually matter under a flood of
 * page views, which makes the audit log worse at its one job. The denial path is
 * still recorded: `authorize` throws, and the route wrapper flushes it.
 */
export const GET = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  const scope = await resolveEnvironmentPath(principal, params, services);
  authorizeSecretAction(scope, principal, 'secret.read');

  const { limit, cursor } = parseQuery(request, listQuery);
  const page = cursor ?? 1;

  const secrets = await listSecrets(services.db, scope.organization.id, scope.environment.id, {
    page,
    ...(limit === undefined ? {} : { pageSize: limit }),
  });

  return json({
    data: secrets.items.map((secret) => ({
      name: secret.name,
      note: secret.note,
      valueType: toSecretValueType(secret.valueType),
      version: secret.latestVersion,
      createdAt: secret.createdAt.toISOString(),
      updatedAt: secret.updatedAt.toISOString(),
      // The secret's author. *Who last changed it* is a property of the newest
      // `secret_versions` row, which this query does not read — resolving it
      // would mean a correlated lookup per secret for a column the list view
      // shows as a tooltip. `…/secrets/{name}/versions` answers it exactly.
      // Exactly one of the pair is set — a person, or the CI token that wrote it.
      createdBy: secret.createdBy,
      createdByServiceTokenId: secret.createdByServiceTokenId,
    })),
    nextCursor: secrets.hasMore ? String(page + 1) : null,
  });
});

/**
 * Creates a secret and its first version.
 *
 * A duplicate name is decided by `secrets_env_name_idx`, not by a `SELECT`
 * beforehand: check-then-insert is not a weaker guarantee, it is no guarantee at
 * all, because two concurrent requests can both read "free".
 */
export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    authorizeSecretAction(scope, principal, 'secret.create');

    // Resolved before the body is read so a credential that cannot be recorded
    // as the author is refused without the Worker buffering a 1 MB payload.
    const writer = secretWriter(principal);

    await enforceSecretRateLimit(services, principal, 'write');

    const body = await parseJsonBody(request, createSecretBody);

    const result = await writeSecretValue(scope, services, {
      writer,
      name: body.name,
      value: body.value,
      valueType: body.valueType,
      ...(body.note === undefined ? {} : { note: body.note }),
    });

    // The name, never the value. `AuditMetadata` makes the second half of that
    // sentence a type error rather than a habit — there is no field to put a
    // value in.
    record(
      audit(scope.organization.id).success(
        'secret.created',
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
        },
      ),
    );

    return json(
      {
        secret: {
          name: result.name,
          version: result.version,
          note: body.note ?? null,
          valueType: body.valueType,
        },
      },
      { status: 201 },
    );
  },
);
