import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MINIMUM_SEATS, PLANS } from '@xecret/core/entitlements';

/**
 * The prose pages against the engine, and against each other.
 *
 * ── Why this file exists ──
 * `/pricing` derives every ceiling it publishes from `@xecret/core/entitlements`
 * and `pricing-page.test.ts` fails the build if it stops doing so. Six other
 * pages state the same numbers in *sentences* — "3 organisations, 25 projects,
 * 10 environments per project" — and a sentence cannot be interpolated from a
 * constant without reading like a spreadsheet. So they are written by hand, and
 * until this file they were written by hand with nothing checking them.
 *
 * That is not a hypothetical. The lineup these pages carried before this suite
 * existed — Free (3 members) / Team $9 / Business $19 — had been retired an
 * entire release earlier, and four of the six pages publish their version
 * inside JSON-LD, so the site was serving Google two contradictory price sets
 * for the same plan names. `/terms` states prices contractually and closes with
 * "if they ever disagree with this section, this section is the one you agreed
 * to", which is the sentence that makes a stale number here expensive rather
 * than untidy.
 *
 * ── What it asserts ──
 * Not that the prose is well written — that every *number* and every *plan
 * name* in it still matches the engine, and that no retired one survives
 * anywhere. Read as source text rather than rendered, because what is worth
 * pinning is which figures are written down.
 */

const PAGES = [
  'terms',
  'faq',
  'features',
  'about',
  'privacy',
  '.', // the home page, `src/app/page.tsx`
] as const;

const SOURCES = new Map(
  PAGES.map((page) => [page, readFileSync(join(import.meta.dirname, page, 'page.tsx'), 'utf8')]),
);

/** Every page's text at once, for the "nowhere on the site" assertions. */
const ALL = [...SOURCES.values()].join('\n');

/**
 * `25` also written as `twenty-five`.
 *
 * The home page spells its numbers out — "three organisations, twenty-five
 * projects" — because it is prose at the top of the site rather than a table.
 * So a figure counts as present if either form is, and the pages that use
 * numerals are not forced to change to satisfy the one that does not.
 */
const WORDS: Readonly<Record<number, string>> = {
  1: 'one',
  3: 'three',
  5: 'five',
  7: 'seven',
  10: 'ten',
  25: 'twenty-five',
  30: 'thirty',
  100: 'a hundred',
  180: 'a hundred and eighty',
  250: 'two hundred and fifty',
  365: 'a year',
};

function states(source: string, value: number): boolean {
  const word = WORDS[value];
  return (
    new RegExp(`\\b${value.toLocaleString('en-GB')}\\b`).test(source) ||
    new RegExp(`\\b${value}\\b`).test(source) ||
    (word !== undefined && source.toLowerCase().includes(word))
  );
}

describe('no page still publishes the retired lineup', () => {
  // Free / Team $9 / Business $19 was replaced a release before these pages
  // were updated, and it survived on six of them. Each of these strings was
  // live on the site.
  it.each([
    ['the Business tier', /\bBusiness\b/],
    ['the $9 Team rate', /\$9\b/],
    ['the $7 yearly rate', /\$7\b/],
    ['the $15 yearly rate', /\$15\b/],
    ['a sellable Scale tier', /\bScale (plan|tier)\b/],
  ])('does not mention %s anywhere', (_label, pattern) => {
    expect(ALL).not.toMatch(pattern);
  });

  it('names only the four plans the engine defines, plus self-hosting', () => {
    for (const name of ['Free', 'Pro', 'Team', 'Enterprise']) {
      expect(ALL, `${name} is never named`).toContain(name);
    }
    expect(Object.keys(PLANS).sort()).toEqual(['enterprise', 'free', 'pro', 'team']);
  });
});

describe('every page that states a price states the current one', () => {
  // The pages that quote figures at all. `/privacy` states retention but no
  // price, so it is checked in the retention suite instead.
  const PRICED = ['terms', 'faq', 'features', 'about', '.'] as const;

  it.each(PRICED)('%s quotes Pro at $8 monthly and $5 yearly', (page) => {
    const source = SOURCES.get(page) ?? '';
    expect(source).toContain('$8');
    expect(source).toContain('$5');
  });

  it.each(PRICED)('%s quotes Team at $19 monthly and $12 yearly', (page) => {
    const source = SOURCES.get(page) ?? '';
    expect(source).toContain('$19');
    expect(source).toContain('$12');
  });
});

