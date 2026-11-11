import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MINIMUM_SEATS, PLANS } from '@xecret/core/entitlements';
import type { PlanFeatures } from '@xecret/core/entitlements';
import {
  NOT_YET,
  PLAN_COMPARISON,
  PRICING_FAQ,
  seatFloorCaveat,
} from '@/components/plans/pricing-content';
import type { MatrixRow, PricingFaqId } from '@/components/plans/pricing-content';
import {
  billingChoiceFromQuery,
  billingTerm,
  COMPARISON_COLUMNS,
  comparisonFor,
  ENTERPRISE_CAVEAT,
  ENTERPRISE_PRICE,
  FREE_PRICE,
  nextCeiling,
  pastTheAllowance,
  PLAN_OFFERS,
  PURCHASE_FAQ,
  switchPlanHref,
  USD_PRICES,
  YEARLY_SAVING_UP_TO,
  yearlySaving,
} from './upgrade-plans';
import type { OfferPlanId, PaidPlanId } from './upgrade-plans';

/**
 * The in-app plans page against the public pricing page, the engine, and the
 * server that enforces the engine.
 *
 * ── What is shared, and what is still cross-checked ──
 * The comparison table and the FAQ are one module now
 * (`components/plans/pricing-content.ts`), rendered by both pages. Checking
 * this page's rows against `/pricing`'s cell by cell, as this file used to by
 * parsing `pricing/page.tsx`, would compare the module with itself — so those
 * checks are gone, replaced by direct imports and by asserting that the pricing
 * page really does render the module and keeps no rows or questions of its
 * own.
 *
 * The prices are not shared: the pricing page keeps its five currency sheets
 * beside the CSS that reveals them, and a `page.tsx` exports only what Next
 * allows. So this page restates the US-dollar figures, and this file still
 * reads `pricing/page.tsx` and fails the moment the two say different things —
 * on the cards, in the table header, and in the shared answers that quote a
 * price written in a sheet the module cannot see.
 *
 * ── Why the server is read ──
 * A tick is only worth drawing if the server refuses the capability without
 * the plan, which only the route handlers can say — so they are read for the
 * `requireFeature` behind every flag the shared table ticks from `PLANS`.
 */

const SRC = join(import.meta.dirname, '..', '..', '..');
const PRICING = readFileSync(join(SRC, 'app', 'pricing', 'page.tsx'), 'utf8');

/**
 * Source with its commentary removed, so a comment can neither satisfy a
 * positive check (a commented-out `requireFeature` is not a gate) nor trip a
 * negative one (the server explaining a flag is not reading it). Block
 * comments, and line comments wherever they start — except after a `:`, so
 * the `//` in a URL survives.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every non-test module that can refuse a request — the route handlers and the server — as code. */
const SERVER = [join(SRC, 'app', 'api'), join(SRC, 'server')]
  .flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => withoutComments(readFileSync(join(root, file), 'utf8'))),
  )
  .join('\n');

/** Whether some route refuses the request without `feature` on the plan. */
function gated(feature: keyof PlanFeatures): boolean {
  return new RegExp(`requireFeature\\(\\s*[\\w.]+,\\s*'${feature}'`).test(SERVER);
}

/** One plan's dollar sheet on the pricing page, split into its two periods. */
function pricingSheet(id: PaidPlanId | 'free' | 'enterprise'): { monthly: string; yearly: string } {
  const card = PRICING.slice(PRICING.indexOf(`id: '${id}'`));
  const usd = card.slice(card.indexOf('usd:'), card.indexOf('eur:'));
  if (usd.length === 0) throw new Error(`no USD sheet for ${id} — this anchor needs updating`);
  return {
    monthly: usd.slice(usd.indexOf('monthly:'), usd.indexOf('yearly:')),
    yearly: usd.slice(usd.indexOf('yearly:')),
  };
}

const PAID: readonly PaidPlanId[] = ['pro', 'team'];
const HOSTED = ['free', 'pro', 'team', 'enterprise'] as const;

function offer(id: OfferPlanId) {
  const found = PLAN_OFFERS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no offer for ${id}`);
  return found;
}

const ROWS: readonly MatrixRow[] = PLAN_COMPARISON.flatMap((group) => group.rows);

function row(label: string): MatrixRow {
  const found = ROWS.find((candidate) => candidate.label === label);
  if (found === undefined) throw new Error(`"${label}" is no longer a row of the shared table`);
  return found;
}

function question(id: PricingFaqId) {
  const found = PRICING_FAQ.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no question ${id}`);
  return found;
}

