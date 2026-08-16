import { z } from 'zod';
import {
  isReservedSlug,
  ORGANIZATION_SLUG_MAX_LENGTH,
  SLUG_PATTERN,
} from '@xecret/core/validation';
import { isOrgSlugAvailable } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseQuery } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';

/**
 * `GET /api/orgs/availability?slug=…` — is this organisation slug free?
 *
 * The create form asks this while somebody types, so that a permanent
 * identifier is a thing they chose and saw confirmed rather than a thing the
 * server picked and told them about afterwards.
 *
 * ── What this deliberately does not do ──
 * It does not reserve anything. The answer is a snapshot; the slug can be taken
 * a millisecond later, and the unique index on `organizations.slug` is the only
 * thing that can actually settle the race. `POST /api/orgs` therefore still
 * answers 409 on a collision, and the form still handles it. Treating this
 * endpoint as authoritative would be the classic check-then-act bug.
 *
 * ── The existence question ──
 * Everything else in this API is careful never to reveal whether a resource
 * exists: `resolveOrg` answers `not_found` both for a slug that is absent and
 * for one the caller is not a member of, because the alternative is a directory
 * of other tenants. This endpoint appears to break that rule, so it is worth
 * saying exactly why it does not:
 *
 *  - **Organisation slugs are a global namespace.** The information "`acme` is
 *    taken" is inherent to that choice — it leaks through creation itself, since
 *    a caller who asks for `acme` and is refused has learned the same fact. The
 *    endpoint makes an existing signal legible; it does not create one.
 *  - **The answer is one bit.** Never who owns it, when it was made, how large
 *    it is, or whether the caller could join it. `taken` is all a stranger
 *    learns, which is what every product with a global namespace — GitHub,
 *    Slack, Vercel — already tells anyone who visits a sign-up form.
 *  - **It is authenticated and rate-limited** on a bucket of its own, so it is
 *    not an anonymous, unbounded enumeration tool. That is the difference
 *    between "a form that works" and "a namespace scraper".
 *
 * Project and environment slugs get no equivalent endpoint and must not: those
 * are scoped to an organisation, so answering the same question about them would
 * genuinely disclose another tenant's contents.
 */

const availabilityQuery = z.object({
  slug: z.string().trim().min(1, 'Provide a slug to check.').max(ORGANIZATION_SLUG_MAX_LENGTH),
});

/** Why a slug cannot be used. `null` when it can. */
type Unavailable = 'invalid' | 'reserved' | 'taken';

export const GET = authenticatedRoute(async ({ request, principal, services }) => {
  // A service token has no create form and no business enumerating a namespace.
  if (principal.kind === 'serviceToken') {
    throw errors.forbidden('Service tokens cannot check organisation slugs.');
  }

  const userId = principal.kind === 'user' ? principal.user.id : principal.userId;

  // Before the query, as everywhere: the limit exists to bound how much work an
  // authenticated caller can make the database do by holding down a key.
  await enforce(services.env, 'RL_SLUG_CHECK', rateLimitKey([userId]));

  const { slug } = parseQuery(request, availabilityQuery);
  const normalized = slug.toLowerCase();

  const reason = await checkSlug(normalized, services.db);

  return json({
    slug: normalized,
    available: reason === null,
    // A machine-readable cause rather than a sentence, so the form can word it
    // in its own voice and in whatever language it is rendering.
    ...(reason === null ? {} : { reason }),
  });
});

async function checkSlug(
  slug: string,
  db: Parameters<typeof isOrgSlugAvailable>[0],
): Promise<Unavailable | null> {
  // Shape first, so a slug that could never be valid costs no query. This
  // reproduces `slugSchema`'s clauses rather than parsing with it, because the
  // caller needs a category to render, not a zod issue list.
  if (!SLUG_PATTERN.test(slug)) return 'invalid';
  if (isReservedSlug(slug)) return 'reserved';
  if (!(await isOrgSlugAvailable(db, slug))) return 'taken';
  return null;
}
