import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { actorId } from '@/server/actor';
import { environmentKeyState, initializeKeys } from '@/server/env-keys-service';
import { environmentKeyInitSchema } from '@/server/schemas/env-keys';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * An environment's key state: what the caller holds, and what an administrator
 * still has to do.
 *
 * ── Why the grant is served on an ordinary read ──
 * Because there is nothing else it could be. A grant is the EDK and the EHK
 * sealed to the *caller's own* public key; handing it to them discloses
 * ciphertext they alone can open, and withholding it would leave them looking at
 * a list of secret names they cannot decrypt. The gate is `secret.read`, which is
 * the same authority as reading the values it unlocks — anything narrower would
 * let somebody hold a key for an environment they may not read, and anything
 * wider would be a key handed to somebody with no business in the environment.
 *
 * **Not audited.** A key read is not a decryption and not a mutation: it returns
 * a blob the caller could already have cached from the last time they opened the
 * environment, and the dashboard fetches it on every navigation. Auditing it
 * would bury the `secret.revealed` records that matter under a flood of page
 * views, which is the same argument the masked secret listing makes. Every act
 * that *changes* a key is audited, and the denial path is recorded by the route
 * wrapper.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveEnvironmentPath(principal, params, services);

  // Authorisation lives inside `environmentKeyState`, alongside every other
  // decision in `env-keys-service.ts`, so a future route reaching for the same
  // payload cannot arrive at it ungated.
  //
  // Answered for a `server`-mode environment too, rather than refused. The
  // dashboard asks this before it knows which mode an environment is in, and the
  // honest answer for a server-mode one is a complete payload saying so: no
  // active key, no grant, nothing pending. A 409 here would make the client
  // treat a perfectly ordinary environment as an error state.
  return json({ keys: await environmentKeyState(scope, services, principal) });
});

/**
 * Initialises an environment's key hierarchy: version 1 of the EDK, the EHK, and
 * the creator's own grant.
 *
 * **Not the ordinary path.** `POST …/environments` creates an environment and its
 * keys in one transaction, precisely so a keyless `e2ee` environment cannot come
 * to exist. This is the repair for the case that transaction could not cover, and
 * the idempotent-conflict semantics are what keep it a repair: a second call is a
 * 409, exactly as `POST /api/auth/vault` refuses to replace a vault, because the
 * existing key has values encrypted under it and replacing it silently would make
 * every one of them unreadable while reporting success.
 */
export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const body = await parseJsonBody(request, environmentKeyInitSchema);
    const key = await initializeKeys(scope, services, principal, body);

    record(
      audit(scope.organization.id).success(
        'envkey.created',
        {
          type: 'environment',
          id: scope.environment.id,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          keyVersion: key.version,
          grantCount: 1,
          source: 'dashboard',
        },
      ),
    );

    return json({ activeEdk: key }, { status: 201 });
  },
);
