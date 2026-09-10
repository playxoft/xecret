import { actorId } from '@/server/actor';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { rotateKeys } from '@/server/env-keys-service';
import { environmentKeyRotateSchema } from '@/server/schemas/env-keys';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Rotates an environment's data key and re-seals it to every remaining
 * principal.
 *
 * ── What a rotation is for ──
 * It is the *second half of a revocation*. Deleting somebody's grant stops them
 * being handed the key again; only replacing the key stops the copy they already
 * have from opening whatever is written next. An environment where a grant was
 * removed and no rotation followed has been revoked on paper only, which is why
 * `GET …/keys` reports `needsRotation` until one lands with a version bump.
 *
 * ── The server checks the one thing it can ──
 * Completeness. The client generates the new key and seals it, because only the
 * client can — but that means the client also chooses who receives it, and a
 * client that quietly omitted somebody would produce a request that succeeds and
 * silently revokes a colleague, with no error and no screen anywhere saying so.
 * So the server recomputes the required set from `can()` and refuses anything
 * that does not match exactly, naming who is missing and who is surplus.
 *
 * The other direction matters as much: an **extra** grant is a key handed to
 * somebody the access model does not permit, minted through the one endpoint
 * whose job is writing grants in bulk. Without the check, a rotation would be a
 * way to give a viewer production keys while the audit log recorded routine
 * maintenance.
 *
 * ── What it does not do ──
 * It does not re-encrypt anything. Historical `secret_versions` keep their
 * reference to the retired key and stay readable to whoever still holds an old
 * grant — which is correct, because a member removed today did not stop having
 * seen yesterday's values. The UI's job is to say so and prompt for the secrets
 * themselves to be rotated at their providers; no key ceremony can do that.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const body = await parseJsonBody(request, environmentKeyRotateSchema);
    const key = await rotateKeys(scope, services, principal, body);

    record(
      audit(scope.organization.id).success(
        'envkey.rotated',
        {
          type: 'environment',
          id: scope.environment.id,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          // The version and the head count, never a grant and never a public
          // key. "The production key was rotated and re-sealed to 9 principals"
          // is checkable against the roster, and a number that drops without a
          // matching removal is the shape of a rotation that lost somebody.
          keyVersion: key.version,
          grantCount: key.grantCount,
          source: 'dashboard',
        },
      ),
    );

    return json({ activeEdk: { id: key.id, version: key.version }, grants: key.grantCount });
  },
);
