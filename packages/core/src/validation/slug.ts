import { z } from 'zod';

/**
 * Slugs identify organisations, projects and environments in URLs and in the
 * CLI (`xecret run --env production`). They must be machine-friendly and stable.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 63 is the DNS label limit, and that is not a coincidence: it keeps
 * `acme.xecret.playxoft.com` available as a future routing choice without a
 * migration that some tenants could not complete. Do not raise it — a slug
 * longer than a DNS label is a tenant who could never be given a subdomain,
 * and that is a decision made permanent by the first row that uses it.
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

/**
 * Why a slug cannot be used, as a category rather than a sentence.
 *
 * Three callers ask the same question and need three different things back: the
 * create form renders a line of prose under the field,
 * `GET /api/orgs/availability` reports a machine-readable `reason`, and
 * `slugSchema` turns it into a zod issue. Each used to derive the rules from
 * `SLUG_PATTERN` and `isReservedSlug` itself, so adding a rule to one of them
 * left the availability endpoint answering `available: true` for a slug
 * `POST /api/orgs` was about to refuse — a form that says yes and an API that
 * says no, with nothing failing anywhere to say so.
 */
export type SlugProblem =
  | 'empty'
  | 'tooLong'
  | 'leadingHyphen'
  | 'trailingHyphen'
  | 'doubleHyphen'
  | 'invalidCharacters'
  | 'reserved';

/**
 * A union rather than optional fields, so `valid` narrows: a caller that has
 * checked it gets a `message` typed `string`, and one that has not cannot reach
 * for it at all.
 */
export type SlugCheck =
  | { valid: true }
  /** `message` is safe to show a user directly — it never echoes the input. */
  | { valid: false; problem: SlugProblem; message: string };

/**
 * What a valid slug is. The one definition of it.
 *
 * ── Why each hyphen rule is its own problem ──
 * `normalizeSlugInput` deliberately lets a trailing hyphen be typed, because
 * stripping it is what made `acme-corp` untypable. The consequence is that
 * "invalid" is a normal, transient state a user passes through on the way to a
 * valid slug — so the answer has to say precisely which rule is unmet. "Use
 * lowercase letters, digits and single hyphens" is useless to somebody who has
 * just typed a hyphen and can see that they did. The three hyphen clauses are
 * therefore checked before `SLUG_PATTERN`, which would otherwise swallow all
 * three into one unhelpful category.
 *
 * @param maxLength The ceiling to apply — `ORGANIZATION_SLUG_MAX_LENGTH` for an
 *   organisation, the general `SLUG_MAX_LENGTH` for everything else. Required,
 *   and deliberately not defaulted to either: the two differ by 38 characters,
 *   and the wider one was the default. A caller who forgot the argument
 *   therefore got a *looser* rule than the one it meant to apply, silently —
 *   which for the organisation form is a slug the create endpoint refuses, and
 *   is the same class of mistake as an availability check that disagrees with
 *   the schema. Failing to compile is the only version of this that cannot ship.
 */
export function checkSlug(slug: string, maxLength: number): SlugCheck {
  if (slug.length === 0) {
    return { valid: false, problem: 'empty', message: 'A slug cannot be empty.' };
  }
  if (slug.length > maxLength) {
    return {
      valid: false,
      problem: 'tooLong',
      message: `A slug can be at most ${maxLength} characters.`,
    };
  }
  // Ordered so the transient case a user is most likely to be in — mid-word,
  // hyphen just pressed — is the one they are told about.
  if (slug.endsWith('-')) {
    return {
      valid: false,
      problem: 'trailingHyphen',
      message: 'A slug cannot end with a hyphen. Add a letter or digit after it.',
    };
  }
  if (slug.startsWith('-')) {
    return {
      valid: false,
      problem: 'leadingHyphen',
      message: 'A slug cannot start with a hyphen.',
    };
  }
  if (slug.includes('--')) {
    return {
      valid: false,
      problem: 'doubleHyphen',
      message: 'Use single hyphens — two in a row is not allowed.',
    };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      valid: false,
      problem: 'invalidCharacters',
      message: 'Use lowercase letters, digits and single hyphens — no spaces.',
    };
  }
  if (isReservedSlug(slug)) {
    return {
      valid: false,
      problem: 'reserved',
      message: 'That slug is reserved. Choose a different one.',
    };
  }

  return { valid: true };
}

/**
 * `checkSlug` wearing a zod schema's clothes.
 *
 * `superRefine` over the chain of `.min`/`.max`/`.regex`/`.refine` this used to
 * be, because that chain *was* the second copy of the rules: it agreed with
 * `checkSlug` only for as long as somebody kept editing both. A schema whose
 * only job is to delegate cannot drift.
 */
function slugSchemaWithin(maxLength: number) {
  return z.string().superRefine((slug, ctx) => {
    const check = checkSlug(slug, maxLength);
    if (check.valid) return;
    ctx.addIssue({ code: 'custom', message: check.message });
  });
}

export const slugSchema = slugSchemaWithin(SLUG_MAX_LENGTH);

/**
 * The same rules at the organisation's shorter ceiling.
 *
 * An organisation slug is the first segment of every URL in the product and the
 * one identifier shared across the whole installation, so it is the one worth
 * keeping short enough to read at a glance and type without checking.
 */
export const organizationSlugSchema = slugSchemaWithin(ORGANIZATION_SLUG_MAX_LENGTH);

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
