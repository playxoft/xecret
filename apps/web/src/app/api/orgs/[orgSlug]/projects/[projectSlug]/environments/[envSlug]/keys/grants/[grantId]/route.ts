import { actorId } from '@/server/actor';
import { errors } from '@/server/errors';
import { noContent } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { revokeGrant } from '@/server/env-keys-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Removes one principal's grant on an environment.
 *
 * ── This does not make anything unreadable, and the API must not imply it does ──
 * The principal read what they read while they held the grant, and the sealed key
 * may still sit in a browser's memory or inside a service token's string. What
 * this stops is their being handed the key *again* — on the next environment
 * open, on the next device, after the next sign-in.
 *
 * The act that actually protects future writes is `POST …/keys/rotate`, which
 * replaces the key they hold. Until one lands with a version bump, `GET …/keys`
 * answers `needsRotation: true`, which is how the dashboard says "this
 * revocation is half done" rather than letting an administrator believe an act
 * completed that did not.
 *
 * ── Why `environment.update` and not something narrower ──
 * Revocation and rotation are two halves of one act and take the same authority.
 * A gate that let somebody delete grants but not rotate would let them leave an
 * environment in the half-revoked state permanently, which is worse than not
 * being able to start.
 *
 * ── Not found rather than forbidden ──
 * A grant id from another tenant and one that never existed give the same answer.
 * The repository scopes the lookup by environment, so the two are
 * indistinguishable here by construction rather than by a check that could be
 * removed (threat T2).
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  grantId: string;
}

/** A uuid, so a malformed segment never reaches a bound query parameter. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    // `not_found`, matching `secretNameFromPath`: this segment addresses a
    // resource, and a value outside the pattern names one that cannot exist.
    // Answering "invalid" would distinguish malformed from absent for a caller
    // entitled to neither.
    if (!UUID_PATTERN.test(params.grantId)) {
      throw errors.notFound('grant id outside the permitted pattern');
    }

    const removed = await revokeGrant(scope, services, principal, params.grantId);

    record(
      audit(scope.organization.id).success(
        'envkey.grant_revoked',
        {
          type: 'environment',
          id: scope.environment.id,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          principalKind: removed.recipientKind,
          // States plainly what the record does and does not mean, so a review
          // reading this line alone does not conclude the environment was
          // secured at this moment.
          reason: 'rotation required',
          source: 'dashboard',
        },
      ),
    );

    return noContent();
  },
);