/** Every sentence this page's own cards put on the page. */
const COPY = PLAN_OFFERS.flatMap((o) => [o.name, o.audience, o.caveat ?? '', ...o.features]).join(
  '\n',
);

describe('the prices agree with the pricing page', () => {
  it.each(PAID)('%s, monthly', (id) => {
    const ours = USD_PRICES[id].monthly;
    const theirs = pricingSheet(id).monthly;

    expect(theirs).toContain(`price: '${ours.price}'`);
    expect(theirs).toContain(`unit: '${ours.unit}'`);
    expect(ours.note).toBeNull();
    // The number the saving is computed from is the figure printed.
    expect(ours.price).toBe(`$${ours.perMemberMonth}`);
  });

  it.each(PAID)('%s, yearly — the figure, the unit and the yearly total', (id) => {
    const ours = USD_PRICES[id].yearly;
    const theirs = pricingSheet(id).yearly;

    expect(theirs).toContain(`price: '${ours.price}'`);
    expect(theirs).toContain(`amount: '${ours.perMemberMonth}'`);
    expect(theirs).toContain(`unit: '${ours.unit}'`);
    expect(theirs).toContain(`note: '${ours.note}'`);
  });

  it('Free', () => {
    const theirs = pricingSheet('free').monthly;
    expect(theirs).toContain(`price: '${FREE_PRICE.price}'`);
    expect(theirs).toContain(`unit: '${FREE_PRICE.unit}'`);
  });

  it('Enterprise, at the head of its column', () => {
    for (const period of ['monthly', 'yearly'] as const) {
      const theirs = pricingSheet('enterprise')[period];
      expect(theirs).toContain(`price: '${ENTERPRISE_PRICE.price}'`);
      expect(theirs).toContain(`unit: '${ENTERPRISE_PRICE.unit}'`);
    }
  });

  it('says "save up to" the same percentage as the dollar sheet', () => {
    const block = /const YEARLY_SAVING[^=]*=\s*\{([\s\S]*?)\};/.exec(PRICING)?.[1] ?? '';
    const usd = /usd: (\d+)/.exec(block)?.[1];
    expect(usd, 'YEARLY_SAVING.usd could not be read out of the pricing page').toBeDefined();
    expect(YEARLY_SAVING_UP_TO).toBe(Number(usd));
  });

  it.each(PAID)('never claims %s saves more than it does', (id) => {
    const { monthly, yearly } = USD_PRICES[id];
    const exact = ((monthly.perMemberMonth - yearly.perMemberMonth) * 100) / monthly.perMemberMonth;
    expect(yearlySaving(id)).toBeLessThanOrEqual(exact);
    expect(yearlySaving(id)).toBeGreaterThan(exact - 1);
  });

  it('states the seat floors the engine bills from, in the pricing page’s words', () => {
    // One helper for both pages now, so agreement is by construction; what is
    // pinned is that it is the helper, and what it says.
    expect(offer('team').caveat).toBe(seatFloorCaveat(MINIMUM_SEATS.team));
    expect(offer('team').caveat).toBe(`Billed from ${MINIMUM_SEATS.team} members up`);
    expect(offer('free').caveat).toBeNull();
    expect(offer('pro').caveat).toBeNull();
    expect(ENTERPRISE_CAVEAT).toBe(`Billed from ${MINIMUM_SEATS.enterprise} members up`);
  });

  it('marks Team recommended, as the pricing page does', () => {
    const team = PRICING.slice(PRICING.indexOf("id: 'team'"));
    expect(team.slice(0, team.indexOf('priceCaveat'))).toContain('recommended: true');
    expect(PLAN_OFFERS.filter((candidate) => candidate.recommended).map((o) => o.id)).toEqual([
      'team',
    ]);
  });

  /**
   * The shared answer about the annual price quotes figures that live in the
   * pricing page's dollar sheet, which the module cannot import. Every version
   * of it — no-payments, payments-live, and this page's — is held to the sheet.
   */
  it('quotes the dollar sheet in every answer about the annual price', () => {
    const entry = question('annual-price');
    const total = (id: PaidPlanId) => /^(\$\d+)/.exec(USD_PRICES[id].yearly.note ?? '')?.[1];
    const answers = [entry.answer, entry.whenPaymentsLive?.answer, entry.inApp?.answer];

    for (const answer of answers) {
      expect(answer).toContain(`Pro is ${USD_PRICES.pro.yearly.price} a member a month`);
      expect(answer).toContain(`Team is ${USD_PRICES.team.yearly.price}`);
      expect(answer).toContain(`charged as ${total('pro')} and ${total('team')} a member a year`);
    }
    expect(entry.inApp?.answer).toContain(
      `against ${USD_PRICES.pro.monthly.price} and ${USD_PRICES.team.monthly.price} month to month`,
    );
  });

  it('quotes the SAML add-on at the price its band publishes', () => {
    const usd = /name: 'SAML single sign-on',\s*prices: \{ usd: '([^']+)'/.exec(PRICING)?.[1];
    expect(usd, 'the SAML add-on price could not be read out of the pricing page').toBeDefined();
    expect(question('single-sign-on').answer).toContain(`${usd} per connection per month`);
  });
});

