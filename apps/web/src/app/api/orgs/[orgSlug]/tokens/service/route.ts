import { AuthorizationError } from '@xecret/core/authz';
import {
  createServiceToken,
  listEnvironmentsForOrganization,
  listServiceTokens,
} from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { requireMembership, requireSessionPrincipal } from '@/server/members-service';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import {
  decodeTokenPublicKey,
  resolveExpiry,
  serviceTokenCreateSchema,
  toServiceToken,
} from '@/server/schemas/tokens';
import { authorize, resolveEnvironment, resolveOrg, resolveProject } from '@/server/tenancy';

/**
 * Service tokens — the CI credential (threat T5).
 *
 * Both verbs are gated on `token.create`, which only owners and admins hold. A
 * service token is standing access that outlives its creator's interest, sits
 * in a CI provider's settings screen, and acts as nobody; issuing one is a
 * decision for someone who can also revoke it. The *listing* shares the gate
 * because the list is a map of every standing credential the organisation has
 * — reconnaissance, for anyone who should not already know.
 *
 * Minting requires the browser session — the same "a bearer credential may not
 * mint further credentials" rule as `/api/cli/authorize` and invitations.
 *
 * The token value is returned exactly once, in the creation response. Only its
 * hash is stored; no listing can recover it, by construction — the repository's
 * summary type does not carry the column.
 *
 * Scope is resolved through the same tenancy chain as every other route, so a
 * token can only ever be pinned to a project and environment the minter can
 * name — and its blast radius is exactly that one environment, enforced at
 * authentication time forever after.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'token.create');

  const tokens = await listServiceTokens(services.db, scope.organization.id);

  // The rows hold project/environment ids; the payload speaks slugs. One pass
  // over the environment grid resolves every token, however many there are.
  const environments = await listEnvironmentsForOrganization(services.db, scope.organization.id);
  const bySlug = new Map(
    environments.map((environment) => [
      environment.id,
      { projectSlug: environment.project.slug, environmentSlug: environment.slug },
    ]),
  );

  return json({
    data: tokens.flatMap((token) => {
      const resolved = bySlug.get(token.environmentId);
      // A token pinned to a deleted environment cannot be spent — resolution
      // 404s at authentication — and cannot be rendered either. Omitted, not
      // invented.
      return resolved === undefined ? [] : [toServiceToken(token, resolved)];
    }),
  });
});

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, 'tokens']));

    try {
      authorize(scope, 'token.create');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(audit(orgId).denied('token.created', { type: 'token', id: null }, cause.decision));
      }
      throw cause;
    }

    const minter = requireSessionPrincipal(principal);
    requireMembership(scope);

    const body = await parseJsonBody(request, serviceTokenCreateSchema);

    const projectScope = await resolveProject(scope, body.projectSlug, services);
    const environmentScope = await resolveEnvironment(projectScope, body.environmentSlug, services);

    // A keypair belongs to a token only where there is something to seal to it.
    // Refused rather than ignored, for the same reason the secret routes refuse
    // `note` on an `e2ee` environment: silently dropping a field a caller sent
    // deliberately is how a client comes to believe it did something it did not.
    if (body.publicKey !== undefined && environmentScope.environment.encryptionMode !== 'e2ee') {
      throw errors.validation([
        {
          field: 'publicKey',
          message: 'This environment uses server-side encryption; a token needs no keypair.',
        },
      ]);
    }

    const issued = await createServiceToken(services.db, {
      orgId,
      projectId: projectScope.project.id,
      environmentId: environmentScope.environment.id,
      name: body.name,
      accessLevel: body.accessLevel ?? 'read',
      ipAllowlist: body.ipAllowlist ?? null,
      expiresAt: resolveExpiry(body.expiresAt, new Date()),
      createdBy: minter.user.id,
      // The public half only. The private half is the token's key half, which
      // the browser minted and this server must never see (spec §13.1).
      publicKey: body.publicKey === undefined ? null : decodeTokenPublicKey(body.publicKey),
    });

    record(
      audit(orgId).success(
        'token.created',
        {
          type: 'token',
          id: issued.record.id,
          projectId: projectScope.project.id,
          environmentId: environmentScope.environment.id,
        },
        {
          projectSlug: projectScope.project.slug,
          environmentSlug: environmentScope.environment.slug,
          newAccessLevel: issued.record.accessLevel,
        },
      ),
    );

    return json(
      {
        /** Returned exactly once. Never stored, never retrievable again. */
        token: issued.token,
        serviceToken: toServiceToken(issued.record, {
          projectSlug: projectScope.project.slug,
          environmentSlug: environmentScope.environment.slug,
        }),
      },
      { status: 201 },
    );
  },
);
