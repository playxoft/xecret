import { describe, expect, it } from 'vitest';

import { MAX_INHERITANCE_DEPTH } from '@xecret/core/references';
import {
  childrenOf,
  descendantDepth,
  descendantsOf,
  environmentName,
  inheritanceChain,
  parentOptions,
} from './inheritance';

/**
 * The parent menu, worked out from a project's listing. The server refuses
 * every bad choice on its own; what is pinned here is that the menu never
 * *offers* one whose only answer is a refusal — a loop, a mode that cannot
 * inherit, a chain too deep — and that each is drawn with its reason rather
 * than silently missing.
 */

interface Row {
  slug: string;
  name: string;
  parent: string | null;
  encryptionMode: string;
  isProduction: boolean;
}

function env(slug: string, parent: string | null = null, over: Partial<Row> = {}): Row {
  return {
    slug,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    parent,
    encryptionMode: 'e2ee',
    isProduction: slug === 'production',
    ...over,
  };
}

describe('inheritanceChain', () => {
  it('walks parents nearest first', () => {
    const listing = [env('dev'), env('staging', 'dev'), env('production', 'staging')];
    expect(inheritanceChain(listing, 'production')).toEqual(['staging', 'dev']);
    expect(inheritanceChain(listing, 'dev')).toEqual([]);
  });

  it('ends a loop in a stale listing instead of spinning', () => {
    const listing = [env('a', 'b'), env('b', 'c'), env('c', 'a')];
    expect(inheritanceChain(listing, 'a')).toEqual(['b', 'c']);
  });

  it('stops at a parent the listing does not hold', () => {
    const listing = [env('preview', 'gone')];
    expect(inheritanceChain(listing, 'preview')).toEqual(['gone']);
  });
});

describe('descendantsOf and descendantDepth', () => {
  const listing = [
    env('production'),
    env('staging', 'production'),
    env('preview', 'staging'),
    env('qa', 'production'),
    env('dev'),
  ];

  it('finds every environment below, through any number of levels', () => {
    expect([...descendantsOf(listing, 'production')].sort()).toEqual(['preview', 'qa', 'staging']);
    expect([...descendantsOf(listing, 'staging')]).toEqual(['preview']);
    expect(descendantsOf(listing, 'dev').size).toBe(0);
  });

  it('counts the deepest level below', () => {
    expect(descendantDepth(listing, 'production')).toBe(2);
    expect(descendantDepth(listing, 'staging')).toBe(1);
    expect(descendantDepth(listing, 'preview')).toBe(0);
  });

  it('lists only the direct children', () => {
    expect(childrenOf(listing, 'production').map((row) => row.slug)).toEqual(['staging', 'qa']);
  });
});

describe('parentOptions', () => {
  it('leaves itself out and offers every other end-to-end encrypted environment', () => {
    const listing = [env('dev'), env('staging'), env('production')];
    const options = parentOptions(listing, 'staging');

    expect(options.map((option) => option.slug)).toEqual(['dev', 'production']);
    expect(options.every((option) => option.unavailable === null)).toBe(true);
  });

  it('draws a server-mode environment disabled, with the reason', () => {
    const listing = [env('legacy', null, { encryptionMode: 'server' }), env('staging')];
    const [legacy] = parentOptions(listing, 'staging');

    expect(legacy?.slug).toBe('legacy');
    expect(legacy?.unavailable).toMatch(/not end-to-end encrypted/i);
  });

  it('refuses a descendant, which would be a loop', () => {
    const listing = [env('production'), env('staging', 'production'), env('preview', 'staging')];
    const options = parentOptions(listing, 'production');

    expect(options.find((option) => option.slug === 'preview')?.unavailable).toMatch(/loop/);
    expect(options.find((option) => option.slug === 'staging')?.unavailable).toMatch(/loop/);
  });

  it(`refuses a parent that would put something more than ${MAX_INHERITANCE_DEPTH} levels down`, () => {
    // a ← b ← c ← d: d already has three ancestors. Giving `x` (which has one
    // child, `y`) the parent `d` puts `y` at d's three, plus d, plus x: five —
    // allowed. Giving it `e`, one level further down, makes six.
    const listing = [
      env('a'),
      env('b', 'a'),
      env('c', 'b'),
      env('d', 'c'),
      env('e', 'd'),
      env('x'),
      env('y', 'x'),
    ];
    const options = parentOptions(listing, 'x');

    expect(options.find((option) => option.slug === 'd')?.unavailable).toBeNull();
    expect(options.find((option) => option.slug === 'e')?.unavailable).toMatch(/more than 5/);
  });

  it('carries the production flag through for the menu', () => {
    const options = parentOptions([env('production'), env('dev')], 'dev');
    expect(options[0]?.isProduction).toBe(true);
  });
});

describe('environmentName', () => {
  it('names a slug, and falls back to the slug for one it does not know', () => {
    expect(environmentName([env('staging')], 'staging')).toBe('Staging');
    expect(environmentName([], 'gone')).toBe('gone');
  });
});
