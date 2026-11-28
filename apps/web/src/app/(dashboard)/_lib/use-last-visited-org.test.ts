import { describe, expect, it } from 'vitest';

import { resolveRememberedOrg } from './use-last-visited-org';

/**
 * Which organisation a tab's remembered value names, and whether it has to be
 * rewritten — the carry for a tab that was open across the move from slugs to
 * ids, and so still remembers where it was by slug.
 *
 * The hook around this is a `useSyncExternalStore` over `sessionStorage`, which
 * this suite has no DOM to drive; what it decides is here.
 */

const ACME = { id: '0193f2a1-0000-7000-8000-00000000a001', slug: 'acme', name: 'Acme' };
const ZEBRA = { id: '0193f2a1-0000-7000-8000-00000000b002', slug: 'zebra', name: 'Zebra' };
const memberships = [ACME, ZEBRA];

describe('the organisation a tab remembered', () => {
  it('is the membership its id names, kept as it is', () => {
    expect(resolveRememberedOrg(ZEBRA.id, memberships)).toEqual({
      organization: ZEBRA,
      rewrite: false,
    });
  });

  it('is the membership a slug from before ids names, in any case, rewritten as the id', () => {
    expect(resolveRememberedOrg('zebra', memberships)).toEqual({
      organization: ZEBRA,
      rewrite: true,
    });
    expect(resolveRememberedOrg('ZEBRA', memberships)?.organization).toBe(ZEBRA);
  });

  /** An organisation the viewer has since left cannot outlive their access. */
  it('is nothing for an id or a slug that names no membership', () => {
    expect(resolveRememberedOrg('0193f2a1-0000-7000-8000-00000000c003', memberships)).toBeNull();
    expect(resolveRememberedOrg('gone', memberships)).toBeNull();
  });

  it('is nothing when the tab remembers nothing', () => {
    expect(resolveRememberedOrg(null, memberships)).toBeNull();
    expect(resolveRememberedOrg('', memberships)).toBeNull();
  });

  it('never reads an id as a slug, even one a slug somebody chose happened to spell', () => {
    const odd = { id: '0193f2a1-0000-7000-8000-00000000d004', slug: ACME.id, name: 'Odd' };
    expect(resolveRememberedOrg(ACME.id, [odd])).toBeNull();
  });
});
