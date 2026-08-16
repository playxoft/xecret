import { z } from 'zod';

/**
 * Slugs identify organisations, projects and environments in URLs and in the
 * CLI (`xecret run --env production`). They must be machine-friendly and stable.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 63 is the DNS label limit, and that is not a coincidence: it keeps
 * `acme.xecret.dev` available as a future routing choice without a migration
 * that some tenants could not complete. Do not raise it.
 */
export const SLUG_MAX_LENGTH = 63;

/**
 * How long an organisation slug may be.
 *
 * Much tighter than the general ceiling, and pinned to
 * `ORGANIZATION_NAME_MAX_LENGTH` rather than chosen independently. The create
 * form derives the slug from the name, and `slugify` maps each run of separators
 * to a single hyphen — so a derived slug is never longer than the name it came
 * from. Setting this *below* the name limit would therefore produce a form that
 * generates a slug and then rejects it, with an error about a field the user
 * never touched.
 *
 * `slug.test.ts` pins that relationship, so raising the name limit without
 * raising this one fails a test rather than shipping the broken form.
 */
export const ORGANIZATION_SLUG_MAX_LENGTH = 25;

/**
 * Reserved because they would collide with application routes or read as
 * something the organisation does not control.
 */
const RESERVED_SLUGS = new Set([
  'api',
  'app',
  'admin',
  'auth',
  'login',
  'logout',
  'signup',
  'settings',
  // These sit in the same URL slot a project slug does — `/app/{org}/members`,
  // `/app/{org}/tokens`, `/app/{org}/audit` — so a project with one of these
  // slugs would shadow the organisation page and be unreachable itself.
  // `parseDashboardPath` relies on them being reserved to read the segment
  // without ambiguity.
  'members',
  'tokens',
  'audit',
  // `GET /api/orgs/availability` sits in the slot `{orgSlug}` occupies, so an
  // organisation claiming this slug would shadow the endpoint the create form
  // uses to find out whether a slug is free — and would be unreachable itself.
  'availability',
  // The invitation-acceptance page lives at `/invite/{token}`, beside `/app`.
  // Reserved so no future top-level route and no organisation slug can collide
  // with a URL that is mailed to people and must keep working.
  'invite',
  'dashboard',
  'docs',
  'help',
  'support',
  'status',
  'blog',
  'about',
  'pricing',
  'security',
  'privacy',
  'terms',
  'cli',
  'download',
  'new',
  'xecret',
  'playxoft',
  'www',
  'static',
  'assets',
  'public',
  'internal',
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

/**
 * Converts a *finished* display name into a slug. Returns '' when nothing
 * usable remains.
 *
 * For deriving a slug from a value the user is not editing — a project name, an
 * organisation name. It deletes: leading and trailing hyphens go, and runs
 * collapse. That is correct for a name that is complete, and wrong for one still
 * being typed — see `normalizeSlugInput`, which is what a slug *field* must use.
 */
export function slugify(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      // Strip combining marks so "Café" becomes "cafe" rather than "caf".
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX_LENGTH)
      .replace(/-+$/, '')
  );
}

/**
 * Maps text toward a slug as somebody types it, without deleting anything.
 *
 * ── Why `slugify` cannot be used on a live input ──
 * It strips trailing hyphens, which makes `acme-corp` literally untypable: press
 * `-` after `acme` and it is removed before the character is ever rendered, so
 * the key appears to do nothing. A hyphen can then only be produced by moving
 * the caret left and typing it between two letters. That is the bug this
 * function exists to remove.
 *
 * Two rules, both about staying out of the user's way:
 *
 *  1. **Nothing is removed.** An invalid character is *substituted*, never
 *     deleted, and a structurally invalid slug — a trailing hyphen, a doubled
 *     hyphen — is left on screen and explained underneath. A field that
 *     silently erases keystrokes is one nobody can learn the rules of.
 *  2. **Substitutions are one-for-one**, so the length does not change and the
 *     caret stays where it was put. A transformation that shortens the value
 *     sends the caret to the end of a controlled input on the next render, which
 *     makes editing the middle of a slug impossible. Accent folding is the one
 *     exception, and is worth it: without it "Café" becomes `caf-`.
 *
 * The result may be an invalid slug. That is the point — `SLUG_PATTERN` still
 * decides, the form says what is wrong, and submission stays blocked until it is
 * fixed.
 */
export function normalizeSlugInput(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      // Deliberately not `+`: collapsing a run would shorten the value and move
      // the caret. Two typed spaces become `--`, which is reported rather than
      // quietly repaired.
      .replace(/[^a-z0-9-]/g, '-')
  );
}

export const slugSchema = z
  .string()
  .min(1, 'Slug cannot be empty.')
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens.')
  .refine((slug) => !isReservedSlug(slug), { message: 'This name is reserved.' });

/**
 * The same rules at the organisation's shorter ceiling.
 *
 * An organisation slug is the first segment of every URL in the product and the
 * one identifier shared across the whole installation, so it is the one worth
 * keeping short enough to read at a glance and type without checking.
 */
export const organizationSlugSchema = slugSchema.max(
  ORGANIZATION_SLUG_MAX_LENGTH,
  `An organisation slug can be at most ${ORGANIZATION_SLUG_MAX_LENGTH} characters.`,
);

/**
 * Environment slugs are additionally constrained: no hyphens, because they
 * appear in shell contexts and in `.xecret.yaml`, where `development` reads
 * cleanly and `dev-eu-west-1` invites quoting mistakes.
 */
export const ENVIRONMENT_SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const environmentSlugSchema = z
  .string()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(ENVIRONMENT_SLUG_PATTERN, 'Use lowercase letters, digits, hyphens or underscores.');

/** Suggested when a project is created. Users may add, rename, or remove any of them. */
export const DEFAULT_ENVIRONMENTS = [
  { name: 'Development', slug: 'development', isProduction: false, sortOrder: 0 },
  { name: 'Staging', slug: 'staging', isProduction: false, sortOrder: 1 },
  { name: 'Production', slug: 'production', isProduction: true, sortOrder: 2 },
] as const;
