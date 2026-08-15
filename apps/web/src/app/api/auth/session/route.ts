import { z } from 'zod';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_LIFETIME_MS,
  clearedSessionCookie,
  csrfCookie,
  generateCsrfToken,
  generateToken,
  hashToken,
  isWellFormedToken,
  serializeCookie,
  sessionCookie,
  verifyCsrf,
} from '@xecret/core/auth';
import { IdentityVerificationError } from '@xecret/core/auth';
import type { VerifiedIdentity } from '@xecret/core/auth';
import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditRecord } from '@xecret/core/audit';
import {
  bootstrapPersonalOrganization,
  createSession,
  findSessionByTokenHash,
  listOrganizationsForUser,
  RepositoryError,
  revokeSession,
  upsertUserFromIdentity,
} from '@xecret/db/repositories';
import type { OrganizationMembership } from '@xecret/db/repositories';
import { DatabaseAuditSink } from '@/server/audit-sink';
import { firebaseIdentityProvider } from '@/server/firebase';
import { errors } from '@/server/errors';
import { json, noContent, parseCookies, parseJsonBody } from '@/server/http';
import { describeError } from '@/server/logging';
import { attemptKey, enforce } from '@/server/rate-limit';
import { publicRoute } from '@/server/route';
import type { ServiceContext } from '@/server/context';

/**
 * Session exchange: the only endpoint that accepts a Firebase ID token.
 *
 * The Firebase token proves who someone is, once. It is verified, used to find
 * or create the xecret user, and discarded — it is never stored, never returned,
 * and never accepted again. From here on the credential is an xecret session,
 * which unlike a Firebase ID token can be revoked instantly (ADR 0003).
 *
 * The route is `publicRoute` because it *establishes* authentication rather than
 * requiring it. That makes it the most exposed endpoint in the product, so the
 * order of operations below is deliberate: rate limit, then parse, then verify,
 * then touch the database. Nothing reaches the database until a Firebase
 * signature has been checked.
 */

const sessionRequest = z.object({
  idToken: z.string().min(1).max(8192),
});

export const POST = publicRoute(async ({ request, services }) => {
  // Before the body is read: an unauthenticated caller must not be able to make
  // the Worker buffer and parse a megabyte, nor to spend a Firebase
  // verification, simply by repeating a request.
  await enforce(services.env, 'RL_LOGIN', attemptKey(services.meta.ipAddress, null));

  const { idToken } = await parseJsonBody(request, sessionRequest);

  const identity = await verifyIdentity(idToken, services);

  // A second bucket keyed on the identity. The IP bucket alone is too coarse
  // behind a corporate NAT and useless against a botnet; together, one attacker
  // cannot lock out every user from a shared address, and one account cannot be
  // hammered from many addresses.
  await enforce(services.env, 'RL_LOGIN', attemptKey(services.meta.ipAddress, identity.subject));

  // Email verification is enforced here rather than at the client, where it
  // would be a suggestion. Federated providers (Google) return verified
  // addresses; email/password sign-ups do not until the user acts on the mail.
  // Without this, anyone could sign up as somebody else's address and be added
  // to an organisation by an invitation addressed to it.
  if (!identity.emailVerified) {
    throw errors.forbidden('Verify your email address before signing in.');
  }

  // A soft-deleted account is terminal: the repository refuses to revive the
  // row (`setWhere` in `upsertUserFromIdentity`), and that refusal surfaces
  // here as a plain statement rather than a 500. 403, not 404: this caller has
  // just proven control of the identity, so "this account was deleted" reveals
  // nothing they are not entitled to know.
  const user = await upsertUserFromIdentity(services.db, identity).catch((cause: unknown) => {
    if (cause instanceof RepositoryError && cause.code === 'notFound') {
      throw errors.forbidden('This account was deleted and cannot be signed in to again.');
    }
    throw cause;
  });

  // First login has no organisation yet. Bootstrapping one here — rather than
  // asking the user to create it — is what makes the product usable within a
  // minute of signing up, and it is transactional: an account with an
  // organisation but no master key would be unusable and unrepairable.
  let memberships = await listOrganizationsForUser(services.db, user.id);
  if (memberships.length === 0) {
    const created = await bootstrapPersonalOrganization(services.db, {
      user,
      envelope: services.envelope,
    });
    memberships = await listOrganizationsForUser(services.db, user.id);

    const audit = auditFor(created.organization.id, user, services);
    services.waitUntil(
      writeEvents(services, [
        audit.success('org.created', { type: 'org', id: created.organization.id }),
      ]),
    );
  }

  const { token, session } = await issueSession(services, user.id);
  const csrf = generateCsrfToken();

  const primary = memberships[0];
  if (primary) {
    const audit = auditFor(primary.organization.id, user, services);
    services.waitUntil(
      writeEvents(services, [
        audit.success('auth.login', { type: 'session', id: session.id }, { source: 'dashboard' }),
      ]),
    );
  }

  return json(
    {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
      organizations: memberships.map(toOrganizationSummary),
    },
    {
      cookies: [
        serializeCookie(sessionCookie(token)),
        // Readable by JavaScript on purpose — the client must echo it in a
        // header, which is the whole double-submit mechanism. It carries no
        // authority without the HttpOnly session cookie.
        csrfCookie(csrf, Math.floor(SESSION_LIFETIME_MS / 1000)),
      ],
    },
  );
});

