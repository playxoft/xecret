import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PLANS } from '@xecret/core/entitlements';

/**
 * The pricing page against the engine that enforces it.
 *
 * ── What this file is for ──
 * A secrets manager whose pricing page advertises a ceiling its server does not
 * hold will one day refuse a customer something they paid for, in the middle of
 * a deploy, with a receipt in hand. That is the most expensive kind of mistake
 * available to a product that holds credentials, and it is a mistake made by
 * editing one of two files.
 *
 * So the page reads its limits from `@xecret/core/entitlements` rather than
 * restating them, and this file asserts that the arrangement is still true —
 * that nobody has quietly inlined a number back into the page, and that the
 * published figures still say what the pricing plan says.
 *
 * ── Why it reads the source text ──
 * The page is a server component with marketing imports; rendering it here
 * would test the framework. What is worth pinning is narrower and is visible in
 * the source: which numbers are written down, and which are derived.
 */

const SOURCE = readFileSync(join(import.meta.dirname, 'page.tsx'), 'utf8');

/**
 * Just the `DESCRIPTION` constant.
 *
 * Narrowed out of `SOURCE` because the assertions about it are negative ones —
 * that it does not promise single sign-on, that it does not state a yearly rate
 * as monthly — and the page discusses both of those in the comment that
 * explains why. Matched against the whole file, the explanation would fail the
 * rule it documents.
 */
const DESCRIPTION_LINE = /const DESCRIPTION =\s*([\s\S]*?);\n/.exec(SOURCE)?.[1] ?? '';

describe('the page derives its limits rather than restating them', () => {
  it('imports the plan definitions the server enforces from', () => {
    expect(SOURCE).toContain("from '@xecret/core/entitlements'");
    expect(SOURCE).toContain('PLAN_DEFINITIONS');
  });

  it('builds every card limit from LIMITS, not from a literal', () => {
    // If this fails, somebody has written a ceiling into the page by hand. The
    // number they wrote may even be correct today; the point is that nothing
    // will tell them when it stops being.
    for (const field of [
      'organizations',
      'projects',
      'environmentsPerProject',
      'seats',
      'serviceTokens',
      'includedFetchesPerMonth',
      'auditRetentionDays',
    ] as const) {
      expect(SOURCE, `LIMITS.free.${field} is not read by the page`).toContain(
        `LIMITS.free.${field}`,
      );
    }
  });

  it('states the Free ceilings the engine actually enforces', () => {
    // Read from the same constants the page renders, so this asserts the
    // pricing plan's numbers rather than merely that two files agree.
    expect(PLANS.free.limits.organizations).toBe(1);
    expect(PLANS.free.limits.projects).toBe(5);
    expect(PLANS.free.limits.environmentsPerProject).toBe(3);
    expect(PLANS.free.limits.seats).toBe(1);
    expect(PLANS.free.limits.includedFetchesPerMonth).toBe(20_000);
  });
});

describe('the prices that are written down', () => {
  /**
   * Prices are deliberately *not* imported from the entitlements package — a
   * price is typography as much as data and varies by currency, where a limit
   * is a number with one correct value. So they are asserted here instead,
   * against `.local/plans/pricing-plan.md` §3.
   */
  const EXPECTED: readonly (readonly [string, string, string])[] = [
    ['pro', '$8', '$5'],
    ['team', '$19', '$12'],
  ];

  it.each(EXPECTED)('%s is %s monthly and %s yearly', (id, monthly, yearly) => {
    const block = SOURCE.slice(SOURCE.indexOf(`id: '${id}'`));
    const card = block.slice(0, block.indexOf('cta:'));

    expect(card).toContain(`price: '${monthly}'`);
    expect(card).toContain(`price: '${yearly}'`);
  });

  it('publishes the monthly figure as the structured-data amount', () => {
    // The page renders monthly before anybody touches the toggle, and an offer
    // that publishes a number the default render does not show is the same
    // defect as publishing the wrong one.
    for (const [id, monthly] of EXPECTED) {
      const block = SOURCE.slice(SOURCE.indexOf(`id: '${id}'`));
      expect(block.slice(0, block.indexOf('},\n  {'))).toContain(
        `amount: '${monthly.replace('$', '')}'`,
      );
    }
  });

  /**
   * The other three price sheets — pricing-plan.md §4.
   *
   * Asserted by value rather than derived, for the same reason as the USD ones:
   * these are deliberate numbers, not conversions, and a test that recomputed
   * them from an exchange rate would pass through exactly the change it exists
   * to catch.
   */
  const PPP: readonly (readonly [string, string, string, string])[] = [
    ['pro', '₹249', '¥900', 'A$13'],
    ['team', '₹599', '¥2,100', 'A$29'],
  ];

  it.each(PPP)('%s publishes a rupee, yen and Australian dollar price', (id, inr, jpy, aud) => {
    const block = SOURCE.slice(SOURCE.indexOf(`id: '${id}'`));
    const card = block.slice(0, block.indexOf('cta:'));

    for (const price of [inr, jpy, aud]) {
      expect(card, `${id} is missing ${price}`).toContain(`price: '${price}'`);
    }
  });

  it('every plan carries all four currencies', () => {
    for (const id of ['free', 'pro', 'team', 'enterprise', 'self-hosted']) {
      const block = SOURCE.slice(SOURCE.indexOf(`id: '${id}'`));
      const card = block.slice(0, block.indexOf('cta:'));
      for (const currency of ['usd:', 'inr:', 'jpy:', 'aud:']) {
        expect(card, `${id} has no ${currency} sheet`).toContain(currency);
      }
    }
  });

  it('India is priced well below the US sheet, not converted from it', () => {
    // ₹375 a month on the yearly rate against $12 is roughly a third, and under
    // the ₹400 line on the figure the page shows first. If this ever drifts
    // towards parity, somebody has replaced a price sheet with an exchange rate.
    expect(SOURCE).toContain("price: '₹375'");
  });

  it('yearly is about 37 per cent below monthly, as the plan says', () => {
    for (const [, monthly, yearly] of EXPECTED) {
      const m = Number(monthly.slice(1));
      const y = Number(yearly.slice(1));
      const saving = 1 - y / m;
      expect(saving).toBeGreaterThan(0.33);
      expect(saving).toBeLessThan(0.4);
    }
  });
});

