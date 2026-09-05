import * as z from 'zod/mini';
import { evaluateSession } from '@xecret/core/auth';
import {
  listOrganizationsForUser,
  listUserSessions,
  revokeAllUserSessions,
} from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';

/**
 * Active devices, and "sign out everywhere".
 *
 * This is the control a user reaches for after losing a laptop, so it must work
 * immediately and completely. It is also the reason xecret issues its own
 * sessions rather than trusting Firebase ID tokens, which cannot be revoked
 * before they expire (ADR 0003).
 */

const revokeQuery = z.object({
  /** `current` keeps the calling session alive; anything else signs out all. */
  except: z.optional(z.enum(['current'])),
});

export const GET = authenticatedRoute(async ({ principal, services }) => {
  if (principal.kind !== 'user') {
    throw errors.forbidden('Only a signed-in user has a device list.');
  }

  const now = new Date();
  const sessions = await listUserSessions(services.db, principal.user.id);

  return json({
    sessions: sessions
      // The idle rule is not expressible as a cheap indexed filter, so rows that
      // are technically present but no longer usable are dropped here — using
      // the same `evaluateSession` that authentication uses, so the list cannot
      // show a device as signed in that would be rejected on its next request.
      .filter((session) => evaluateSession(session, now).ok)
      .map((session) => ({
        id: session.id,
        current: session.id === principal.sessionId,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
      })),
  });
});

export const DELETE = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    if (principal.kind !== 'user') {
      throw errors.forbidden('Only a signed-in user can revoke sessions.');
    }

    const { except } = parseQuery(request, revokeQuery);

    const revoked = await revokeAllUserSessions(services.db, principal.user.id, {
      ...(except === 'current' ? { exceptSessionId: principal.sessionId } : {}),
    });

    // Attributed to the primary organisation because `audit_logs.org_id` is NOT
    // NULL while a session is not org-scoped. The count is returned to the caller
    // but not recorded: `AuditMetadata` has no field for it, and widening that
    // allowlist to carry a number is not worth weakening the type whose narrowness
    // is what keeps secret values out of audit records.
    const memberships = await listOrganizationsForUser(services.db, principal.user.id);
    const primary = memberships[0];

    if (primary) {
      record(
        audit(primary.organization.id).success(
          'auth.session_revoked',
          { type: 'session', id: null },
          { reason: except === 'current' ? 'other-devices' : 'all-devices' },
        ),
      );
    }

    return json({ revoked });
  },
);
