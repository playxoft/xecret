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
 * The bulk read: one environment, every current secret, decrypted.
 *
 * This is the path `xecret run` and every CI job depend on, so it is the one
 * place in the product where cost has to be reasoned about rather than assumed.
 *
 * ## Query budget
 *
 * **This handler issues two queries, and both are constant in the number of
 * secrets:**
 *
 *   1. `loadEnvironmentKeyChain` — the environment's data key and the
 *      organisation key that wrapped it, in one row. Splitting it would double
 *      the round trips on the hottest path in the system.
 *   2. `loadEnvironmentSecrets` — the current version of every secret, resolved
 *      by one `DISTINCT ON` walking `secret_versions_current_idx`. Not a query
 *      per secret, and not a window function that reads the whole history to
 *      answer a question about its head.
 *
 * The third query in the contract's budget of three is the audit insert, which
 * the route wrapper batches and flushes from `waitUntil` after the response has
 * been sent — so it is off the latency path entirely.
 *
 * The spine adds a fixed prefix that the budget does not count and this comment
 * should: one credential lookup in `authenticate`, and the tenancy chain in
 * `resolveEnvironmentPath` — organisation, membership, project, environment,
 * which is four queries for a user or CLI token and three for a service token,
 * which has no membership row. That is **6 or 7 statements per pull in total**,
 * every one of them constant in the number of secrets. An environment holding
 * five thousand secrets costs exactly what one holding five costs, plus the
 * bytes.
 *
 * **Zero outgoing fetches.** A Worker invocation may have six connections in
 * flight; the database reaches Neon through Hyperdrive, which does not spend one
 * (ADR 0006), and the Root KEK comes from a binding rather than over the network
 * (ADR 0002).
 *
 * ## One audit record, not one per secret
 *
 * A 200-secret pull writes a single `secret.read` carrying `secretCount`. Writing
 * one row per secret would mean a CI fleet pulling every minute could inflate the
 * audit partition faster than anyone reads it — the audit table would become a
 * denial-of-service surface against itself, and the records that matter would be
 * buried under the ones that do not. The count is the fact worth keeping; *which*
 * secrets an environment holds is already answerable from the secret listing.
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

    // `RL_SECRET_READ` for a person, `RL_SERVICE` for a service token — a
    // separate bucket so a runaway pipeline cannot exhaust the budget the
    // dashboard depends on.
    await enforceSecretRateLimit(services, principal, 'read');

    const { format } = parseQuery(request, documentQuery);

    const secrets = await decryptEnvironment(scope, services);

    // Queued before the document is rendered, not after. `renderSecretDocument`
    // can reject a value the requested format cannot represent, and by that
    // point every secret in the environment has already been decrypted — a
    // failure there must not be the one path that produces plaintext without a
    // record of it. The wrapper flushes queued records in a `finally`, so the
    // record survives the rejection.
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

    return new Response(document.body, {
      headers: {
        'content-type': document.contentType,
        // `json()` sets this for the responses it builds; this one is
        // constructed by hand, so it sets it explicitly. The body is a set of
        // live credentials — `private` would not be enough, because the risk is
        // an intermediary that ignores it.
        'cache-control': 'no-store',
        // The body is entirely user-supplied content served from our own origin.
        // Without this, a browser that content-sniffs it as HTML would run it.
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
