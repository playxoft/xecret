import * as z from 'zod/mini';
import { PKCE_CHALLENGE_PATTERN } from '@xecret/core/auth';
import { AuthorizationError } from '@xecret/core/authz';
import { slugReferenceSchema } from '@xecret/core/validation';
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
 * session (with CSRF and the vault lock gate in front of it) keeps a *person* in the
 * loop for every new device. The default lock gate applies for the same
 * reason: an unattended, locked dashboard must not be able to approve anything.
 */

/**
 * Carried so an unrecognised field is refused with a sentence rather than with
 * zod's default `Invalid input`. `errorMessage` now renders field problems
 * verbatim on the consent screen, so every message this schema can produce is
 * one a person reads.
 */
const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

const authorizeRequest = z.strictObject(
  {
    /*
     * `slugReferenceSchema`, not `slugSchema`.
     *
     * This names an organisation the caller already belongs to — it came out of
     * their own switcher, which is populated from `GET /api/auth/me`. The
     * reserved-name list is a rule about *claiming* a slug, and applying it here
     * refused the approval outright for any organisation holding one, with a
     * `validation_failed` whose message ("The request could not be processed.")
     * named neither the field nor the reason. `xecret login` was unusable for
     * those organisations and there was nothing on the screen to say why.
     *
     * Nothing is loosened by this: the slug still has to resolve to an
     * organisation, `resolveOrg` still 404s when it does not, and `member.read`
     * below still settles whether this person may approve anything in it.
     */
    orgSlug: slugReferenceSchema,
    deviceName: z
      .string()
      .check(
        z.trim(),
        z.minLength(1, 'A device name is required.'),
        z.maxLength(100, 'A device name must be at most 100 characters.'),
        // Control characters are refused: this string lands in the consent UI,
        // the token listing and the audit log, where a carriage return is a
        // spoof.
        z.regex(/^\P{C}+$/u, 'A device name cannot contain control characters.'),
      ),
    codeChallenge: z
      .string()
      .check(z.regex(PKCE_CHALLENGE_PATTERN, 'The code challenge is not a valid S256 value.')),
  },
  UNEXPECTED_FIELD,
);

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
