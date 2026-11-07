import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MINIMUM_SEATS, PLANS } from '@xecret/core/entitlements';
import { PROJECT_VIEW_STORAGE_KEY } from '@/components/projects/project-listing';
import { DEVICE_PIN_WRAP_KEY } from '@/components/vault/device-pin';
import { VAULT_SESSION_MIRROR_KEY } from '@/components/vault/session-mirror';
import { UNLOCK_NUDGE_KEY } from '@/components/vault/unlock-nudge';
import { SIDEBAR_STORAGE_KEY, THEME_STORAGE_KEY } from '@/lib/theme';

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

/** `indexOf`, but a miss sorts last instead of first. */
function idx(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  return at < 0 ? haystack.length : at;
}

/**
 * The published prose only, with the code commentary removed.
 *
 * Three assertions in this suite have now been tripped by a comment rather than
 * by copy: these pages explain their own pricing rules in `//` notes beside the
 * strings, so a rule of the form "no page may say X" matches the note that
 * records why X is wrong. Comments are not published, so they are not what these
 * assertions are about.
 *
 * Line comments are stripped only where they begin a line, so a `//` inside a
 * URL in body copy survives.
 */
const PROSE = new Map(
  [...SOURCES].map(([page, source]) => [
    page,
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''),
  ]),
);

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
    // Word-bounded, because `toContain('Pro')` could not fail: these pages
    // carry "Production" five times over, plus "Props" and "Protecting", so the
    // assertion passed with every Pro-plan mention on the site deleted. The
    // other three arms were genuine by luck of vocabulary rather than by
    // construction.
    for (const name of ['Free', 'Pro', 'Team', 'Enterprise']) {
      expect(ALL, `${name} is never named as a plan`).toMatch(new RegExp(`\\b${name}\\b`));
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
  cliDevicesPerUser: 'cli devices',
  webhooks: 'webhooks',
} as const;

