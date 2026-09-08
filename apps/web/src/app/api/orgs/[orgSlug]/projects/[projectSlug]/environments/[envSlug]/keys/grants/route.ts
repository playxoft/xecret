import { actorId } from '@/server/actor';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { addGrants } from '@/server/env-keys-service';
import { environmentKeyGrantsSchema } from '@/server/schemas/env-keys';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Hands an environment's keys to a principal that did not have them: a member
 * who has just gained access, a service token, or an invitation.
 *
 * ── Two independent questions, and both are asked ──
 * The **granter** must hold the key, and `secret.read` on this environment is
 * what stands for that. It is not a lax gate dressed up: sealing a key requires
 * opening it, opening it requires a grant, and holding a grant requires read
 * access — so the authorization check and the cryptographic reality agree by
 * construction rather than by coincidence.
 *
 * The **recipient** must be entitled to it, which is a separate check against
 * their own resolved level. Without it this endpoint would be privilege
 * escalation with extra steps: any developer holding a production key could hand
 * it to anybody in the organisation, and production's deny-by-default rule would
 * hold on the routes that read secrets while the key itself circulated freely.
 *
 * ── Fulfilling a queued share ──
 * A grant to a member deletes that member's `pending_key_grants` row in the same
 * transaction. That is what stops the "1 pending key share" banner outliving the
 * key it was asking for, and it is why a failed write cannot silently clear one.
 *
 * ── Why a bearer token cannot call this ──
 * Producing a grant means opening a key with a private key and signing the
 * result with another, both of which live in an unlocked browser and nowhere
 * else. A CLI or service token has neither, so a body from one could only ever
 * have been fabricated; the refusal says that rather than storing it.
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

    const body = await parseJsonBody(request, environmentKeyGrantsSchema);
    const result = await addGrants(scope, services, principal, body);

    // One record per grant, not one per request. Unlike a bulk secret read —
    // which is audited as a single count precisely so a CI fleet cannot flood
    // the partition — each of these names a *different principal gaining a key*,
    // and collapsing them would lose the fact that matters: who. The set is
    // bounded by the roster, and this is not a path anything polls.
    for (const grant of body.grants) {
      record(
        audit(scope.organization.id).success(
          'envkey.granted',
          {
            type: 'environment',
            id: scope.environment.id,
            projectId: scope.project.id,
            environmentId: scope.environment.id,
          },
          {
            projectSlug: scope.project.slug,
            environmentSlug: scope.environment.slug,
            principalKind: grant.recipientKind,
            source: 'dashboard',
          },
        ),
      );
    }

    return json({ granted: result.added }, { status: 201 });
  },
);
