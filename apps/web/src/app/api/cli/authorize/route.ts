import { z } from 'zod';
import { PKCE_CHALLENGE_PATTERN } from '@xecret/core/auth';
import { AuthorizationError } from '@xecret/core/authz';
import { slugSchema } from '@xecret/core/validation';
import { createCliAuthCode } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * The consent screen's server half: a signed-in person approves CLI access for
 * a named device, and a one-time authorization code is minted.
 *
 * The code is not a credential. Exchanging it (`POST /api/cli/token`)
 * additionally requires the PKCE verifier, which never left the CLI process on
 * the machine being approved — so a code leaking through the browser (history,
 * an extension, a shoulder) mints nothing on its own.
 *
 * ## Who may approve
 *
 * Any **active member** of the organisation, gated by `member.read` — the same
 * org-scoped capability every listing route uses to settle membership, which is
 * what refuses a suspended member. Deliberately *not* `token.create`: that
 * capability is the administrative gate on **service** tokens, which grant
 * standing access to an environment and outlive their creator (threat T5). A
 * CLI token is different in kind — it acts as its user, with that user's own
 * role and grants, and adds no authority. Requiring an admin to approve every
 * developer's laptop would make `xecret login` an admin ceremony while
 * protecting nothing the authorization engine does not already enforce
 * per-request.
 *
 * ## Why only a browser session may call this
 *
 * A bearer credential is refused even though `authenticatedRoute` accepts one.
 * A CLI token approving further CLI tokens would let one stolen laptop
 * credential quietly propagate itself; requiring the cookie-authenticated
 * session (with CSRF and the PIN gate in front of it) keeps a *person* in the
 * loop for every new device. The default lock gate applies for the same
 * reason: an unattended, locked dashboard must not be able to approve anything.
 */

const authorizeRequest = z.strictObject({
  orgSlug: slugSchema,
  deviceName: z
    .string()
    .trim()
    .min(1, 'A device name is required.')
    .max(100, 'A device name must be at most 100 characters.')
    // Control characters are refused: this string lands in the consent UI, the
    // token listing and the audit log, where a carriage return is a spoof.
    .regex(/^\P{C}+$/u, 'A device name cannot contain control characters.'),
  codeChallenge: z
    .string()
    .regex(PKCE_CHALLENGE_PATTERN, 'The code challenge is not a valid S256 value.'),
});

export const POST = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  if (principal.kind !== 'user') {
    throw errors.forbidden('Approving CLI access requires a signed-in browser session.');
  }

  // Keyed on the user: the person approving, not the device being approved.
  await enforce(services.env, 'RL_CLI_TOKEN', rateLimitKey([principal.user.id]));

  const body = await parseJsonBody(request, authorizeRequest);

  const scope = await resolveOrg(principal, body.orgSlug, services);
  const orgId = scope.organization.id;

  try {
    authorize(scope, 'member.read');
  } catch (cause) {
    if (cause instanceof AuthorizationError) {
      record(audit(orgId).denied('token.authorized', { type: 'token', id: null }, cause.decision));
    }
    throw cause;
  }

  const issued = await createCliAuthCode(services.db, {
    userId: principal.user.id,
    orgId,
    deviceName: body.deviceName,
    codeChallenge: body.codeChallenge,
    ipAddress: services.meta.ipAddress,
  });

  // The approval is recorded here, from the browser's network position; the
  // credential itself is recorded as `token.created` at exchange, from the
  // CLI's. An approval that is never exchanged is itself a signal worth having.
  record(
    audit(orgId).success(
      'token.authorized',
      { type: 'token', id: issued.id },
      { deviceName: body.deviceName, source: 'dashboard' },
    ),
  );

  return json({ code: issued.code, expiresAt: issued.expiresAt.toISOString() });
});