describe('the pricing page renders the shared table and questions', () => {
  const code = withoutComments(PRICING);

  it('imports both from the shared module and draws them', () => {
    expect(code).toMatch(
      /import \{[^}]*\bPLAN_COMPARISON\b[^}]*\bPRICING_FAQ\b[^}]*\} from '@\/components\/plans\/pricing-content';/,
    );
    expect(code).toContain('PLAN_COMPARISON.map((group)');
    expect(code).toContain('PRICING_FAQ.map((item)');
  });

  it('keeps no rows or questions of its own', () => {
    // A row or a question written into the page again would be one only the
    // pricing page shows — the reduced-copy arrangement the module replaced.
    expect(code, 'the pricing page has a matrix of its own again').not.toMatch(/\bconst MATRIX\b/);
    expect(code, 'the pricing page has an FAQ of its own again').not.toMatch(/\bconst FAQ\b/);
    expect(code, 'a matrix row is written in the page').not.toMatch(/^\s+hint: ['`]/m);
    expect(code, 'an FAQ entry is written in the page').not.toMatch(/^\s+question: ['`]/m);
  });
});

describe('every claim is one the product keeps', () => {
  it('reads the limits on the cards from the engine', () => {
    const { free, pro, team } = {
      free: PLANS.free.limits,
      pro: PLANS.pro.limits,
      team: PLANS.team.limits,
    };

    expect(offer('free').features).toContain(
      `${free.environmentsPerProject} environments per project`,
    );
    expect(offer('free').features).toContain(`${free.seats} members`);
    expect(offer('free').features).toContain(`${free.serviceTokens} service tokens for CI`);
    expect(offer('free').features).toContain(`${free.auditRetentionDays} days of audit history`);

    expect(offer('pro').features).toContain(
      `${pro.projects} projects across ${pro.organizations} organisations`,
    );
    expect(offer('pro').features).toContain(`${pro.auditRetentionDays} days of audit history`);
    expect(offer('team').features).toContain(`${team.serviceTokens} service tokens for CI`);
    expect(offer('team').features).toContain(`${team.auditRetentionDays} days of audit history`);

    for (const id of ['free', 'pro', 'team'] as const) {
      expect(offer(id).includedFetches).toBe(PLANS[id].limits.includedFetchesPerMonth);
    }
  });

  it('calls Pro unlimited on members while the engine leaves it uncapped — and nothing more', () => {
    expect(PLANS.pro.limits.seats).toBeNull();
    expect(offer('pro').features).toContain('Unlimited members');
  });

  it('puts each capability bullet on a plan whose flags carry it', () => {
    const proAdds: (keyof PlanFeatures)[] = [
      'secretReferencing',
      'personalOverrides',
      'environmentPromotion',
      'pointInTimeRestore',
    ];
    for (const feature of proAdds) {
      expect(PLANS.free.features[feature], feature).toBe(false);
      expect(PLANS.pro.features[feature], feature).toBe(true);
    }
    expect(offer('pro').features).toContain(
      'Secret referencing, overrides, promotion and point-in-time restore',
    );

    for (const feature of ['secretPolicy', 'disableEnvExport'] as const) {
      expect(PLANS.pro.features[feature], feature).toBe(false);
      expect(PLANS.team.features[feature], feature).toBe(true);
    }
    expect(offer('team').features).toContain('A secret policy for names and values');
    expect(offer('team').features).toContain('Plaintext export switched off per environment');
  });

  /**
   * The rows whose ticks the shared table reads from `PLANS`, each one a flag
   * the server refuses without the plan. Listed, so a row that loses its flag
   * — and goes back to hand-written cells — fails here rather than drifting.
   */
  const FLAGGED: Readonly<Record<string, keyof PlanFeatures>> = {
    'Secret referencing and environment inheritance': 'secretReferencing',
    'Personal local overrides': 'personalOverrides',
    'Environment promotion, with a diff': 'environmentPromotion',
    'Point-in-time restore': 'pointInTimeRestore',
    'A secret policy for names and values': 'secretPolicy',
    'Plaintext export switched off per environment': 'disableEnvExport',
    'Custom roles': 'customRoles',
    'Token IP allowlists and lifetime policy': 'tokenIpAllowlist',
    'Alerts on reads from new addresses': 'newIpReadAlerts',
  };

  it('ticks a flag only where a route refuses it without the plan', () => {
    expect(
      Object.fromEntries(
        ROWS.filter((r) => r.feature !== undefined).map((r) => [r.label, r.feature]),
      ),
    ).toEqual(FLAGGED);
    for (const feature of Object.values(FLAGGED)) {
      expect(gated(feature), `${feature} has no requireFeature behind it`).toBe(true);
    }
    // The one ceiling-shaped row: refused at the plan's webhook ceiling.
    expect(SERVER).toMatch(/requireCapacity\(\s*\w+,\s*'webhooks'/);
  });

  it('reads every flagged tick from the engine', () => {
    for (const [label, feature] of Object.entries(FLAGGED)) {
      for (const plan of HOSTED) {
        expect(row(label).values[plan], `${label} on ${plan}`).toBe(PLANS[plan].features[feature]);
      }
    }
    for (const plan of HOSTED) {
      expect(row('Webhooks on secret change').values[plan], `webhooks on ${plan}`).toBe(
        PLANS[plan].limits.webhooks !== 0,
      );
    }
  });

  /**
   * Every row that ticks a hosted plan and dashes another is a plan boundary —
   * a reason to pay. Each is one the server holds, or one named here with why
   * it is not. A new boundary row with neither fails until it is one or the
   * other.
   */
  it('draws no plan boundary that is neither enforced nor accounted for', () => {
    const UNGATED: Readonly<Record<string, string>> = {
      'Roles for members': 'the open per-environment decision — see the note in upgrade-plans.ts',
      'Per-project and per-environment grants':
        'the open per-environment decision — see the note in upgrade-plans.ts',
      'Runs on your own infrastructure': 'a contract term — the commercial self-hosting licence',
      'Webhooks on secret change': 'a ceiling, refused by requireCapacity at the plan’s limit',
    };

    const boundaries = ROWS.filter((r) => {
      const cells = HOSTED.map((plan) => r.values[plan]);
      return cells.includes(true) && cells.includes(false);
    });
    for (const boundary of boundaries) {
      if (boundary.feature !== undefined) {
        expect(gated(boundary.feature), boundary.label).toBe(true);
      } else {
        expect(UNGATED, `"${boundary.label}" is a plan boundary nothing enforces`).toHaveProperty([
          boundary.label,
        ]);
      }
    }
    // And no exception outlives its row.
    for (const label of Object.keys(UNGATED)) {
      expect(boundaries.map((b) => b.label)).toContain(label);
    }
  });

  /**
   * The engine names these and nobody has built them, so `PLANS` grants them
   * and the table must not: every column reads a dash or "Coming soon". The
   * last assertion is a tripwire — a gate appearing means somebody built one,
   * and its row is what to revisit.
   */
  it('ticks no capability the engine names but nobody has built', () => {
    const UNBUILT: Readonly<Record<string, keyof PlanFeatures>> = {
      'Scheduled and expiring secrets': 'scheduledSecrets',
      'Change approvals': 'changeApprovals',
      'Break-glass emergency access': 'breakGlass',
      'Single sign-on with OIDC': 'oidcSso',
      'GitHub OIDC federation, with no static token': 'githubOidcFederation',
      'Audit streaming to a SIEM': 'siemStreaming',
    };
    for (const [label, feature] of Object.entries(UNBUILT)) {
      for (const [plan, cell] of Object.entries(row(label).values)) {
        expect(cell === false || cell === NOT_YET, `${label} on ${plan}: ${String(cell)}`).toBe(
          true,
        );
      }
      expect(gated(feature), `${feature} is gated now — revisit its row`).toBe(false);
      expect(Object.values(FLAGGED)).not.toContain(feature);
    }
  });

  /**
   * Per-environment access: `PLANS` gives it to Team and both pages sell it
   * there — the shared table's two rows and the shared Pro-or-Team answer —
   * but no route checks the flag, so every plan can grant it. The owner asked
   * for this page to say what `/pricing` says, so it does; the decision between
   * enforcing the gate and rewording the copy is still pending, and it is one
   * edit to the shared module whichever way it goes.
   *
   * The first three assertions are a tripwire, not a wish: when somebody adds
   * the gate they fail, and the note at the top of `upgrade-plans.ts` — and
   * this test — are what to revisit. Two shapes a gate could take are named:
   * a `requireFeature` refusing a write, and a read-side check written as a
   * plain read of the flag. The third is the net under both: the flag's name
   * appears nowhere in server code at all — not as a string, a property or a
   * destructured binding — so any gate, however written, trips it.
   */
  it('claims per-environment access only as /pricing does, while nothing enforces it', () => {
    const REVISIT =
      'perEnvironmentGrants is enforced now — revisit the note in upgrade-plans.ts and the rows in pricing-content.ts';
    expect(gated('perEnvironmentGrants'), REVISIT).toBe(false);
    expect(SERVER, REVISIT).not.toMatch(
      /\bfeatures\s*\??\.\s*perEnvironmentGrants\b|\bfeatures\s*\??\.?\s*\[\s*['"`]perEnvironmentGrants['"`]\s*\]/,
    );
    expect(SERVER, REVISIT).not.toMatch(/\bperEnvironmentGrants\b/);

    // The claim, where it is made: the shared rows, both shown on this page
    // whether or not it sells, and never ticked from the ungated flag.
    for (const label of ['Roles for members', 'Per-project and per-environment grants']) {
      const claim = row(label);
      expect(claim.feature, label).toBeUndefined();
      expect(
        HOSTED.map((plan) => claim.values[plan]),
        label,
      ).toEqual([false, false, true, true]);
      for (const selling of [true, false]) {
        expect(comparisonFor(selling).flatMap((g) => g.rows)).toContain(claim);
      }
    }
    expect(question('pro-or-team').answer).toContain('Team adds roles and per-environment grants');

    // The cards were not part of the request, and still make no such claim.
    expect(COPY).not.toMatch(/per-environment (access|grants)/i);
    expect(COPY).not.toMatch(/every environment/i);
    expect(COPY).not.toMatch(/out of production|must not see production/i);
  });

  /**
   * Custom roles are built and gated at Enterprise, and since 2026-11-08 both
   * pages say so: the shared row is ticked from `PLANS`, not marked "Coming
   * soon", and the pricing page's Enterprise card names them without the chip.
   */
  it('places custom roles where the engine gates them — included at Enterprise, on both pages', () => {
    expect(gated('customRoles')).toBe(true);
    expect(PLANS.team.features.customRoles).toBe(false);
    expect(PLANS.enterprise.features.customRoles).toBe(true);

    const customRoles = row('Custom roles');
    expect(customRoles.feature).toBe('customRoles');
    expect(HOSTED.map((plan) => customRoles.values[plan])).toEqual([false, false, false, true]);
    expect(Object.values(customRoles.values)).not.toContain(NOT_YET);

    const card = withoutComments(PRICING.slice(PRICING.indexOf("id: 'enterprise'")));
    expect(card.slice(0, card.indexOf('cta:'))).toContain("{ text: 'Custom roles' }");
    // This page's cards stop at Team, so they have no reason to name them.
    expect(COPY).not.toMatch(/custom roles/i);
  });

  it('mentions a trial if and only if the pricing page does', () => {
    const ours = [COPY, ...PURCHASE_FAQ.map((item) => item.answer)].join('\n');
    const theirs = [PRICING, ...PRICING_FAQ.map((item) => item.answer)].join('\n');
    expect(/\btrial\b/i.test(ours)).toBe(/\btrial\b/i.test(theirs));
  });
});

describe('the table this page shows', () => {
  const SALE_TERMS = [
    'Smallest billable team',
    'Cost per service token, CI runner or AI agent',
    'What happens past the allowance',
    'SAML single sign-on',
  ];

  /** True of xecret's hosted service, and false of an installation somebody else runs. */
  const HOSTED_SERVICE = [
    'Where your data sits',
    'Choose your data region',
    'Your own root key',
    'Runs on your own infrastructure',
    'Support channel',
    'SLA',
  ];

  it('shows the four plans an organisation on the hosted service can be on, in the pricing page’s order', () => {
    expect(COMPARISON_COLUMNS.map((column) => column.id)).toEqual(HOSTED);
    expect(COMPARISON_COLUMNS.map((column) => column.name)).toEqual(
      HOSTED.map((plan) => PLANS[plan].name),
    );
  });

  it('shows every group and every row of the shared table where it sells', () => {
    expect(comparisonFor(true)).toEqual(PLAN_COMPARISON);
  });

  it('leaves out the terms of a sale and the hosted service’s rows where nothing is sold', () => {
    expect(ROWS.filter((r) => r.sale === true).map((r) => r.label)).toEqual(SALE_TERMS);
    expect(ROWS.filter((r) => r.hosted === true).map((r) => r.label)).toEqual(HOSTED_SERVICE);
    const hidden = [...SALE_TERMS, ...HOSTED_SERVICE];
    const shown = comparisonFor(false).flatMap((group) => group.rows.map((r) => r.label));
    expect(shown).toEqual(ROWS.map((r) => r.label).filter((label) => !hidden.includes(label)));
    // 51 rows where it sells; 41 where it does not.
    expect([ROWS.length, shown.length]).toEqual([51, 41]);
  });

  it('keeps every gated capability and every per-plan limit where nothing is sold', () => {
    // What is left out is about money and the hosted service — never the
    // product: a row the engine ticks or counts stays.
    const shown = comparisonFor(false).flatMap((group) => group.rows);
    for (const flagged of ROWS.filter((r) => r.feature !== undefined)) {
      expect(shown, flagged.label).toContain(flagged);
    }
    for (const label of ['Organisations', 'Projects', 'Members', 'Audit history']) {
      expect(shown.map((r) => r.label)).toContain(label);
    }
  });

  it('carries the rows only this page used to have, for both pages now', () => {
    expect(row('Alerts on reads from new addresses').feature).toBe('newIpReadAlerts');
    expect(row('A secret policy for names and values').feature).toBe('secretPolicy');
    expect(row('Plaintext export switched off per environment').feature).toBe('disableEnvExport');
  });

  it('names the billing term under a paid plan’s figure, and none under the others', () => {
    expect(billingTerm('pro', 'yearly')).toBe('billed yearly');
    expect(billingTerm('team', 'monthly')).toBe('month to month');
    expect(billingTerm('free', 'yearly')).toBeNull();
    expect(billingTerm('enterprise', 'monthly')).toBeNull();
  });
});

describe('the questions this page asks', () => {
  it('asks every shared question, once', () => {
    const ids = PRICING_FAQ.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PURCHASE_FAQ.map((item) => item.id).sort()).toEqual([...ids].sort());
  });

  it('asks about paying first and self-hosting last', () => {
    expect(PURCHASE_FAQ.map((item) => item.id).slice(0, 2)).toEqual(['paying', 'annual-price']);
    expect(PURCHASE_FAQ.at(-1)?.id).toBe('self-hosting');
  });

  it('gives this page’s answer where there is one, and the payments-live one otherwise', () => {
    for (const item of PURCHASE_FAQ) {
      const shared = question(item.id);
      const expected = shared.inApp ?? shared.whenPaymentsLive ?? shared;
      expect(item.question).toBe(expected.question);
      expect(item.answer).toBe(expected.answer);
      // Shown only where something is sold, so nothing here may say otherwise.
      expect(item.answer, item.id).not.toMatch(
        /(billed|taken|collected) today|nothing is billed|no plan is billed|neither is billed|no card/,
      );
    }
  });

  it('adapts only the answers that describe the public page', () => {
    expect(
      PRICING_FAQ.filter((item) => item.inApp !== undefined)
        .map((item) => item.id)
        .sort(),
    ).toEqual(['annual-price', 'past-free', 'paying']);
    const annual = question('annual-price').inApp?.answer ?? '';
    // No currency sheets and no second price control on this page.
    expect(annual).not.toMatch(/sheet|controls above|comparison table/);
    expect(question('paying').inApp?.answer).toMatch(/^From this page, as an owner/);
    // Moving up past Free starts at this page's checkout, not the billing page.
    const pastFree = question('past-free');
    expect(pastFree.inApp?.answer).toContain('an owner can move up from this page');
    expect(pastFree.inApp?.answer).toBe(
      pastFree.whenPaymentsLive?.answer.replace('from the billing page', 'from this page'),
    );
    // The reader is signed in already.
    for (const item of PURCHASE_FAQ) {
      expect(item.answer, item.id).not.toMatch(/sign up|sign-up|create an account/i);
    }
  });
});

describe('what happens past the allowance', () => {
  const RATE = '$0.01 per 1,000 secret fetches past the allowance ($1 per 100,000)';

  it('says a paid plan bills it, at the rate it is handed', () => {
    for (const plan of PAID) {
      expect(pastTheAllowance(plan, { taken: true, overageRate: RATE })).toBe(
        `Fetches past it keep working, and are billed at ${RATE}.`,
      );
    }
  });

  it('says Free never bills it', () => {
    expect(pastTheAllowance('free', { taken: true, overageRate: RATE })).toBe(
      'Fetches past it keep working, and are not billed.',
    );
  });

  it('mentions no bill where the installation takes no payments', () => {
    for (const plan of ['free', 'pro', 'team'] as const) {
      expect(pastTheAllowance(plan, { taken: false, overageRate: RATE })).not.toMatch(/billed/);
    }
  });
});

describe('nextCeiling', () => {
  it('names the plan above at the plan’s own ceiling', () => {
    const freeProjects = PLANS.free.limits.projects;
    if (freeProjects === null) throw new Error('Free projects are uncapped — rewrite this case');
    expect(nextCeiling('free', 'projects', freeProjects)).toEqual({
      plan: 'pro',
      sentence: `Pro allows ${PLANS.pro.limits.projects}.`,
    });
    expect(nextCeiling('free', 'seats', 3)).toEqual({
      plan: 'pro',
      sentence: 'Pro has no limit on members.',
    });
  });

  it('measures against a ceiling support raised, never the plan default', () => {
    // An organisation on Free allowed 40 projects is not helped by Pro's 25.
    expect(nextCeiling('free', 'projects', 40)).toEqual({
      plan: 'team',
      sentence: `Team allows ${PLANS.team.limits.projects}.`,
    });
    // Nor by anything self-serve, past Team's own ceiling.
    expect(nextCeiling('free', 'projects', 500)).toBeNull();
  });

  it('names nothing above Team', () => {
    expect(nextCeiling('team', 'projects', 100)).toBeNull();
    expect(nextCeiling('enterprise', 'projects', 100)).toBeNull();
  });
});

describe('the billing screen opens on the choice made here', () => {
  it('carries the plan and the period', () => {
    expect(switchPlanHref('acme', 'team', 'monthly')).toBe(
      '/app/acme/settings/billing?plan=team&interval=monthly',
    );
  });

  it('reads them back, validated', () => {
    expect(billingChoiceFromQuery({ plan: 'team', interval: 'yearly' })).toEqual({
      plan: 'team',
      interval: 'yearly',
    });
    expect(billingChoiceFromQuery({ plan: 'pro' })).toEqual({ plan: 'pro' });
  });

  it('drops anything that is not a plan or a period anybody can buy', () => {
    expect(billingChoiceFromQuery({})).toEqual({});
    expect(billingChoiceFromQuery({ plan: 'enterprise', interval: 'weekly' })).toEqual({});
    expect(billingChoiceFromQuery({ plan: ['team', 'pro'], interval: ['yearly'] })).toEqual({});
    expect(billingChoiceFromQuery({ checkout: 'returned' })).toEqual({});
  });
});
