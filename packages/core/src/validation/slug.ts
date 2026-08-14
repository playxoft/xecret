import { z } from 'zod';

/**
 * Slugs identify organisations, projects and environments in URLs and in the
 * CLI (`xecret run --env production`). They must be machine-friendly and stable.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SLUG_MAX_LENGTH = 63;

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

/** Converts a display name into a slug. Returns '' when nothing usable remains. */
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

export const slugSchema = z
  .string()
  .min(1, 'Slug cannot be empty.')
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens.')
  .refine((slug) => !isReservedSlug(slug), { message: 'This name is reserved.' });

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
