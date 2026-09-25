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

/**
 * Whether a page states `value` of `noun` — "25 projects", "ten environments".
 *
 * ── Why the noun is required ──
 * The first version of this took the number alone and asked whether the page
 * contained it in either form. It was vacuous for most of the values it was
 * written to pin. `WORDS[10]` is `'ten'` as a bare substring, and `/terms`
 * contains "content", "retention", "sentence", "written", "extent" and
 * "maintenance" — fourteen substring hits and not one standalone `ten` — so
 * the assertions for `pro.environmentsPerProject` and `team.organizations`
 * passed on the word "retention". `'one'` matched "none" and "someone",
 * `'a hundred'` was a prefix of "a hundred and eighty", `'a year'` matched any
 * mention of a year, and even the numeral branch let `\b1\b` match the `1` in
 * "1,000".
 *
 * Anchoring to the noun fixes all of it at once: "retention" is not
 * "ten environments", and the assertion now fails when the figure beside the
 * noun changes, which is the only thing it was ever supposed to detect. The
 * numeral side is fenced against digits, commas and decimal points on both
 * sides so a figure can never be matched out of the middle of a longer one.
 */
function states(source: string, value: number, noun: string): boolean {
  // Whitespace collapsed first. These are JSX prose strings that Prettier wraps
  // wherever the column runs out, so "180 days of audit history" reaches here
  // as "180 days\n          of audit history". Matching the raw text made every
  // multi-word assertion depend on where the formatter happened to break the
  // line — green today, red after an unrelated reflow, and for a reason nobody
  // would guess from the failure.
  const text = source.toLowerCase().replace(/\s+/g, ' ');
  const forms = [value.toLocaleString('en-GB'), String(value)];
  const word = WORDS[value];
  if (word !== undefined) forms.push(word);

  return forms.some((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `(?![\d,.])` and its mirror keep `1` out of `1,000` and `100` out of
    // `1,000,000`.
    return new RegExp(`(?<![\\d,.\\w])${escaped}(?![\\d,.])\\s+${noun}`).test(text);
  });
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

  /**
   * `$19`, but not the `$19` inside `$199`.
   *
   * `toContain('$19')` was satisfied by the SAML add-on price this same PR
   * added to all five of these pages, so the Team monthly rate was unpinned on
   * every page this file claims to pin it on — rewriting every standalone $19
   * in `/terms` to $21 left the suite green. The fence is on the trailing side
   * only: no price here is a suffix of another.
   */
  function quotes(source: string, price: string): boolean {
    const escaped = price.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${escaped}(?!\\d)`).test(source);
  }

  it.each(PRICED)('%s quotes Pro at $8 monthly and $5 yearly', (page) => {
    const source = SOURCES.get(page) ?? '';
    expect(quotes(source, '$8'), `${page} does not quote Pro monthly`).toBe(true);
    expect(quotes(source, '$5'), `${page} does not quote Pro yearly`).toBe(true);
  });

  it.each(PRICED)('%s quotes Team at $19 monthly and $12 yearly', (page) => {
    const source = SOURCES.get(page) ?? '';
    expect(quotes(source, '$19'), `${page} does not quote Team monthly`).toBe(true);
    expect(quotes(source, '$12'), `${page} does not quote Team yearly`).toBe(true);
  });
});

/**
 * The noun each ceiling is written beside, as the prose actually words it.
 *
 * This is the anchor that makes the assertions bite — see `states`. Where a
 * page has a choice of phrasings the alternatives are alternated in the
 * pattern, so "10 environments per project" and "ten environments" both count
 * but "retention" does not.
 */
const NOUNS = {
  organizations: 'organisations?',
  projects: 'projects',
  environmentsPerProject: 'environments',
  secretsPerEnvironment: 'secrets',
  serviceTokens: '(service tokens|ci tokens)',
  seats: 'members?',
  auditRetentionDays: 'days of (audit )?history',
} as const;

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
        expect(
          states(source, value, NOUNS[field]),
          `terms does not state ${plan}.${field} = ${value}`,
        ).toBe(true);
      }
    }
  });

  /**
   * Just the sentence (or bullet) describing the free tier.
   *
   * Narrowed because `MINIMUM_SEATS.team` and `FREE_LIMITS.seats` are both `3`,
   * and `/terms` states both — so "a minimum of 3 members", added by this PR,
   * silently satisfied the Free seat assertion. Changing the Free bullet to
   * "4 members" left the suite green. Every one of these pages lists Free
   * first and Pro next, so the free description is what lies between them.
   */
  function freeRegion(source: string): string {
    const start = source.search(/free tier|Free is|Free —/i);
    if (start < 0) return '';
    const rest = source.slice(start);
    const end = rest.search(/\bPro (is|will be|—)/);
    return end < 0 ? rest : rest.slice(0, end);
  }

  it('every page that states the free ceilings states the engine ones', () => {
    const free = PLANS.free.limits;

    for (const [page, source] of SOURCES) {
      // Only the pages that actually enumerate the free tier.
      const region = freeRegion(source);
      if (region === '') continue;

      for (const field of [
        'organizations',
        'projects',
        'environmentsPerProject',
        'seats',
        'auditRetentionDays',
      ] as const) {
        const value = free[field];
        if (value === null) continue;
        expect(
          states(region, value, NOUNS[field]),
          `${page} does not state free.${field} = ${value}`,
        ).toBe(true);
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
  ])('privacy states %s retention as %i days', (plan, days) => {
    // Anchored on the plan name, not the unit. `/privacy` also says
    // "Sessions — 30 days from creation" and carries a 30-day cookie line, so
    // `states(source, 30, 'days?')` was satisfied by text that has nothing to
    // do with audit retention — changing "30 days on Pro" to "45 days on Pro"
    // left the suite green. The page words the whole group as "7 days on Free,
    // 30 days on Pro, 180 days on Team, a year on Enterprise".
    const source = SOURCES.get('privacy') ?? '';
    expect(
      states(source, days as number, `days? on ${plan}`) ||
        states(source, days as number, `on ${plan}`),
      `privacy does not state ${days} days on ${plan}`,
    ).toBe(true);
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
    expect(states(source, MINIMUM_SEATS.team, 'members?')).toBe(true);
    expect(source.toLowerCase()).toMatch(
      new RegExp(`minimum of ${MINIMUM_SEATS.team} members?`, 'i'),
    );
    expect(source.toLowerCase()).toMatch(
      new RegExp(`enterprise from ${MINIMUM_SEATS.enterprise}`, 'i'),
    );
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

  it('never publishes an add-on price without its unit', () => {
    // $249 with no unit can be read as a one-off or a per-member charge, and
    // four of these answers are emitted as `FAQPage` JSON-LD, so the ambiguity
    // reaches a rich result. Both add-ons are per connection, per month.
    for (const [page, source] of SOURCES) {
      const text = source.replace(/\s+/g, ' ');
      for (const price of ['$199', '$249']) {
        if (!text.includes(price)) continue;
        const after = text.slice(text.indexOf(price), text.indexOf(price) + 120);
        expect(after, `${page} quotes ${price} with no unit beside it`).toMatch(
          /per[- ]connection/i,
        );
      }
    }
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
