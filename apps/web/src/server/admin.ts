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
 *  3. **A verified address**, matched exactly: printable ASCII, folded to
 *     lower case in ASCII only (`asciiAddress`) — a Unicode fold would let
 *     `Kelly@` (a Kelvin sign) stand in for `kelly@`, the trap
 *     `isSameAddress` in `users.ts` already refuses. An address nobody proved
 *     they own is not an identity anything here should trust.
 *  4. **The vault unlocked** — `authenticatedRoute` asks it of every route that
 *     does not opt out, and none of these does. So a stolen session cookie is
 *     not enough on its own: the admin's passphrase is too.
 *  5. **404, not 403**, to a signed-in caller who is not an admin — the answer
 *     for anything they cannot see, which says nothing about who the admins
 *     are. The routes themselves are no secret (the repository is public), and
 *     a caller who is not signed in gets the 401 every route gives; what
 *     matters is that nobody but an admin gets anything from them.
 *
 * And every change an admin makes lands in the affected organisation's own
 * audit log, attributed to "xecret support" — so the customer can see that it
 * happened, when, and why. Which admin it was goes on the server's own log
 * line (their user id), not into a log every member of that organisation can
 * read: an admin's personal address is not the customer's to see.
 */

/**
 * An address folded to lower case in ASCII only — or `null` for one that is
 * not printable ASCII, which no allow-list here can name. The admin allow-list
 * and a promo code's allowed addresses are both compared through it.
 */
export function asciiAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[!-~]+$/.test(trimmed)) return null;
  return trimmed.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

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
    // Printable ASCII, folded in ASCII only (`asciiAddress`) — and shaped like
    // an address, or ignored: a stray "*" or "@" must never match, and nor may
    // a fragment of mis-pasted JSON.
    const address = asciiAddress(entry);
    if (address !== null && /^[^@"{}[\],;:]+@[^@"{}[\],;:]+\.[^@"{}[\],;:]+$/.test(address)) {
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
  const address = asciiAddress(principal.user.email);
  return address !== null && adminEmails(env.XECRET_ADMIN_EMAILS).has(address);
}

/**
 * The gate every admin route opens with. Anybody else gets a 404, and a
 * warning line — a refused admin request from a signed-in
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
 * user of that organisation. The caller sets `operator` to
 * {@link ADMIN_ACTOR_LABEL}, which is what marks the change as made by hand
 * rather than by a webhook.
 *
 * **No IP address and no user agent.** Every owner and admin of the
 * organisation reads this row, and the request's address is the staff
 * member's home or office — as much theirs to keep as their email. Both stay
 * on the server's own request log line, beside the admin's user id. The
 * request id stays here: it is what connects the two.
 */
export function adminAudit(services: ServiceContext, orgId: string): AuditBuilder {
  return createAuditBuilder({
    orgId,
    actorType: 'system',
    actorId: null,
    actorLabel: ADMIN_ACTOR_LABEL,
    ipAddress: null,
    userAgent: null,
    requestId: services.meta.requestId,
  });
}
