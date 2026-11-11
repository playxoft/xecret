import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditBuilder } from '@xecret/core/audit';
import type { Principal } from './actor';
import type { Bindings } from './bindings';
import type { ServiceContext } from './context';
import { errors } from './errors';

/**
 * Who may use the admin page (`/app/admin`, `/api/admin/*`): xecret's own
 * staff, by the address they sign in with.
 *
 * ── Why this is a route at all ──
 * `plan:set` was, on purpose, a script and never an endpoint: "a route that
 * grants paid plans is a route that will eventually be reachable by someone
 * who should not reach it". The owner chose to have one anyway (2026-11-11),
 * so the argument becomes the design brief instead of the reason not to — the
 * route must be unreachable by construction for everybody else:
 *
 *  1. **One allow-list, read on every request**, from `XECRET_ADMIN_EMAILS`
 *     (Phase.dev → Worker secret). Nothing is stored: removing an address
 *     revokes on the next request, and there is no admin flag on a user row
 *     that a bug, a migration or an SQL injection could set.
 *  2. **A browser session only** — never a CLI or service token. A token is a
 *     long-lived credential on a disk somewhere; the admin page is not
 *     something a script should ever be able to drive.
 *  3. **A verified address**, matched exactly (case-insensitively, as the
 *     column is `citext`). An address nobody proved they own is not an
 *     identity anything here should trust.
 *  4. **The vault unlocked** — `authenticatedRoute` asks it of every route that
 *     does not opt out, and none of these does. So a stolen session cookie is
 *     not enough on its own: the admin's passphrase is too.
 *  5. **404, not 403**, to everybody else — the same answer an unknown path
 *     gets, so the admin API's existence is not confirmed to anyone probing it.
 *
 * And every change an admin makes lands in the affected organisation's own
 * audit log, attributed to "xecret support" — so the customer can see that it
 * happened, when, and why. Which admin it was goes on the server's own log
 * line (their user id), not into a log every member of that organisation can
 * read: an admin's personal address is not the customer's to see.
 */

/** What `XECRET_ADMIN_EMAILS` says, as lower-cased addresses. Empty when unset or unreadable. */
export function adminEmails(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) return new Set();
  const text = raw.trim();
  if (text === '') return new Set();

  let entries: unknown[];
  // Anything that opens like JSON is read as JSON — an object or a quoted
  // string included, which then fails closed below rather than being split
  // into fragments that might happen to look like an address.
  if (/^[[{"]/.test(text)) {
    try {
      const parsed: unknown = JSON.parse(text);
      // A JSON value that is not an array of strings is a mistake, and a
      // mistake in an allow-list fails closed: nobody, rather than a guess.
      if (!Array.isArray(parsed)) return new Set();
      entries = parsed;
    } catch {
      return new Set();
    }
  } else {
    entries = text.split(/[\s,;]+/);
  }

  const addresses = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const address = entry.trim().toLowerCase();
    // Shaped like an address, or ignored: a stray "*" or "@" must never match,
    // and nor may a fragment of mis-pasted JSON.
    if (/^[^\s@"{}[\],;:]+@[^\s@"{}[\],;:]+\.[^\s@"{}[\],;:]+$/.test(address)) {
      addresses.add(address);
    }
  }
  return addresses;
}

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

/** Whether this caller is one of xecret's admins. A convenience for `/api/auth/me` too. */
export function isAdmin(env: Bindings, principal: Principal): principal is UserPrincipal {
  if (principal.kind !== 'user') return false;
  if (!principal.user.emailVerified) return false;
  return adminEmails(env.XECRET_ADMIN_EMAILS).has(principal.user.email.toLowerCase());
}

/**
 * The gate every admin route opens with. Anybody else gets the 404 an unknown
 * path gets, and a warning line — a refused admin request from a signed-in
 * user is worth seeing, because the only people who make one are a
 * mis-configured admin or somebody looking for the door.
 */
export function requireAdmin(services: ServiceContext, principal: Principal): UserPrincipal {
  if (isAdmin(services.env, principal)) return principal;
  services.log
    .at('requireAdmin')
    .warn('Refused an admin request from a caller who is not on the admin allow-list', {
      credentialKind: principal.kind,
    });
  throw errors.notFound('not an admin');
}

/** What every admin change is attributed to in the customer's audit log. */
export const ADMIN_ACTOR_LABEL = 'xecret support';

/**
 * The audit builder for an admin's change to one organisation: `system`, as
 * `plan:set`'s are — the admin is not a member and acts as xecret, not as a
 * user of that organisation — with the request's own address, agent and id.
 * The caller sets `operator` to {@link ADMIN_ACTOR_LABEL}, which is what marks
 * the change as made by hand rather than by a webhook.
 */
export function adminAudit(services: ServiceContext, orgId: string): AuditBuilder {
  return createAuditBuilder({
    orgId,
    actorType: 'system',
    actorId: null,
    actorLabel: ADMIN_ACTOR_LABEL,
    ipAddress: services.meta.ipAddress,
    userAgent: services.meta.userAgent,
    requestId: services.meta.requestId,
  });
}