describe('every limit stated in prose matches the engine', () => {
  // `/terms` is the contractual one and states the full ladder, so it carries
  // the strictest assertion: every ceiling for every plan it enumerates.
  it('terms states the Pro and Team ceilings the engine enforces', () => {
    const source = SOURCES.get('terms') ?? '';

    for (const plan of ['pro', 'team'] as const) {
      const limits = PLANS[plan].limits;
      for (const field of [
        'organizations',
        'projects',
        'environmentsPerProject',
        'secretsPerEnvironment',
        'serviceTokens',
        'auditRetentionDays',
      ] as const) {
        const value = limits[field];
        if (value === null) continue;
        expect(states(source, value), `terms does not state ${plan}.${field} = ${value}`).toBe(
          true,
        );
      }
    }
  });

  it('every page that states the free ceilings states the engine ones', () => {
    const free = PLANS.free.limits;

    for (const [page, source] of SOURCES) {
      // Only the pages that actually enumerate the free tier.
      if (!/free tier|Free is|Free —/i.test(source)) continue;

      for (const [field, value] of [
        ['organizations', free.organizations],
        ['projects', free.projects],
        ['environmentsPerProject', free.environmentsPerProject],
        ['seats', free.seats],
        ['auditRetentionDays', free.auditRetentionDays],
      ] as const) {
        if (value === null) continue;
        expect(states(source, value), `${page} does not state free.${field} = ${value}`).toBe(true);
      }
    }
  });
});

describe('audit retention agrees with the engine everywhere it is stated', () => {
  // This is the number that was wrong in two places at once: `/privacy` said
  // 12 months on Team and 3 years on Business, and the `/faq` answer two
  // entries below a corrected one still said "Thirty days on Free, twelve
  // months on Team" — published as `FAQPage` structured data.
  it.each([
    ['free', PLANS.free.limits.auditRetentionDays],
    ['pro', PLANS.pro.limits.auditRetentionDays],
    ['team', PLANS.team.limits.auditRetentionDays],
    ['enterprise', PLANS.enterprise.limits.auditRetentionDays],
  ])('privacy states %s retention as %i days', (_plan, days) => {
    expect(states(SOURCES.get('privacy') ?? '', days as number)).toBe(true);
  });

  it('no page still claims twelve months or three years of history', () => {
    expect(ALL).not.toMatch(/12 months of (audit )?history/i);
    expect(ALL).not.toMatch(/twelve months on Team/i);
    expect(ALL).not.toMatch(/(3|three) years of (audit )?history/i);
  });
});

describe('the seat minimum is disclosed where it is charged', () => {
  // `resolveBilledSeats` floors billed seats at `MINIMUM_SEATS`, so a
  // two-person team reading "$12 per member per month" computes $288 a year
  // and is invoiced $432. `/terms` is where that has to be stated.
  it('terms states the Team and Enterprise minimums', () => {
    const source = SOURCES.get('terms') ?? '';
    expect(states(source, MINIMUM_SEATS.team)).toBe(true);
    expect(states(source, MINIMUM_SEATS.enterprise)).toBe(true);
    expect(source.toLowerCase()).toMatch(/minimum/);
  });

  it('the minimums are what the engine actually bills at', () => {
    expect(MINIMUM_SEATS.free).toBe(1);
    expect(MINIMUM_SEATS.pro).toBe(1);
    expect(MINIMUM_SEATS.team).toBeGreaterThan(1);
    expect(MINIMUM_SEATS.enterprise).toBeGreaterThan(MINIMUM_SEATS.team);
  });
});

describe('the add-ons are described the same way everywhere', () => {
  // SAML is an add-on from Team and included with Enterprise; SCIM is an
  // Enterprise-only add-on. Four pages used to gate both at Enterprise, which
  // told a Team reader SAML was out of reach and SCIM was within it — the two
  // have mirror-image rules and collapsing them gets both wrong.
  it('no page gates SAML at Enterprise alone', () => {
    expect(ALL).not.toMatch(/SAML single sign-on and SCIM provisioning are named there/i);
  });

  it('every page that prices the add-ons prices them the same', () => {
    // Keyed on "per connection" rather than on a `$` anywhere after the word
    // SAML: these pages quote plan prices too, so the looser test fired on
    // every page that merely mentions single sign-on near a figure.
    for (const [page, source] of SOURCES) {
      if (!/per[- ]connection/i.test(source)) continue;
      expect(source, `${page} prices SAML at something other than $199`).toContain('$199');
      expect(source, `${page} prices SCIM at something other than $249`).toContain('$249');
    }
  });
});
