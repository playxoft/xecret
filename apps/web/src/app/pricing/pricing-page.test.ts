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
 * The body of `pricingDescription`, which builds the meta description.
 *
 * Narrowed out of `SOURCE` because the assertions about it are negative ones —
 * that it does not promise single sign-on, that it does not state a yearly rate
 * as monthly — and the page discusses both of those in the comment that
 * explains why. Matched against the whole file, the explanation would fail the
 * rule it documents.
 *
 * It was a `const DESCRIPTION` until the string learned to follow the currency:
 * a fixed description quoting "$5" shipped above cards painting ₹149 once
 * `resolveInitialCurrency` landed, so it is composed per sheet now and this
 * reads the function that composes it.
 */
const DESCRIPTION_LINE = (() => {
  const at = SOURCE.indexOf('function pricingDescription(');
  if (at < 0) throw new Error('pricingDescription is gone — this anchor needs updating');
  const body = SOURCE.slice(at);
  return body.slice(0, body.indexOf('\n}'));
})();

/**
 * The stylesheet that drives the whole control.
 *
 * Read for the same reason the page is: the toggle, the currency menu and the
 * eight figures per card are a CSS mechanism, so the assertions that matter
 * about them are assertions about selectors. A rule that stops matching is a
 * card with no price on it, and nothing in TypeScript would notice.
 */
const GLOBALS = readFileSync(join(import.meta.dirname, '..', 'globals.css'), 'utf8');

/**
 * The two priced self-serve plans, and their USD figures.
 *
 * Prices are deliberately *not* imported from the entitlements package — a
 * price is typography as much as data and varies by currency, where a limit is
 * a number with one correct value. So they are asserted here instead, against
 * `.local/plans/pricing-plan.md` §3. Module scope because the yearly-default
 * suite needs them too.
 */
const EXPECTED: readonly (readonly [string, string, string])[] = [
  ['pro', '$8', '$5'],
  ['team', '$19', '$12'],
];

/** Just the ids, for the sheets that are priced in every currency. */
const PRICED = EXPECTED.map(([id]) => id as string);

/**
 * The sheets, read out of the page rather than listed here.
 *
 * Listing them meant that adding a sixth currency to `CURRENCIES` in
 * `page.tsx` — which TypeScript *does* force into `YEARLY_SAVING`, so it feels
 * covered — left both the saving recomputation and the CSS-reveal check
 * silently skipping it. A missing `.x-save-<new>` rule would then ship as a
 * toggle with no chip on that sheet and nothing would fail.
 */
const CURRENCIES = (() => {
  const block = /const CURRENCIES = \[([\s\S]*?)\] as const;/.exec(SOURCE)?.[1] ?? '';
  const ids = [...block.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1] as string);
  if (ids.length === 0) throw new Error('CURRENCIES could not be read out of page.tsx');
  return ids;
})();

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
    expect(PLANS.free.limits.seats).toBe(3);
    expect(PLANS.free.limits.includedFetchesPerMonth).toBe(20_000);
  });
});