describe('the honesty rules this page is built on', () => {
  it('still says that nothing is billed yet', () => {
    // Removed in the phase that connects a payment provider, and in no other.
    // Until then it is simply true, and it is what lets the page publish real
    // prices months before it can charge them.
    expect(SOURCE).toContain('nothing is billed');
  });

  it('marks unbuilt capabilities rather than omitting or claiming them', () => {
    expect(SOURCE).toContain("const NOT_YET = 'Coming soon'");
    // Every capability from the unbuilt phases wears it.
    for (const capability of [
      'Single sign-on with OIDC',
      'SAML single sign-on',
      'Directory sync (SCIM)',
      'Custom roles',
      'Change approvals',
      'Point-in-time restore',
    ]) {
      expect(SOURCE, `${capability} is not named on the page`).toContain(capability);
    }
  });

  it('distinguishes an add-on from a capability a plan does not carry', () => {
    // A dash means "your plan does not have this"; ADDON means "your plan can
    // have this, for a published price". Giving the first answer to a reader
    // entitled to the second is a lie by omission.
    expect(SOURCE).toContain("const ADDON = 'Add-on'");
  });

  it('publishes what the SAML add-on costs us, not only what it costs them', () => {
    // The most likely line on this page to be trimmed by somebody tidying
    // marketing copy, and the one that makes the "no SSO tax" claim checkable.
    expect(SOURCE).toContain('$125 per connection per month');
    expect(SOURCE).toContain('$199');
  });

  it('promises that billing never breaks a build', () => {
    expect(SOURCE).toContain('Billed, never blocked');
  });

  it('selects a currency from the request, and charges from the billing country', () => {
    // The header is a *default* and nothing more: every currency is in the
    // markup and the selector is pure CSS, so a VPN or a traveller costs one
    // click rather than a wrong price. What anyone is actually charged is
    // decided at checkout from their billing country and the card that pays.
    expect(SOURCE).toContain('CF-IPCountry');
    expect(SOURCE).toContain('CURRENCY_BY_COUNTRY');
    expect(SOURCE).toContain('never from a header a client can send');
  });

  it('falls back to dollars where there is no request', () => {
    // `headers()` throws at build time and in tests. A page that failed rather
    // than falling back would take the marketing site down for a missing header.
    expect(SOURCE).toContain('return DEFAULT_CURRENCY');
  });

  it('ships no JavaScript for the billing toggle', () => {
    // The one part of this page a reader is deciding on must not arrive after
    // hydration. A price that moves on its own is the last thing it can afford.
    // The directive, not the word: the file discusses `'use client'` in a
    // comment explaining why it does not use one, and a naive substring match
    // would fail on the very explanation that documents the rule.
    expect(SOURCE.trimStart().startsWith("'use client'")).toBe(false);
    expect(SOURCE.trimStart().startsWith('"use client"')).toBe(false);
    expect(SOURCE).not.toMatch(/useState\s*[(<]/);
  });
});

/**
 * The defects a review found, pinned so they cannot come back.
 *
 * Each of these existed on the page at review time and each was the same shape:
 * one fact rendered in two or three places, and only some of them reading the
 * field that decides it. A test that asserts the *arrangement* — one renderer,
 * one constant, one derivation — outlives a test that asserts today's string.
 */
describe('one fact, rendered in one place', () => {
  it('renders every plan bullet through the one component that reads notYet', () => {
    // The self-hosting band used to map `features` itself and emit an
    // unconditional tick, so `Single sign-on included` sat under a check while
    // the matrix said `Not yet` in the same column and the JSON-LD published
    // "(not built yet)" for the same bullet. Three renderings of one field and
    // only two of them read it.
    const callSites = SOURCE.match(/features\.map\(/g) ?? [];
    expect(callSites.length).toBeGreaterThan(0);

    // Every one of them delegates rather than rendering an icon itself.
    const rendersItsOwnIcon = /features\.map\(\((?:[^)]*)\)\s*=>\s*\([\s\S]{0,200}?<CheckIcon/.test(
      SOURCE,
    );
    expect(rendersItsOwnIcon, 'a feature list renders its own tick again').toBe(false);
    expect(SOURCE).toContain('function PlanFeatureItem(');
  });

  it('derives audit retention for every tier', () => {
    // One column used to carry the literal '1 year' while the others read the
    // engine, so that limit could move with every test still green — the one
    // failure the import exists to prevent.
    expect(SOURCE).toContain('function formatRetention(');
    // Every column whose cell states a duration reads it from the engine. The
    // Enterprise *card* says "Custom audit retention" instead of a figure —
    // a contract sets it — but the matrix row still publishes the default, and
    // that is the cell this is about.
    for (const tier of ['free', 'pro', 'team', 'enterprise'] as const) {
      expect(SOURCE, `${tier} audit retention is not derived`).toContain(
        `LIMITS.${tier}.auditRetentionDays`,
      );
    }
    expect(PLANS.enterprise.limits.auditRetentionDays).toBe(365);
  });

  /**
   * Scale was removed from the product, and the page is where its absence has
   * to be complete: a card, a matrix column, a `values` key and a price sheet
   * all named it, and leaving any one behind renders a column of `undefined`.
   */
  it('has no trace of the retired Scale tier', () => {
    expect(SOURCE).not.toMatch(/id: 'scale'/);
    expect(SOURCE).not.toMatch(/scale:/);
    expect(SOURCE).not.toContain('LIMITS.scale');
  });

  /**
   * Pro and Team publish numbers rather than "unlimited".
   *
   * The page said "Unlimited organisations, projects and environments" on Pro
   * while the engine now caps all three. A page that advertises no ceiling over
   * a server that holds one is the exact failure importing the limits exists to
   * prevent — it just fails in the generous direction, which is worse, because
   * the customer finds out mid-deploy with a receipt in hand.
   */
  it('states Pro and Team ceilings as numbers the engine holds', () => {
    for (const plan of ['pro', 'team'] as const) {
      for (const resource of [
        'organizations',
        'projects',
        'environmentsPerProject',
        'serviceTokens',
        'secretsPerEnvironment',
      ] as const) {
        expect(PLANS[plan].limits[resource], `${plan}.${resource}`).toBeTypeOf('number');
      }
    }

    expect(SOURCE).not.toContain('Unlimited organisations, projects and environments');
    expect(SOURCE).toContain('function limitRow(');
  });

  it('says that an unbuilt add-on is unbuilt, in the cells that price it', () => {
    // `Add-on` alone sold SAML to a Team customer today while the Enterprise
    // column on the same row read `Not yet` — the two answers inverted against
    // the tier ladder, on the capability this page charges $199 a month for.
    expect(SOURCE).toContain('const ADDON_NOT_YET');
    expect(SOURCE).not.toMatch(/team:\s*ADDON,/);
  });

  it('counts the FAQ rather than stating a number beside it', () => {
    expect(SOURCE).toContain('${FAQ.length}');
  });

  it('reads the Free ceilings into the prose that restates them', () => {
    // The FAQ and the closing band both named the free limits in words. Every
    // number was right on the day it was written and none was derived, so a
    // ceiling change left the cards correct and the prose lying.
    expect(SOURCE).not.toContain('create a sixth project');
    expect(SOURCE).not.toContain('Five projects, three environments each');
    expect(SOURCE).toContain('${LIMITS.free.projects} projects');
  });

  it('names the billing period wherever it names a yearly rate', () => {
    // $5 and $12 are yearly; the cards default to monthly. The title, the
    // description and the hero each stated one as the other, which is a rich
    // result advertising a price the page does not render.
    expect(DESCRIPTION_LINE).toContain('billed yearly');
    expect(SOURCE).not.toContain('Team is $12 per member per month');
  });

  it('does not promise single sign-on in the metadata it marks Not yet on the card', () => {
    expect(DESCRIPTION_LINE).not.toContain('single sign-on included');
  });
});
