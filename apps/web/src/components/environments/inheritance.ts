import { MAX_INHERITANCE_DEPTH } from '@xecret/core/references';
import type { Environment } from '@/components/projects/types';

/**
 * Which environment another may inherit from (P19 §1), worked out from the
 * project's own listing.
 *
 * ── Why the dashboard pre-filters at all ──
 * The server is the authority: `PUT …/parent` takes a lock on the project's
 * environment rows and refuses a loop, a chain past {@link MAX_INHERITANCE_DEPTH}
 * parents, a parent outside the project or one that is not end-to-end
 * encrypted. Every one of those refusals still reaches the person, in the
 * server's words, because a listing can be a moment out of date.
 *
 * What the pre-filter buys is that the menu does not *offer* a choice whose
 * only answer is a 409. Making production inherit from a preview environment
 * that already inherits from production is a loop anybody can see in the
 * listing, and a menu that lets you pick it and then tells you off is a menu
 * that was not paying attention. So such choices are drawn — leaving them out
 * would read as "that environment does not exist" — disabled, with the reason
 * beside them.
 *
 * ── Slugs, not ids ──
 * The listing speaks slugs (`parent` is a slug), and so does this module. A
 * project's slugs are unique within it, which is the only scope a parent can
 * come from.
 */

/** The fields of an environment this module reads. */
type Listed = Pick<Environment, 'slug' | 'parent'>;

function parentOf(environments: readonly Listed[], slug: string): string | null {
  return environments.find((environment) => environment.slug === slug)?.parent ?? null;
}

/**
 * The environments `slug` inherits from, nearest first: its parent, the
 * parent's parent, and so on.
 *
 * Stops at the first slug already seen, so a loop in the listing — which the
 * server never lets exist, and which a stale listing could still appear to hold
 * — ends the walk rather than the tab. Stops too at a parent the listing does
 * not name, which is a parent this viewer cannot see or one deleted a moment
 * ago; the chain is then simply as far as can be told.
 */
export function inheritanceChain(environments: readonly Listed[], slug: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([slug]);
  let next = parentOf(environments, slug);

  while (next !== null && !seen.has(next)) {
    chain.push(next);
    seen.add(next);
    if (!environments.some((environment) => environment.slug === next)) break;
    next = parentOf(environments, next);
  }
  return chain;
}

/**
 * Every environment that inherits from `slug`, directly or through another —
 * the ones that would form a loop were `slug` to inherit from them.
 */
export function descendantsOf(environments: readonly Listed[], slug: string): Set<string> {
  const descendants = new Set<string>();
  let frontier = [slug];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const environment of environments) {
      if (environment.parent === null || environment.parent === undefined) continue;
      if (!frontier.includes(environment.parent)) continue;
      if (environment.slug === slug || descendants.has(environment.slug)) continue;
      descendants.add(environment.slug);
      next.push(environment.slug);
    }
    frontier = next;
  }
  return descendants;
}

/**
 * How many levels of environments sit below `slug`: 0 when nothing inherits
 * from it, 1 when only its children do, and so on.
 *
 * What a new parent costs is counted in the *deepest* of them: giving `slug` a
 * parent with two ancestors of its own puts every grandchild of `slug` five
 * levels down.
 */
export function descendantDepth(environments: readonly Listed[], slug: string): number {
  let depth = 0;
  let frontier = new Set([slug]);
  const seen = new Set([slug]);

  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const environment of environments) {
      const parent = environment.parent;
      if (parent === null || parent === undefined || !frontier.has(parent)) continue;
      if (seen.has(environment.slug)) continue;
      seen.add(environment.slug);
      next.add(environment.slug);
    }
    if (next.size === 0) break;
    depth += 1;
    frontier = next;
  }
  return depth;
}

/** One entry in the parent menu. */
export interface ParentOption {
  slug: string;
  name: string;
  isProduction: boolean;
  /** Why this one cannot be chosen, or `null` when it can. */
  unavailable: string | null;
}

/**
 * The menu of parents `self` may be given: every other environment of the
 * project, in the listing's order, each either choosable or carrying the reason
 * it is not.
 *
 * The order of the checks is the order a person would ask: can this one hold
 * inherited values at all, would it loop, would it be too deep.
 */
export function parentOptions(
  environments: readonly Pick<
    Environment,
    'slug' | 'name' | 'parent' | 'encryptionMode' | 'isProduction'
  >[],
  self: string,
): ParentOption[] {
  const below = descendantsOf(environments, self);
  const depthBelow = descendantDepth(environments, self);

  return environments
    .filter((environment) => environment.slug !== self)
    .map((environment) => {
      const base = {
        slug: environment.slug,
        name: environment.name,
        isProduction: environment.isProduction,
      };

      if (environment.encryptionMode !== 'e2ee') {
        return { ...base, unavailable: 'Not end-to-end encrypted' };
      }
      if (below.has(environment.slug)) {
        return { ...base, unavailable: 'Inherits from this environment — that would be a loop' };
      }

      // `self` would sit one below the candidate, and the deepest environment
      // under `self` that many further down. Each is an ancestor of the one
      // beneath it, so the longest chain anywhere afterwards is the candidate's
      // own ancestors, plus the candidate, plus everything from `self` down.
      const ancestors = inheritanceChain(environments, environment.slug).length + 1 + depthBelow;
      if (ancestors > MAX_INHERITANCE_DEPTH) {
        return {
          ...base,
          unavailable: `Would make a chain of more than ${MAX_INHERITANCE_DEPTH} parents`,
        };
      }

      return { ...base, unavailable: null };
    });
}

/** The environments that inherit directly from `slug`, in listing order. */
export function childrenOf<T extends Listed>(environments: readonly T[], slug: string): T[] {
  return environments.filter((environment) => environment.parent === slug);
}

/** A slug as the listing names it, falling back to the slug itself for one it does not hold. */
export function environmentName(
  environments: readonly Pick<Environment, 'slug' | 'name'>[],
  slug: string,
): string {
  return environments.find((environment) => environment.slug === slug)?.name ?? slug;
}
