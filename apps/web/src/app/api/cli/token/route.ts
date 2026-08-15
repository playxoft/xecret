import { z } from 'zod';
import { isWellFormedToken, PKCE_VERIFIER_PATTERN, verifyPkce } from '@xecret/core/auth';
import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditRecord } from '@xecret/core/audit';
import {
  consumeCliAuthCodeByValue,
  createCliToken,
  findOrganizationById,
  findUserById,
  loadAuthorizationContext,
  revokeCliToken,
} from '@xecret/db/repositories';
import { DatabaseAuditSink } from '@/server/audit-sink';
import { errors } from '@/server/errors';
import { json, noContent, parseJsonBody } from '@/server/http';
import { describeError } from '@/server/logging';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute, publicRoute } from '@/server/route';
import type { ServiceContext } from '@/server/context';

/**
 * The CLI credential's two endpoints: the PKCE exchange that mints it, and the
 * self-revocation `xecret logout` performs.
 *
 * `POST` is a `publicRoute` because the caller has no xecret credential yet —
 * what it holds is the one-time code the consent screen produced and the PKCE
 * verifier that never left its process. Both are required, the code is
 * consumed atomically before anything else is looked at, and every failure
 * after the rate limit is the same fixed 401: telling a caller *which* half of
 * a stolen handshake was wrong is a gift (see `errors.ts`).
 *
 * The minted token is returned exactly once. Only its hash is stored, and no
 * listing anywhere returns it — the same rule as every other credential.
 */

const exchangeRequest = z.strictObject({
  code: z.string().min(1).max(256),
  codeVerifier: z
    .string()
    .regex(PKCE_VERIFIER_PATTERN, 'The code verifier is not a valid PKCE value.'),
});

export const POST = publicRoute(async ({ request, services }) => {
  // Before the body is read: an unauthenticated caller must not make the
  // Worker do anything measurable by repeating a request. Keyed on IP — there
  // is no identity to key on until the exchange has already succeeded.
  await enforce(services.env, 'RL_CLI_TOKEN', rateLimitKey([services.meta.ipAddress]));

  const body = await parseJsonBody(request, exchangeRequest);

  // Structural check first, so junk costs a regular expression rather than a
  // digest and a database write.
  if (!isWellFormedToken(body.code, 'cliAuthCode')) {
    throw errors.unauthenticated('malformed cli auth code');
  }

  // Consumed before the PKCE check, deliberately. A code whose exchange fails
  // PKCE is a code presented by someone who does not hold the verifier — it
  // must die on the first attempt, not remain live for further guesses.
  const grant = await consumeCliAuthCodeByValue(services.db, body.code);
  if (!grant) throw errors.unauthenticated('unknown, expired or used cli auth code');

  if (!(await verifyPkce(grant.codeChallenge, body.codeVerifier))) {
    throw errors.unauthenticated('pkce verifier mismatch');
  }

  // The approval is minutes old, but the world may have moved: the account or
  // organisation may be gone, the membership revoked. A credential is not
  // issued to a principal that could not use it.
  const user = await findUserById(services.db, grant.userId);
  if (!user) throw errors.unauthenticated('approving user no longer exists');

  const organization = await findOrganizationById(services.db, grant.orgId);
  if (!organization) throw errors.unauthenticated('organisation no longer exists');

  const membership = await loadAuthorizationContext(services.db, {
    orgId: grant.orgId,
    userId: grant.userId,
  });
  if (!membership) throw errors.unauthenticated('membership no longer active');

  const issued = await createCliToken(services.db, {
    orgId: grant.orgId,
    userId: grant.userId,
    name: grant.deviceName,
  });

  // Written directly rather than through the request recorder: `publicRoute`
  // has no principal to bind one to. Attributed to the user the token acts as.
  services.waitUntil(
    writeEvents(services, [
      createAuditBuilder({
        orgId: grant.orgId,
        actorType: 'user',
        actorId: user.id,
        actorLabel: user.email,
        ipAddress: services.meta.ipAddress,
        userAgent: services.meta.userAgent,
        requestId: services.meta.requestId,
      }).success(
        'token.created',
        { type: 'token', id: issued.record.id },
        {
          tokenPrefix: issued.record.tokenPrefix,
          deviceName: grant.deviceName,
          source: 'cli',
        },
      ),
    ]),
  );

  return json(
    {
      // Shown once. The CLI puts it in the OS keychain and never prints it.
      token: issued.token,
      tokenPrefix: issued.record.tokenPrefix,
      user: { email: user.email, displayName: user.displayName },
      organization: { slug: organization.slug, name: organization.name },
    },
    { status: 201 },
  );
});

/**
 * `xecret logout`: the token revokes itself.
 *
 * Only a CLI token may call this — a session signs out through
 * `DELETE /api/auth/session`, and a service token is revoked by an operator
 * through the (Phase 8) token management routes, not by the pipeline holding
 * it. Idempotence matters here: revoking an already-revoked token still
 * returns 204, because the caller wanted the credential dead and it is — but
 * only the call that actually revoked it writes an audit record.
 */
export const DELETE = authenticatedRoute(async ({ principal, services, audit, record }) => {
  if (principal.kind !== 'cliToken') {
    throw errors.forbidden('Only a CLI token can revoke itself here.');
  }

  const revoked = await revokeCliToken(services.db, principal.orgId, principal.tokenId);

  if (revoked) {
    record(
      audit(principal.orgId).success(
        'token.revoked',
        { type: 'token', id: principal.tokenId },
        { deviceName: principal.tokenName, source: 'cli' },
      ),
    );
  }

  return noContent();
});

/** Same shape and reasoning as the session route's `writeEvents`. */
async function writeEvents(services: ServiceContext, events: AuditRecord[]): Promise<void> {
  try {
    await new DatabaseAuditSink(services.db).write(events);
  } catch (cause) {
    services.log
      .at('writeEvents')
      .error(
        `Failed to write the audit record for ${events[0]?.action ?? 'an event'} — the CLI token ` +
          'exchange itself succeeded, but this event is now missing from the audit log',
        { action: events[0]?.action, error: describeError(cause) },
      );
  }
}