/**
 * Logout.
 *
 * `publicRoute` rather than `authenticatedRoute` so that a user holding an
 * already-expired or already-revoked session can still clear their cookies: a
 * 401 here would leave a stale cookie in the browser and a confusing loop for
 * the person trying to sign out.
 *
 * CSRF is still enforced when a session cookie is present, because a forced
 * logout is a real — if minor — cross-site nuisance. Absent a cookie there is
 * nothing to protect and nothing to revoke, so the request simply succeeds.
 */
export const DELETE = publicRoute(async ({ request, services }) => {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies.get(SESSION_COOKIE_NAME) ?? null;

  if (token !== null) {
    const csrf = verifyCsrf(
      cookies.get(CSRF_COOKIE_NAME) ?? null,
      request.headers.get('x-xecret-csrf'),
    );
    if (!csrf.ok) throw errors.csrf(csrf.reason);

    if (isWellFormedToken(token, 'session')) {
      const session = await findSessionByTokenHash(services.db, await hashToken(token));
      if (session) {
        await revokeSession(services.db, session.id);

        // A session is not org-scoped — one session spans every organisation a
        // user belongs to — but `audit_logs.org_id` is NOT NULL, because a
        // record nobody's audit view can reach is a record nobody will read.
        // The event is therefore attributed to the user's primary organisation.
        // The honest limitation: a member of several organisations produces one
        // logout record rather than one per organisation. Recording it N times
        // would be worse — it would read as N separate acts.
        const memberships = await listOrganizationsForUser(services.db, session.user.id);
        const primary = memberships[0];

        if (primary) {
          const audit = auditFor(primary.organization.id, session.user, services);
          services.waitUntil(
            writeEvents(services, [
              audit.success('auth.logout', { type: 'session', id: session.id }),
            ]),
          );
        }
      }
    }
  }

  // Cleared unconditionally. Whether or not a row was found, the browser must
  // stop presenting these cookies.
  return noContent([serializeCookie(clearedSessionCookie()), csrfCookie('', 0)]);
});

async function verifyIdentity(
  idToken: string,
  services: ServiceContext,
): Promise<VerifiedIdentity> {
  try {
    return await firebaseIdentityProvider(services.env).verify(idToken);
  } catch (cause) {
    if (cause instanceof IdentityVerificationError) {
      // The category is logged; the client is told only that it failed.
      // Distinguishing "expired" from "wrong signature" from "wrong audience"
      // tells an attacker which part of a forged token to fix next.
      services.log
        .at('verifyIdentity')
        .warn(
          `Rejected the Firebase ID token presented at sign-in because it was ${cause.reason}. ` +
            'The caller was told only that authentication failed — naming the reason would tell ' +
            'an attacker which part of a forged token to fix next.',
          { reason: cause.reason },
        );
      throw errors.unauthenticated(`identity ${cause.reason}`);
    }
    throw cause;
  }
}

async function issueSession(services: ServiceContext, userId: string) {
  const { token } = await generateToken('session');

  const session = await createSession(services.db, {
    userId,
    token,
    ipAddress: services.meta.ipAddress,
    userAgent: services.meta.userAgent,
  });

  return { token, session };
}

function auditFor(orgId: string, user: { id: string; email: string }, services: ServiceContext) {
  return createAuditBuilder({
    orgId,
    actorType: 'user',
    actorId: user.id,
    actorLabel: user.email,
    ipAddress: services.meta.ipAddress,
    userAgent: services.meta.userAgent,
    requestId: services.meta.requestId,
  });
}

/**
 * Writes audit events directly rather than through the request recorder.
 *
 * This route resolves its organisation part-way through, so events are produced
 * at several points and can carry different `org_id` values. Writing each as it
 * is produced is clearer than rebinding a recorder mid-request, and these are
 * low-volume paths — one or two rows per login, not one per secret.
 *
 * A failure is logged rather than rethrown: the response has already been
 * decided by the time this runs, and failing a successful login because its
 * audit row could not be written would be the wrong trade. It is logged at
 * `error` so it is alertable.
 */
async function writeEvents(services: ServiceContext, events: AuditRecord[]): Promise<void> {
  try {
    await new DatabaseAuditSink(services.db).write(events);
  } catch (cause) {
    services.log
      .at('writeEvents')
      .error(
        `Failed to write the audit record for ${events[0]?.action ?? 'an event'} — the sign-in ` +
          'itself succeeded, but this event is now missing from the audit log',
        { action: events[0]?.action, error: describeError(cause) },
      );
  }
}

function toOrganizationSummary(membership: OrganizationMembership) {
  return {
    id: membership.organization.id,
    name: membership.organization.name,
    slug: membership.organization.slug,
    role: membership.role,
  };
}