describe('every limit stated in prose matches the engine', () => {
  // `/terms` is the contractual one and states the full ladder, so it carries
  // the strictest assertion: every ceiling for every plan it enumerates.
  /**
   * Which ceilings each page actually enumerates.
   *
   * `/terms` states the full ladder. The others state a subset in a sentence —
   * and until this map existed only `/terms` was checked, so the four pages that
   * emit these figures inside `FAQPage` JSON-LD were unpinned. Verified by
   * mutation: rewriting `/faq`'s "25 projects" to "35 projects" and `/about`'s
   * "180 days of history" to "999 days" both left the suite green, which is
   * exactly the drift this file's docblock says it exists to stop.
   */
  const STATES_CEILINGS: Readonly<Record<string, readonly (keyof typeof NOUNS)[]>> = {
    terms: [
      'organizations',
      'projects',
      'environmentsPerProject',
      'secretsPerEnvironment',
      'serviceTokens',
      'cliDevicesPerUser',
      'webhooks',
      'auditRetentionDays',
    ],
    faq: ['organizations', 'projects', 'environmentsPerProject', 'auditRetentionDays'],
    features: ['organizations', 'projects', 'environmentsPerProject', 'auditRetentionDays'],
    about: ['organizations', 'projects', 'environmentsPerProject', 'auditRetentionDays'],
    '.': ['organizations', 'projects', 'environmentsPerProject', 'auditRetentionDays'],
  };

  // `Object.keys` widens to `string[]`, and `SOURCES` is keyed by the literal
  // union, so the cast is what keeps the map's keys checked against `PAGES`
  // rather than silently accepting a page name that does not exist.
  const CEILING_PAGES = Object.keys(STATES_CEILINGS) as (typeof PAGES)[number][];

  it.each(CEILING_PAGES)('%s states the Pro and Team ceilings', (page) => {
    const source = SOURCES.get(page) ?? '';
    const fields = STATES_CEILINGS[page] ?? [];
    expect(fields.length, `${page} has no fields listed`).toBeGreaterThan(0);

    for (const plan of ['pro', 'team'] as const) {
      const limits = PLANS[plan].limits;
      for (const field of fields) {
        const value = limits[field];
        if (value === null) continue;
        expect(
          states(source, value, NOUNS[field]),
          `${page} does not state ${plan}.${field} = ${value}`,
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

  /**
   * The pages that enumerate the free tier, and therefore must be checked.
   *
   * Named explicitly because the alternative was a silent skip: `freeRegion`
   * finds its region by three literal phrasings and returns `''` otherwise, and
   * the caller used to `continue` on that — so rewording `/terms`'s
   * "Free — $0, forever." to "Free: $0 forever." would switch off all five free
   * ceiling assertions on the contractual page and a later drift from 3 members
   * to 9 would ship green. `/privacy` states retention but never enumerates the
   * tier, and it already took that branch, so the no-op path was live rather
   * than hypothetical.
   */
  const ENUMERATES_FREE = ['terms', 'faq', 'features', 'about', '.'] as const;

  /**
   * `/terms` binds, and every ceiling the server refuses a creation on is one a
   * customer agreed to — so the Free bullet states all of them, not only the
   * handful the marketing pages repeat. A ceiling of zero is stated as "no".
   */
  it('terms states every ceiling the server enforces on Free', () => {
    const region = freeRegion(SOURCES.get('terms') ?? '');
    expect(region).not.toBe('');
    const free = PLANS.free.limits;

    for (const field of [
      'organizations',
      'projects',
      'environmentsPerProject',
      'secretsPerEnvironment',
      'serviceTokens',
      'seats',
      'cliDevicesPerUser',
      'webhooks',
      'auditRetentionDays',
    ] as const) {
      const value = free[field];
      if (value === null) continue;
      const stated =
        value === 0
          ? new RegExp(`\\bno ${NOUNS[field]}`).test(region.toLowerCase().replace(/\s+/g, ' '))
          : states(region, value, NOUNS[field]);
      expect(stated, `terms does not state free.${field} = ${value}`).toBe(true);
    }
  });

  it('every page that states the free ceilings states the engine ones', () => {
    const free = PLANS.free.limits;

    for (const page of ENUMERATES_FREE) {
      const source = SOURCES.get(page) ?? '';
      const region = freeRegion(source);
      // Loud, not skipped: an unfindable region means the phrasing moved, and
      // the answer to that is a failing test rather than five fewer checks.
      expect(region, `${page} enumerates the free tier but no region was found`).not.toBe('');

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

    // The bare `states(source, MINIMUM_SEATS.team, 'members?')` that used to
    // lead here could not fail: `MINIMUM_SEATS.team` and `FREE_LIMITS.seats`
    // are both 3, and the Free bullet says "3 members", so deleting the entire
    // seat-minimum paragraph left it green. The two phrase-anchored assertions
    // below were always the ones doing the work, so it is gone rather than
    // scoped — the same 3/3 collision the `freeRegion` note records, in the
    // other direction.
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
  it('every page that names SAML says it starts at Team', () => {
    // The previous version of this banned one literal sentence — and that
    // sentence existed in neither `main` nor `HEAD`, only inside the assertion
    // itself. It was written against a string the same commit had already
    // replaced, so it could never fail and tested nothing its name claimed.
    //
    // Two invariants, and both are page-level rather than sentence-level. A
    // per-sentence version fired on `/terms`'s Enterprise bullet — "SAML single
    // sign-on is included at this tier" is a true statement that names no Team,
    // because the Team half is a paragraph further down.
    for (const [page, source] of SOURCES) {
      if (!source.includes('SAML')) continue;
      const text = source.replace(/\s+/g, ' ');

      // Never Enterprise-only: that is SCIM's rule, not SAML's, and the one
      // sentence that used to cover both got each wrong in opposite directions.
      //
      // Every occurrence, not the first. Taking only `indexOf('SAML')` meant
      // that on `/about` the clause examined was inside a `//` code comment and
      // the published `body:` sentence was never looked at, and on `/terms` it
      // was the Enterprise bullet rather than the Add-ons paragraph where the
      // tier rule actually lives — so an edit making a *later* mention read
      // "Enterprise only" shipped green under a test whose name forbade it.
      //
      // Each clause is clipped at the punctuation rather than a character
      // count: a 200-character window ran past the semicolon into "directory
      // sync (SCIM) is $249 … at Enterprise only" and failed on SCIM's rule
      // while claiming SAML's.
      for (const match of text.matchAll(/SAML/g)) {
        const after = text.slice(match.index);
        const clause = after.slice(0, Math.min(...[';', '.'].map((d) => idx(after, d))));
        expect(clause, `${page} calls SAML Enterprise-only`).not.toMatch(/enterprise[- ]only/i);
      }

      // Any page that quotes the price has to say where it starts.
      if (!text.includes('$199')) continue;
      expect(text, `${page} prices SAML without saying it starts at Team`).toMatch(
        /(from|only)[^.]{0,40}Team|Team[^.]{0,40}(and above|only)/,
      );
    }
  });

  it('never publishes an add-on price without its unit', () => {
    // $199 with no unit can be read as a one-off or a per-member charge, and
    // four of these answers are emitted as `FAQPage` JSON-LD, so the ambiguity
    // reaches a rich result.
    for (const [page, source] of SOURCES) {
      const text = source.replace(/\s+/g, ' ');
      if (!text.includes('$199')) continue;
      const after = text.slice(text.indexOf('$199'), text.indexOf('$199') + 120);
      expect(after, `${page} quotes $199 with no unit beside it`).toMatch(/per[- ]connection/i);
    }
  });

  it('every page that prices the add-on prices it the same', () => {
    // Keyed on "per connection" rather than on a `$` anywhere after the word
    // SAML: these pages quote plan prices too, so the looser test fired on
    // every page that merely mentions single sign-on near a figure.
    for (const [page, source] of SOURCES) {
      if (!/per[- ]connection/i.test(source)) continue;
      expect(source, `${page} prices SAML at something other than $199`).toContain('$199');
    }
  });

  it.each(['terms', 'privacy'] as const)(
    'gives the notice %s promises before a change takes effect',
    (page) => {
      expect(legalDatesProblem(page, SOURCES.get(page) ?? '')).toBeNull();
    },
  );

  /**
   * The version these terms replace promised something this one withdraws for
   * the limits it introduces, and counsel reads the two side by side: §Changes
   * quotes the withdrawn sentence exactly, rather than paraphrasing it.
   */
  it('quotes the withdrawn plan-lapse promise exactly', () => {
    const terms = (SOURCES.get('terms') ?? '').replace(/\s+/g, ' ');
    expect(terms).toContain(
      '&ldquo;we will tell you what exceeds the Free limits and give you a reasonable window to bring the organisation under them or export it&rdquo;',
    );
  });

  it('never charges Enterprise for directory sync', () => {
    // `pricing-plan.md` §3 marks SCIM `✅ included` in the Enterprise column and
    // §8.4 explains why — the $1,500 floor absorbs both WorkOS connections at
    // 17 per cent of revenue. The $249 figure belonged to Scale, which #101
    // removed, and §8.3's "never bundle it below Enterprise" rules out moving
    // the charge to Team.
    //
    // This was published the wrong way round for several commits: the matrix
    // cell read `Add-on` and every other surface, including the contractual
    // Terms, was changed to agree with it. The guard is on the money, not the
    // wording, because that is what a customer pays.
    expect(ALL, 'the retired $249 SCIM charge is back').not.toContain('$249');

    // Read from `PROSE`: `/about` explains this rule in a comment beside the
    // copy, and a guard over raw source matches the explanation.
    for (const [page, source] of PROSE) {
      if (!source.includes('SCIM')) continue;
      const text = source.replace(/\s+/g, ' ');
      const after = text.slice(text.indexOf('SCIM'));
      const clause = after.slice(0, Math.min(...[';', '.'].map((d) => idx(after, d))));
      expect(clause, `${page} charges for SCIM rather than including it`).not.toMatch(
        /\$\d|per[- ]connection|add-on/i,
      );
    }
  });
});

/* ── When a legal page binds ──────────────────────────────────────────────── */

/** How `LegalPage` writes a date out, so §Changes can be checked against it. */
const LEGAL_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const WITHOUT_NOTICE =
  'This version is a change made without that notice, and it takes effect on publication.';

const NOT_MATERIAL = /The version of (\d{1,2} [A-Z][a-z]+ \d{4}) is not a material change\./g;

/**
 * §Changes as published: that section's own text, comments removed, whitespace
 * collapsed — so that neither a note in the source nor a sentence in another
 * section can satisfy a check that is about what §Changes says. `null` when
 * there is no §Changes.
 */
function changesSection(source: string): string | null {
  const prose = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const start = prose.indexOf("id: 'changes'");
  if (start < 0) return null;
  const rest = prose.slice(start + 1);
  const next = rest.search(/id: '[a-z-]+'/);
  return (next < 0 ? rest : rest.slice(0, next)).replace(/\s+/g, ' ');
}

/**
 * Why a legal page's dates misstate when it binds, or `null` when they do not.
 *
 * §Changes promises: "for a material change we will give notice … before it
 * takes effect". The date has been wrong in both directions. It once stayed at
 * the old value, so a customer got no signal that the prices binding them had
 * changed; then it moved to the publish date, so the page promised advance
 * notice and gave none — and fed `datePublished`, claiming the new table was in
 * force before it was written. Three states are honest, and nothing else is:
 *
 *  1. **Notice given** — `EFFECTIVE` a date after `UPDATED`.
 *  2. **On publication, without notice** — `EFFECTIVE = null`: the deploy is its
 *     date, which the source cannot know. A change made without the notice
 *     §Changes promises, so §Changes has to say so.
 *  3. **Not material** — `EFFECTIVE` equal to `UPDATED`. Taking effect the day
 *     it was written gives no notice, and a deploy that lands days later would
 *     have the page claim it bound people before they could read it. That is
 *     honest only for a version with nothing to give notice of, so §Changes has
 *     to say this version — by its date — is not material.
 *
 * The non-material sentence names its version's date so that it cannot
 * outlive it: a later version that moves `UPDATED` and keeps the sentence would
 * otherwise go on telling readers that nothing material changed.
 *
 * Checked against §Changes's own text, never anywhere in the file, where a
 * comment would satisfy it. The cases under "the legal-date guard" below are
 * the dishonest states, each shown to be refused.
 */
function legalDatesProblem(page: string, source: string): string | null {
  const updated = /const UPDATED = '([\d-]+)'/.exec(source)?.[1];
  const effective = /const EFFECTIVE(?:: [^=]+)? = '([\d-]+)'/.exec(source)?.[1];
  const onPublication = /const EFFECTIVE(?:: [^=]+)? = null;/.test(source);
  if (updated === undefined) return `${page} has no UPDATED date`;

  const changes = changesSection(source);
  const thisVersion = LEGAL_DATE.format(new Date(updated));
  const notMaterial = [...(changes ?? '').matchAll(NOT_MATERIAL)].map((match) => match[1]);
  const stale = notMaterial.find((date) => date !== thisVersion);
  if (stale !== undefined) {
    return `${page} §Changes calls the version of ${stale} not material, but this one is of ${thisVersion}`;
  }

  if (onPublication) {
    if (changes === null) return `${page} takes effect on publication but has no §Changes`;
    if (!changes.includes(WITHOUT_NOTICE)) {
      return `${page} takes effect on publication without §Changes saying so`;
    }
    return null;
  }

  if (effective === undefined) return `${page} has no EFFECTIVE date`;
  if (Date.parse(effective) < Date.parse(updated)) {
    return `${page} takes effect before it was published`;
  }
  if (effective === updated && !notMaterial.includes(thisVersion)) {
    return `${page} takes effect the day it was written, with no notice, and §Changes does not say the version of ${thisVersion} is not material`;
  }
  return null;
}

describe('the legal-date guard', () => {
  /** A legal page's source, reduced to what the guard reads. */
  function page({
    updated = '2026-11-07',
    effective,
    changes = [],
    elsewhere = [],
  }: {
    updated?: string | null;
    /** A date, `null` for on publication, `undefined` for no constant at all. */
    effective?: string | null;
    /** Paragraphs of §Changes, as source text. */
    changes?: string[];
    /** Paragraphs of another section, as source text. */
    elsewhere?: string[];
  }): string {
    return [
      updated === null ? '' : `const UPDATED = '${updated}';`,
      effective === undefined
        ? ''
        : effective === null
          ? 'const EFFECTIVE: string | null = null;'
          : `const EFFECTIVE = '${effective}';`,
      'const SECTIONS = [',
      `  { id: 'cookies', paragraphs: [${elsewhere.join(', ')}] },`,
      `  { id: 'changes', paragraphs: [${changes.join(', ')}] },`,
      "  { id: 'contact', paragraphs: [] },",
      '];',
    ].join('\n');
  }

  const said = (text: string) => JSON.stringify(text);
  const NOT_MATERIAL_NOV_7 = said('The version of 7 November 2026 is not a material change.');

  describe('accepts the three honest states', () => {
    it('notice given: effective after it was written', () => {
      expect(legalDatesProblem('p', page({ updated: '2026-09-26', effective: '2026-10-26' }))).toBe(
        null,
      );
    });

    it('on publication, with §Changes saying it came without notice', () => {
      expect(
        legalDatesProblem('p', page({ effective: null, changes: [said(WITHOUT_NOTICE)] })),
      ).toBe(null);
    });

    it('not material: effective the day it was written, with §Changes saying so of this version', () => {
      expect(
        legalDatesProblem('p', page({ effective: '2026-11-07', changes: [NOT_MATERIAL_NOV_7] })),
      ).toBe(null);
    });

    it('reads the sentence however the source wraps it', () => {
      const wrapped = '<>\n  The version of 7 November 2026 is not a\n  material change.\n</>';
      expect(legalDatesProblem('p', page({ effective: '2026-11-07', changes: [wrapped] }))).toBe(
        null,
      );
    });
  });

  describe('refuses every dishonest one', () => {
    // Each with the reason it must be refused for, so a case cannot pass by
    // tripping some other rule first.
    const NO_NOTICE = 'takes effect the day it was written, with no notice';
    it.each([
      ['no UPDATED date', page({ updated: null, effective: '2026-11-07' }), 'has no UPDATED date'],
      ['no EFFECTIVE date at all', page({}), 'has no EFFECTIVE date'],
      [
        'effective before it was written, even when called not material',
        page({ effective: '2026-10-26', changes: [NOT_MATERIAL_NOV_7] }),
        'takes effect before it was published',
      ],
      [
        'effective the day it was written, with nothing said',
        page({ effective: '2026-11-07' }),
        NO_NOTICE,
      ],
      [
        'effective the day it was written, called not material only in a comment',
        page({
          effective: '2026-11-07',
          changes: ['/* The version of 7 November 2026 is not a material change. */'],
        }),
        NO_NOTICE,
      ],
      [
        'effective the day it was written, called not material in another section',
        page({ effective: '2026-11-07', elsewhere: [NOT_MATERIAL_NOV_7] }),
        NO_NOTICE,
      ],
      [
        'effective the day it was written, with the sentence left from an older version',
        page({
          effective: '2026-11-07',
          changes: [said('The version of 20 October 2026 is not a material change.')],
        }),
        'calls the version of 20 October 2026 not material',
      ],
      [
        'notice given, but an older version’s "not material" left standing',
        page({ updated: '2026-12-01', effective: '2027-01-01', changes: [NOT_MATERIAL_NOV_7] }),
        'calls the version of 7 November 2026 not material',
      ],
      [
        'on publication with nothing said',
        page({ effective: null }),
        'takes effect on publication without §Changes saying so',
      ],
      [
        'on publication, said only in a comment',
        page({ effective: null, changes: [`/* ${WITHOUT_NOTICE} */`] }),
        'takes effect on publication without §Changes saying so',
      ],
    ])('%s', (_, source, reason) => {
      expect(legalDatesProblem('p', source)).toContain(reason);
    });
  });
});

/* ── Browser storage, against the code that writes it ──────────────────────── */

type StorageKind = 'localStorage' | 'sessionStorage';

interface StorageWriter {
  /** Relative to `src/`. */
  file: string;
  kind: StorageKind | 'both' | null;
  keys: string[];
}

/**
 * Every source file that reaches for browser storage or declares a key for it.
 *
 * Found by reading the code rather than from a list, because a list is what
 * went stale: the policy named two keys while the app wrote eight.
 * The rules it reads by are deliberately plain, and the test below fails when
 * code steps outside them rather than letting a write go unseen:
 *
 *  - A file *uses* a storage when, comments aside, it says
 *    `window.localStorage` / `window.sessionStorage` or assigns one
 *    (`s=localStorage`, as the theme's inline bootstrap does).
 *  - A file *declares* a key as a `const …KEY = 'xecret.…'`, which is how all of
 *    them are written today.
 */
function storageWriters(): StorageWriter[] {
  const src = join(import.meta.dirname, '..');
  const files = readdirSync(src, { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => !file.endsWith('.d.ts'));

  const writers: StorageWriter[] = [];
  for (const file of files) {
    const code = readFileSync(join(src, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    const local = /\bwindow\.localStorage\b|=\s*localStorage\b/.test(code);
    const session = /\bwindow\.sessionStorage\b|=\s*sessionStorage\b/.test(code);
    const keys = [...code.matchAll(/const\s+[A-Z_]*KEY\s*=\s*'(xecret\.[^']+)'/g)].map(
      (match) => match[1] ?? '',
    );
    if (!local && !session && keys.length === 0) continue;
    const kind =
      local && session ? 'both' : local ? 'localStorage' : session ? 'sessionStorage' : null;
    writers.push({ file: file.replace(/\\/g, '/'), kind, keys });
  }
  return writers;
}

/** The part of the privacy policy's storage section that lists one kind of storage. */
function disclosedUnder(kind: StorageKind): string {
  const prose = (PROSE.get('privacy') ?? '').replace(/\s+/g, ' ');
  const start = prose.indexOf("id: 'cookies'");
  const rest = prose.slice(start + 1);
  const end = rest.search(/id: '[a-z-]+'/);
  const section = end < 0 ? rest : rest.slice(0, end);

  const local = section.search(/In <code[^>]*>localStorage<\/code>/);
  const session = section.search(/In <code[^>]*>sessionStorage<\/code>/);
  if (local < 0 || session < 0 || session < local) return '';
  return kind === 'localStorage' ? section.slice(local, session) : section.slice(session);
}

describe('the privacy policy names everything the app keeps in browser storage', () => {
  // Not a number from the engine, but the same failure: a sentence written by
  // hand about something the code decides. On a product whose vault keys can
  // sit in a tab's storage, "what is kept on your device" is the disclosure a
  // security reviewer reads first, and the one that went stale.
  const writers = storageWriters();

  it('finds the keys the app exports, so a broken scan cannot pass for an empty one', () => {
    const found = writers.flatMap((writer) => writer.keys);
    for (const key of [
      THEME_STORAGE_KEY,
      SIDEBAR_STORAGE_KEY,
      PROJECT_VIEW_STORAGE_KEY,
      UNLOCK_NUDGE_KEY,
      DEVICE_PIN_WRAP_KEY,
      VAULT_SESSION_MIRROR_KEY,
    ]) {
      expect(found, `the scan missed ${key}`).toContain(key);
    }
  });

  it('can tell, for every file, which storage its keys are in', () => {
    for (const writer of writers) {
      expect(writer.kind, `${writer.file} declares a storage key but touches no storage`).not.toBe(
        null,
      );
      expect(
        writer.kind,
        `${writer.file} uses both storages; split it, or teach this test`,
      ).not.toBe('both');
      expect(
        writer.keys.length,
        `${writer.file} uses storage under no key constant`,
      ).toBeGreaterThan(0);
    }
  });

  it('names every key, under the storage it is kept in', () => {
    const local = disclosedUnder('localStorage');
    const session = disclosedUnder('sessionStorage');
    expect(local, 'no "In localStorage" list before an "In sessionStorage" one').not.toBe('');
    expect(session, 'no "In sessionStorage" list').not.toBe('');

    for (const writer of writers) {
      for (const key of writer.keys) {
        const right = writer.kind === 'sessionStorage' ? session : local;
        const wrong = writer.kind === 'sessionStorage' ? local : session;
        expect(
          right,
          `${writer.file} writes ${key}, which the policy does not name there`,
        ).toContain(`>${key}</code>`);
        expect(wrong, `the policy lists ${key} under the wrong storage`).not.toContain(
          `>${key}</code>`,
        );
      }
    }
  });
});
