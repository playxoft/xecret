import { z } from 'zod';
import { checkSlug, ORGANIZATION_SLUG_MAX_LENGTH } from '@xecret/core/validation';
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
 *  - **It answers a signed-in browser session and nothing else**, and is
 *    rate-limited on a bucket of its own. That is what makes it a form that
 *    works rather than a namespace scraper. It is the rule `POST /api/orgs` and
 *    `DELETE /api/orgs/{slug}` state, held for the same reason — a CLI token
 *    acts as its user for secrets, not for existence — and this is a question
 *    about existence, asked of a namespace every tenant shares. The endpoint
 *    refused only service tokens until a review pointed out the obvious gap: a
 *    CLI token leaked from a build machine is authenticated too, and could walk
 *    the whole namespace one debounce at a time.
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
  // The gate the header argues for, enforced rather than described. A create
  // form only ever exists in a browser; a token asking this question is asking
  // what else is out there.
  if (principal.kind !== 'user') {
    throw errors.forbidden('Checking an organisation slug requires a signed-in browser session.');
  }

  // Before the query, as everywhere: the limit exists to bound how much work an
  // authenticated caller can make the database do by holding down a key.
  await enforce(services.env, 'RL_SLUG_CHECK', rateLimitKey([principal.user.id]));

  const { slug } = parseQuery(request, availabilityQuery);
  // ── The question is answered about the normalised slug, not the raw one ──
  // The query schema trims and this lowercases, because somebody who types
  // "ACME " is asking about `acme` and reporting their slug as invalid would be
  // answering a question they did not ask. `POST /api/orgs` does no such thing:
  // `organizationSlugSchema` refuses both, since `SLUG_PATTERN` is lowercase and
  // a slug is permanent enough that the server has no business quietly editing
  // one. The two therefore agree about the value in `slug` below and not about
  // the caller's raw text, which is why the response echoes what was checked
  // rather than what was asked. Clients must submit that value — the create
  // form does, via `normalizeSlugInput`.
  const normalized = slug.toLowerCase();

  const reason = await unavailableBecause(normalized, services.db);

  return json({
    slug: normalized,
    available: reason === null,
    // A machine-readable cause rather than a sentence, so the form can word it
    // in its own voice and in whatever language it is rendering.
    ...(reason === null ? {} : { reason }),
  });
});

async function unavailableBecause(
  slug: string,
  db: Parameters<typeof isOrgSlugAvailable>[0],
): Promise<Unavailable | null> {
  // Shape first, so a slug that could never be valid costs no query. Answered by
  // the same function `organizationSlugSchema` is built from, so this endpoint
  // cannot say "available" about a slug `POST /api/orgs` would then reject for
  // its shape — which is exactly what it did while it kept its own copy of the
  // rules. The claim holds for the value this endpoint reports and no further:
  // it is asked about `slug`, already normalised by the caller above, and
  // `POST` is stricter about everything that normalisation removed.
  //
  // Every problem but `reserved` collapses to `invalid`: the form already knows
  // the shape rules and words them itself, and the distinction that matters to a
  // caller is "fix your slug" versus "this one is spoken for".
  const check = checkSlug(slug, ORGANIZATION_SLUG_MAX_LENGTH);
  if (!check.valid) return check.problem === 'reserved' ? 'reserved' : 'invalid';

  if (!(await isOrgSlugAvailable(db, slug))) return 'taken';
  return null;
}
