import { describe, expect, it } from 'vitest';

import {
  nameIsShared,
  organizationMatches,
  sharedOrgNames,
  SHORT_ORG_ID_LENGTH,
  shortOrgId,
} from './organization-label';

/**
 * Names are free text and not unique, so a picker that lists organisations by
 * name needs the end of each id beside the ones that collide.
 */

// Two organisations made in the same minute: their UUIDv7 ids share the start,
// which is the creation time, and differ only in the random end.
const ACME_ONE = { id: '0192f0a1-7c3e-7d2a-9b1f-2a3b4c5d6e7f', name: 'Acme' };
const ACME_TWO = { id: '0192f0a1-7c3f-7a10-8c2e-9d8c7b6a5f4e', name: 'acme ' };
const ZEBRA = { id: '0192f0b4-1d2e-7f30-8a41-5b6c7d8e9f01', name: 'Zebra' };

describe('the short id beside a name', () => {
  it('is the random end of the id, which two organisations made together do not share', () => {
    expect(shortOrgId(ACME_ONE.id)).toBe('4c5d6e7f');
    expect(shortOrgId(ACME_ONE.id)).toHaveLength(SHORT_ORG_ID_LENGTH);
    expect(ACME_ONE.id.slice(0, 8)).toBe(ACME_TWO.id.slice(0, 8));
    expect(shortOrgId(ACME_ONE.id)).not.toBe(shortOrgId(ACME_TWO.id));
  });
});

describe('which names collide', () => {
  it('finds the names more than one organisation shares, as a person reads them', () => {
    const shared = sharedOrgNames([ACME_ONE, ACME_TWO, ZEBRA]);

    expect(nameIsShared('Acme', shared)).toBe(true);
    expect(nameIsShared('ACME', shared)).toBe(true);
    expect(nameIsShared('Zebra', shared)).toBe(false);
  });

  it('finds none when every name is different', () => {
    expect(sharedOrgNames([ACME_ONE, ZEBRA]).size).toBe(0);
    expect(sharedOrgNames([]).size).toBe(0);
  });
});

describe('searching organisations', () => {
  it('finds one by any part of its name or of its id', () => {
    expect(organizationMatches(ZEBRA, 'zeb')).toBe(true);
    expect(organizationMatches(ZEBRA, '  ')).toBe(true);
    expect(organizationMatches(ACME_ONE, '4c5d6e7f')).toBe(true);
    expect(organizationMatches(ACME_ONE, ACME_ONE.id.toUpperCase())).toBe(true);
    expect(organizationMatches(ACME_TWO, '4c5d6e7f')).toBe(false);
    expect(organizationMatches(ZEBRA, 'acme')).toBe(false);
  });
});
