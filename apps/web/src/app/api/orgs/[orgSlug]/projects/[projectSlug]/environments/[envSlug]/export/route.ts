import { parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { documentQuery } from '@/server/schemas/secrets';
import {
  auditSource,
  authorizeSecretAction,
  decryptEnvironment,
  enforceSecretRateLimit,
  renderSecretDocument,
} from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Export: the same data as `pull`, delivered as a file download.
 *
 * **Writing secrets to a file is a deliberate downgrade in security posture, and
 * this endpoint exists anyway.** Everything the rest of the product is built to
 * prevent starts happening the moment the bytes land on a disk: the file is not
 * encrypted at rest, it outlives the session that produced it, it gets picked up
 * by Time Machine and Dropbox and whatever else indexes a home directory, it is
 * attached to a ticket, and — most often — it is committed. None of that is
 * visible to xecret, and no access grant can be revoked after the fact, because
 * the copy is no longer ours. The audit log records that an export happened and
 * then loses the trail entirely.
 *
 * It exists because the alternative is worse. A team that cannot export will
 * paste values into Slack one at a time, and that is strictly less safe and
 * completely unaudited. So the capability is offered, it is authorised and
 * counted exactly like a pull, and `xecret export` prints a warning explaining
 * what the user has just taken responsibility for.
 *
 * Audited identically to `pull`, as `secret.read` with a count. The action
 * vocabulary is a closed union with no export-specific member, and inventing one
 * here would mean widening a type that every audit consumer switches on; the
 * request path and `source` already distinguish the two in the record.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

export const GET = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    authorizeSecretAction(scope, principal, 'secret.read');
    await enforceSecretRateLimit(services, principal, 'read');

    const { format } = parseQuery(request, documentQuery);

    const secrets = await decryptEnvironment(scope, services);

    // Queued before rendering, for the reason set out in `pull`: the secrets are
    // already decrypted by this point, and a format the values cannot be
    // represented in must not become the one path that produces plaintext with
    // no record of it.
    record(
      audit(scope.organization.id).success(
        'secret.read',
        {
          type: 'environment',
          id: scope.environment.id,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          secretCount: secrets.length,
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          source: auditSource(principal),
        },
      ),
    );

    const document = renderSecretDocument(secrets, format);

    // Built from two slugs, both of which matched `SLUG_PATTERN`
    // (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) before their rows were created, and an
    // extension from a closed map. There is no quote, backslash, semicolon or
    // line break any of the three can contain, so the header cannot be split or
    // its filename escaped — which is the failure mode a `Content-Disposition`
    // assembled from user input normally has.
    const filename = `${scope.project.slug}-${scope.environment.slug}.${document.extension}`;

    return new Response(document.body, {
      headers: {
        'content-type': document.contentType,
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
