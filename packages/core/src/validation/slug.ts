import * as z from 'zod/mini';

import { isUuid } from '../ids';

/**
 * Slugs identify projects and environments in the CLI and in CI
 * (`xecret pull --project payments-api --env production`). They must be
 * machine-friendly and stable. A project's slug is shown to people as its
 * "Project ID": chosen when the project is created, and never changed after.
 *
 * A project's dashboard address names it by id rather than by slug, and its API
 * routes take either; see `checkSlug` for the one rule that keeps the two from
 * ever being confused.
 *
 * An organisation still has a slug, but it is nobody's identifier any more:
 * the server derives it from the organisation's id when the organisation is
 * created, nothing shows it to a person, and every address names the
 * organisation by its id. The slug is only read when an older client sends it.
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
 * Every slug chosen while people still chose them is within it, and so is the
 * one the server now derives: an organisation's id written in base 36, which
 * for a 128-bit id is at most exactly this many digits. Shorter than a UUID as
 * well, so no organisation slug can ever be read as an id. `slug.test.ts` pins
 * both.
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
  // Once the endpoint that said whether an organisation slug was free, in the
  // slot an organisation takes under `/api/orgs/`. Kept reserved now that it is
  // gone, so no project can take the name either.
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
 * More than one caller asks the same question and each needs something
 * different back: a create form renders a line of prose under the field, and
 * `slugSchema` turns it into a zod issue. Each used to derive the rules from
 * `SLUG_PATTERN` and `isReservedSlug` itself, so adding a rule to one of them
 * left a form answering yes for a slug the API was about to refuse, with nothing
 * failing anywhere to say so.
 */
export type SlugProblem =
  | 'empty'
  | 'tooLong'
  | 'leadingHyphen'
  | 'trailingHyphen'
  | 'doubleHyphen'
  | 'invalidCharacters'
  | 'uuidShaped'
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
 * What a slug may *look like*. The one definition of it.
 *
 * Structure only: length, characters, hyphen placement. Whether the name is one
 * this installation still hands out is `checkSlug`'s question, and the two are
 * separate because a slug that already exists has to keep working after the
 * reserved list grows.
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
export function checkSlugShape(slug: string, maxLength: number): SlugCheck {
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
      message: 'Use single hyphens. Two in a row is not allowed.',
    };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      valid: false,
      problem: 'invalidCharacters',
      message: 'Use lowercase letters, digits and single hyphens, with no spaces.',
    };
  }
  return { valid: true };
}

/**
 * The structural rules *and* the reserved list: what a slug about to be
 * **claimed** must satisfy.
 *
 * ── Why the reserved check is separable at all ──
 * The two halves answer different questions. The shape rules say whether a
 * string can be a slug; the reserved list says whether this installation is
 * willing to hand that particular one out. Only the first is true of a slug
 * *forever* — the second is a policy about new names, and a row that already
 * holds one of them is not retroactively invalid.
 *
 * Conflating them broke `xecret login`: `POST /api/cli/authorize` validated the
 * organisation the user picked from their own switcher with this schema, so an
 * organisation whose slug was on the list could never be approved for the CLI,
 * with a 400 that named no field. A slug being *referenced* has already been
 * claimed — the reserved list has nothing left to decide. See
 * `checkSlugShape` and `slugReferenceSchema`.
 *
 * ── Why a slug may not be shaped like a UUID ──
 * A project is addressed by its id or by its slug in the same path segment —
 * `/app/{org}/{projectId}/…` in the dashboard, and either one under
 * `/api/orgs/{org}/projects/` — and `resolveProject` tells them apart by shape
 * alone: a canonical UUID is read as an id, anything else as a slug. That is
 * only unambiguous while no slug can take the shape, which is what this rule
 * keeps true. It costs nothing anybody would choose (36 characters of hex in
 * the 8-4-4-4-12 pattern), and it is the only thing standing between a project
 * slugged after another project's id and a URL that opens the wrong one.
 *
 * A claim rule beside the reserved list rather than a shape rule, for the
 * reason that list is one: nothing refused such a slug before this, so a
 * reference to a row already holding one is still shaped like a slug, and the
 * lookups that only ever take a slug — a grant's project, the audit filter —
 * still find it. A project address reads that shape as an id, though, so
 * `scripts/check-uuid-shaped-slugs.ts` reports whether any such row exists.
 */
export function checkSlug(slug: string, maxLength: number): SlugCheck {
  const shape = checkSlugShape(slug, maxLength);
  if (!shape.valid) return shape;

  if (isUuid(slug)) {
    return {
      valid: false,
      problem: 'uuidShaped',
      message: 'A slug cannot be shaped like a UUID: that shape is how an id is written.',
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
function schemaFrom(check: (slug: string) => SlugCheck) {
  return z.string().check(
    z.superRefine((slug, ctx) => {
      const result = check(slug);
      if (result.valid) return;
      ctx.addIssue({ code: 'custom', message: result.message });
    }),
  );
}

function slugSchemaWithin(maxLength: number) {
  return schemaFrom((slug) => checkSlug(slug, maxLength));
}

export const slugSchema = slugSchemaWithin(SLUG_MAX_LENGTH);

/**
 * The schema for a slug that **names something that already exists** — the
 * `orgSlug` in a request body, the `projectSlug` a token is scoped to.
 *
 * Shape only, deliberately. A reference is checked to bound what reaches a
 * query, not to re-litigate whether the name should have been granted: that was
 * settled when the row was created, and the reserved list has since changed at
 * least once. Applying it here turns "this name is no longer available" into
 * "this organisation cannot be used", which is a different and much worse
 * sentence — and one the caller cannot act on, since a slug is immutable.
 *
 * The general ceiling rather than the organisation's tighter one, for the same
 * reason: `ORGANIZATION_SLUG_MAX_LENGTH` bounds what may be created, and a row
 * predating it must still be addressable.
 */
export const slugReferenceSchema = schemaFrom((slug) => checkSlugShape(slug, SLUG_MAX_LENGTH));

/**
 * The same rules at the organisation's shorter ceiling.
 *
 * Nothing accepts an organisation slug from a client any more: the server
 * derives one from the id. Kept so that the derivation can be checked against
 * the rules every slug has always had to meet.
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
  .check(
    z.minLength(1),
    z.maxLength(SLUG_MAX_LENGTH),
    z.regex(ENVIRONMENT_SLUG_PATTERN, 'Use lowercase letters, digits, hyphens or underscores.'),
  );

/** Suggested when a project is created. Users may add, rename, or remove any of them. */
export const DEFAULT_ENVIRONMENTS = [
  { name: 'Development', slug: 'development', isProduction: false, sortOrder: 0 },
  { name: 'Staging', slug: 'staging', isProduction: false, sortOrder: 1 },
  { name: 'Production', slug: 'production', isProduction: true, sortOrder: 2 },
] as const;
