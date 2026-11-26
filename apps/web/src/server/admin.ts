import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditBuilder } from '@xecret/core/audit';
import { isPlatformAdmin } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';

/**
 * Who may use the admin page (`/app/admin`, `/api/admin/*`): xecret's own
 * staff — the accounts listed in `platform_admins` (migration 0035).
 *
 * ── Why this is a route at all ──
 * `plan:set` was, on purpose, a script and never an endpoint: "a route that
 * grants paid plans is a route that will eventually be reachable by someone
 * who should not reach it". The owner chose to have one anyway (2026-11-11),
 * so the argument becomes the design brief instead of the reason not to — the
 * route must be unreachable for everybody else:
 *
 *  1. **An admin is an account in `platform_admins`**, read on every request.
 *     Admins add and remove each other from the page (never the last one), and
 *     an operator makes the first with `npm run admin`. Removing one revokes on
 *     their next request, and every change is recorded in
 *     `platform_admin_changes` and emailed to every admin, so an admin added
 *     behind the others' backs does not go unnoticed. The cost of keeping the
 *     list in the database, stated plainly: whoever can write that table can
 *     make an admin — which is also whoever can already write any plan.
 *  2. **A browser session only** — never a CLI or service token. A token is a
 *     long-lived credential on a disk somewhere; the admin page is not
 *     something a script should ever be able to drive.
 *  3. **A verified address** on that account. One nobody proved they own is
 *     not an identity anything here should trust.
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
 * not printable ASCII. A promo code's allowed addresses are compared through
 * it: a Unicode fold would let `Kelly@` (a Kelvin sign) stand in for `kelly@`,
 * the trap `isSameAddress` in `users.ts` already refuses for accounts.
 */
export function asciiAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[!-~]+$/.test(trimmed)) return null;
  return trimmed.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

/** Whether this caller is one of xecret's admins. A convenience for `/api/auth/me` too. */
export async function isAdmin(
  services: Pick<ServiceContext, 'db'>,
  principal: Principal,
): Promise<boolean> {
  if (principal.kind !== 'user') return false;
  if (!principal.user.emailVerified) return false;
  return isPlatformAdmin(services.db, principal.user.id);
}

/**
 * The gate every admin route opens with. Anybody else gets a 404, and a
 * warning line — a refused admin request from a signed-in user is worth
 * seeing, because the only people who make one are an admin who was just
 * removed, or somebody looking for the door.
 */
export async function requireAdmin(
  services: ServiceContext,
  principal: Principal,
): Promise<UserPrincipal> {
  if (principal.kind === 'user' && (await isAdmin(services, principal))) return principal;
  services.log
    .at('requireAdmin')
    .warn('Refused an admin request from a caller who is not an admin', {
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