describe('the prices that are written down', () => {
  it.each(EXPECTED)('%s is %s monthly and %s yearly', (id, monthly, yearly) => {
    const block = SOURCE.slice(SOURCE.indexOf(`id: '${id}'`));
    const card = block.slice(0, block.indexOf('cta:'));

    expect(card).toContain(`price: '${monthly}'`);
    expect(card).toContain(`price: '${yearly}'`);
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

  it('every plan carries every currency', () => {
    for (const id of ['free', 'pro', 'team', 'enterprise', 'self-hosted']) {
      const block = SOURCE.slice(SOURCE.indexOf(`id: '${id}'`));
      const card = block.slice(0, block.indexOf('cta:'));
      for (const currency of ['usd:', 'eur:', 'inr:', 'jpy:', 'aud:']) {
        expect(card, `${id} has no ${currency} sheet`).toContain(currency);
      }
    }
  });

  /**
   * The euro sheet is the only one priced *above* the dollar one.
   *
   * Not because Europe can afford more: prices there are quoted VAT-inclusive
   * at 19–27 per cent, and a sheet set from a 1.15 exchange rate is under water
   * the first time the rate moves. Asserted rather than assumed, because "round
   * it up a bit" is exactly the kind of decision that gets quietly normalised
   * back to parity by somebody tidying the numbers.
   */
  it('prices the euro sheet above the dollar one', () => {
    const team = SOURCE.slice(SOURCE.indexOf("id: 'team'"));
    const card = team.slice(0, team.indexOf('cta:'));

    expect(card).toContain("price: '€21'");
    expect(card).toContain("price: '€13'");
    expect(card).toContain('€156 per member, billed yearly');
  });

  /**
   * Add-ons go the other way, and the page says so.
   *
   * Each is a WorkOS connection billed to us in dollars at the same rate
   * everywhere, so these are the dollar figure converted rather than a sheet set
   * for the market — which means the euro add-on is *below* the dollar one while
   * the euro plan is above it. Two rules, both deliberate, both stated on the
   * page so a reader does not have to infer either.
   */
  it('converts the add-ons rather than pricing them per market', () => {
    expect(SOURCE).toContain("eur: '€185'");
    expect(SOURCE).toContain('Add-on prices are the same figure converted');
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
    // $5 and $12 are yearly. The title, the description and the hero each once
    // stated one as the other, which is a rich result advertising a price the
    // page does not render.
    //
    // The guard is on the *unqualified* claim, not on the substring: now that
    // the page opens on yearly the hero legitimately reads "Team is $12 per
    // member per month billed yearly", and a bare `not.toContain` on the first
    // half of that sentence failed the corrected copy along with the wrong.
    expect(DESCRIPTION_LINE).toContain('billed yearly');

    // Stated as "a rate is always qualified within a short window", not as two
    // negative lookaheads. The lookaheads rejected correct copy: the natural
    // monthly sentence "Team is $19 per member per month, or $12 billed
    // yearly" is true, but `(?! or)` sees the comma and fails it — so a future
    // reversion to a monthly default written with ordinary punctuation would
    // have tripped a guard that exists to catch the opposite mistake.
    for (const match of SOURCE.matchAll(/Team is (\$\d+) per member per month/g)) {
      const window = SOURCE.slice(match.index, match.index + 140);
      expect(window, `an unqualified Team rate: ${match[1]}`).toMatch(
        /billed yearly|month to month|, or \$\d+/,
      );
    }
  });

  it('does not promise single sign-on in the metadata it marks Not yet on the card', () => {
    expect(DESCRIPTION_LINE).not.toContain('single sign-on included');
  });
});

/**
 * The yearly default, and the saving it advertises.
 *
 * The page opens on the yearly rate, so three things have to agree with that
 * and not with each other: which radio carries `defaultChecked`, which figure
 * the structured data publishes, and what the chip beside the toggle claims.
 * Each was correct for the monthly default before it moved.
 */
/**
 * `indexOf`, but it fails rather than returning `-1`.
 *
 * Every assertion in this suite is positional, and `-1` is a number that
 * compares happily against every other number: `expect(-1).toBeLessThan(body)`
 * passes, and `slice(0, -1)` hands back a string that contains nothing anyone
 * is looking for. So a marker being *renamed* — the most likely way any of
 * this breaks — would leave the whole suite green while every price and every
 * saving chip on the page stopped resolving. That is the failure these tests
 * exist to catch, so the lookup itself has to be the thing that fails.
 */
/**
 * The same source with its commentary removed.
 *
 * Three assertions in this file have now been written, failed, and rewritten
 * because the page *explains* the thing they forbid: the docblock above
 * `productSchema` quotes the `priceCurrency: 'USD'` it replaced, and the
 * comment beside `billingDuration` names the `unitCode` it deliberately does
 * not emit. A negative assertion over raw source fails on its own
 * justification, which trains the next person to delete the comment.
 *
 * Line comments are stripped only where they begin a line, so the `//` in
 * `https://schema.org/InStock` survives.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function locate(marker: string): number {
  const at = SOURCE.indexOf(marker);
  expect(at, `\`${marker}\` is not in page.tsx — the test's anchor moved`).toBeGreaterThanOrEqual(
    0,
  );
  return at;
}

describe('the yearly rate is the one the page opens on', () => {
  it('checks the yearly radio and not the monthly one', () => {
    const yearly = SOURCE.slice(locate('id="billing-yearly"'));
    expect(yearly.slice(0, yearly.indexOf('/>'))).toContain('defaultChecked');

    const monthly = SOURCE.slice(locate('id="billing-monthly"'));
    expect(monthly.slice(0, monthly.indexOf('/>'))).not.toContain('defaultChecked');
  });

  it('keeps both billing inputs ahead of the body they reach into', () => {
    // `~` only reaches forward. If either input is moved after
    // `.x-billing-body`, every price and every saving chip on the page stops
    // resolving — a failure that renders as a card with no price at all.
    const body = locate('className="x-billing-body"');
    expect(locate('id="billing-monthly"')).toBeLessThan(body);
    expect(locate('id="billing-yearly"')).toBeLessThan(body);
    expect(locate('x-cur-${currency.id}')).toBeLessThan(body);
  });

  it('publishes the yearly figure as the structured-data amount', () => {
    // Follows the default. An offer that publishes a number the default render
    // does not show is the same defect as publishing the wrong one.
    //
    // Read off the USD *sheet*, not the plan: the plan-level `amount` used to
    // carry this figure too, `productSchema` stopped reading it, and an
    // assertion that sliced the whole plan was satisfied by either — so a stale
    // plan-level value could not fail it.
    for (const [id, , yearly] of EXPECTED) {
      const card = SOURCE.slice(locate(`id: '${id}'`));
      const sheet = card.slice(card.indexOf('usd: {'));
      const yearlyBlock = sheet.slice(sheet.indexOf('yearly:'));
      expect(yearlyBlock.slice(0, yearlyBlock.indexOf('},'))).toContain(
        `amount: '${yearly.replace('$', '')}'`,
      );
    }
  });

  it('keeps no plan-level amount on a plan whose price varies by sheet', () => {
    // `'0'` and `null` are the only legitimate values: the same in every
    // currency, or no price at all. A priced plan carrying one is a field that
    // looks like the place to edit the rate and changes nothing when you do.
    for (const id of PRICED) {
      const card = SOURCE.slice(locate(`id: '${id}'`));
      const plan = card.slice(0, card.indexOf('},\n  {'));
      const planLevel = /\n {4}amount: ([^,\n]+),/.exec(plan)?.[1];
      expect(planLevel, `${id} still carries a dead plan-level amount`).toBeUndefined();
    }
  });

  it('carries a machine amount beside every yearly price, in every sheet', () => {
    // The structured data follows the rendered currency, so each sheet needs a
    // bare number of its own. Written beside the display string rather than
    // extracted from it — `'₹1,317'` is typography — and checked against it
    // here so the two cannot drift.
    for (const id of PRICED) {
      const block = SOURCE.slice(locate(`id: '${id}'`));
      const card = block.slice(0, block.indexOf('audience:'));

      for (const currency of CURRENCIES) {
        const sheet = card.slice(card.indexOf(`${currency}: {`));
        const yearly = sheet.slice(sheet.indexOf('yearly:'));
        const shown = /price: '([^']+)'/.exec(yearly)?.[1] ?? '';
        const machine = /amount: '([^']+)'/.exec(yearly)?.[1] ?? '';

        expect(machine, `${id}/${currency} yearly has no amount`).not.toBe('');
        expect(
          machine,
          `${id}/${currency} publishes ${machine} while the card paints ${shown}`,
        ).toBe(shown.replace(/[^0-9.]/g, ''));
      }
    }
  });

  it('says the published rate needs an annual term', () => {
    // The figure is a per-month price that can only be bought twelve at a
    // time. `unitText` alone reads as monthly-purchasable to a shopping
    // surface, which is the difference between an accurate rich result and a
    // complaint.
    const schema = withoutComments(SOURCE.slice(locate('function productSchema(')));

    // In the unit string, where it cannot be misparsed. Both spellings of
    // `billingDuration` were wrong — `12` + `unitCode: 'MON'` redefines the
    // reference quantity and fights `unitText`, and `'P1Y'` means "$5 covers
    // the year", a twelvefold understatement of the $60 actually charged — and
    // Google documents neither for `Offer`, so the disclosure never landed.
    expect(schema).toContain('billed annually');
    expect(schema, 'billingDuration is back; read the note beside it').not.toContain(
      'billingDuration',
    );
    expect(schema, 'unitCode is back, and it fights unitText').not.toContain('unitCode');
  });

  it('states the billing term in the comparison header, not just on the cards', () => {
    // The cards carry a third line naming the annual total; the table header
    // deliberately does not, because a header that grew a line on toggle would
    // shift the whole table. With yearly as the opening state that left a
    // reader who deep-links to `#compare` looking at "$12 per member, per
    // month" for a rate that cannot be bought by the month — and the caption
    // that explains the control is `sr-only`. Both periods carry a term line
    // now, which is what keeps the heights equal.
    const header = withoutComments(SOURCE.slice(locate('function HeaderPrice(')));
    expect(header).toContain('term');

    const usage = withoutComments(SOURCE.slice(locate('<HeaderPrice')));
    expect(usage).toContain("'month to month'");
    expect(usage).toContain("'billed yearly'");
  });

  it('builds the metadata from the sheet the page opened on', () => {
    // A static `metadata` export quoting "$5" shipped above cards painting
    // ₹149 once the body and the JSON-LD both followed `CF-IPCountry` — the two
    // strings a search result actually shows were the last USD holdout.
    const code = withoutComments(SOURCE);
    expect(code).toContain('export async function generateMetadata()');
    expect(code).toContain('await resolveInitialCurrency()');
    expect(code, 'metadata is a static export again').not.toMatch(/export const metadata\s*[:=]/);

    // And built from the plan data rather than retyped, so a sheet change
    // cannot leave the title quoting last month's price.
    const body = SOURCE.slice(locate('function pricingDescription('));
    expect(body.slice(0, body.indexOf('\n}'))).toContain('.yearly.price');
  });

  it('publishes the seat floor as a field, not only as prose', () => {
    // `Offer.description` mentions it, but a consumer reading the offer
    // structurally saw `price: '12'` with no floor — which is how a two-person
    // team computes $288 and is invoiced $432. `eligibleQuantity.minValue` is
    // the schema.org field for "this price applies from N units up".
    const schema = withoutComments(SOURCE.slice(locate('function productSchema(')));
    expect(schema).toContain('eligibleQuantity');
    expect(schema).toContain('minValue');
    expect(schema).toContain('minimumSeats(plan.id)');
  });

  it('publishes the currency the page actually opened on', () => {
    // Pinned to USD, this was wrong on four sheets out of five: a visitor in
    // Bengaluru was served ₹149 with `priceCurrency: 'USD'` underneath it.
    expect(SOURCE).toContain('productSchema(initialCurrency)');

    // Read from the code, not the commentary: the docblock above
    // `productSchema` quotes the old `priceCurrency: 'USD'` to explain why it
    // is gone, and a match over the whole source fails on the explanation.
    const body = withoutComments(SOURCE);
    const assignments = [...body.matchAll(/priceCurrency: ([^,\n]+)/g)].map((m) => m[1]);
    expect(assignments.length, 'no priceCurrency is published at all').toBeGreaterThan(0);
    for (const value of assignments) {
      expect(value, 'priceCurrency is hard-coded again').toBe('code');
    }
  });

  it('advertises a saving every sheet actually delivers', () => {
    // `YEARLY_SAVING` is written down rather than computed, because the page's
    // rule is that a published number is never parsed back out of a display
    // string. This recomputes it from the prices anyway and fails if the two
    // disagree — parsing in a test is safe in the way parsing at render is not.
    const declared = /const YEARLY_SAVING[^=]*= \{([\s\S]*?)\n\};/.exec(SOURCE)?.[1] ?? '';
    expect(declared, 'YEARLY_SAVING is not declared').not.toBe('');

    const amount = (price: string) => Number(price.replace(/[^0-9.]/g, ''));

    for (const currency of CURRENCIES) {
      // `String.raw` because this is a template literal: written plainly, the
      // `\s` and `\d` would reach `RegExp` as a bare `s` and `d` and quietly
      // match nothing, which reads as "no saving declared" rather than as the
      // typo it is.
      const claimed = Number(new RegExp(String.raw`${currency}:\s*(\d+)`).exec(declared)?.[1]);
      expect(claimed, `${currency} has no declared saving`).toBeGreaterThan(0);

      const savings = PRICED.map((id) => {
        const block = SOURCE.slice(SOURCE.indexOf(`id: '${id}'`));
        const card = block.slice(0, block.indexOf('audience:'));
        const sheet = card.slice(card.indexOf(`${currency}: {`));
        const [monthly, yearly] = [...sheet.matchAll(/price: '([^']+)'/g)].map((m) =>
          amount(m[1] ?? ''),
        );
        expect(monthly, `${id}/${currency} monthly is unreadable`).toBeGreaterThan(0);
        expect(yearly, `${id}/${currency} yearly is unreadable`).toBeGreaterThan(0);
        return (1 - (yearly as number) / (monthly as number)) * 100;
      });

      // The chip says "up to", so it must be an upper bound on every card
      // under it — and a floored one, so it is not rounded up past the truth.
      const best = Math.max(...savings);
      expect(claimed, `${currency} claims more than any plan saves`).toBeLessThanOrEqual(
        Math.ceil(best),
      );
      expect(claimed, `${currency} undersells its own best rate`).toBe(Math.floor(best));
    }
  });

  it('shows exactly one saving chip, chosen by the same radios as the prices', () => {
    // Hidden by default and revealed per currency, so the reveal is one
    // selector list rather than four overrides fighting each other.
    //
    // Not a no-CSS fallback, which an earlier version of this comment claimed:
    // `.x-save { display: none }` is in the same stylesheet, so if it never
    // loads the label renders all five chips at once — "Yearly Save up to 37%
    // Save up to 38% …". The same inversion was in the `.x-price` note and is
    // corrected there too.
    expect(GLOBALS).toMatch(/\.x-save\s*\{\s*display:\s*none/);
    for (const currency of CURRENCIES) {
      expect(GLOBALS, `${currency} has no reveal rule`).toContain(
        `.x-cur-${currency}:checked ~ .x-billing-body .x-save-${currency}`,
      );
    }
  });

  it('has a reveal rule for every price and add-on figure, on every sheet', () => {
    // The chip rules were guarded and the *price* rules were not, which had the
    // severity backwards. Adding a sixth sheet would have failed only on the
    // missing chip — and a developer who fixed just that would ship a currency
    // whose cards and table header render no price at all, which is strictly
    // worse than a toggle with no percentage on it.
    expect(GLOBALS).toMatch(/\.x-price\s*\{\s*display:\s*none/);

    for (const currency of CURRENCIES) {
      for (const period of ['monthly', 'yearly'] as const) {
        expect(GLOBALS, `${currency}/${period} prices have no reveal rule`).toContain(
          `.x-cur-${currency}:checked ~ .x-billing-${period}:checked ~ ` +
            `.x-billing-body .x-price-${currency}-${period}`,
        );
      }

      // The add-on band switches currency but not period, so it has its own
      // shorter chain and its own way of going missing.
      expect(GLOBALS, `${currency} add-on prices have no reveal rule`).toContain(
        `.x-cur-${currency}:checked ~ .x-billing-body .x-addon-${currency}`,
      );
    }
  });
});
