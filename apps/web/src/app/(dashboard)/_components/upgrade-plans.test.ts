import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MINIMUM_SEATS, PLANS } from '@xecret/core/entitlements';
import type { PlanFeatures } from '@xecret/core/entitlements';
import {
  CAPABILITY_ROWS,
  ENTERPRISE_CAVEAT,
  FREE_PRICE,
  PLAN_OFFERS,
  SHIPPED_CAPABILITIES,
  USD_PRICES,
  YEARLY_SAVING_UP_TO,
  yearlySaving,
} from './upgrade-plans';
import type { OfferPlanId, PaidPlanId } from './upgrade-plans';

/**
 * The in-app plans page against the public pricing page and the engine.
 *
 * ── Why the pricing page is read as source ──
 * It is the one place a price is written, and it cannot export its sheets — a
 * `page.tsx` exports only what Next allows. So the in-app page restates the
 * US-dollar figures and this file reads `pricing/page.tsx` the way
 * `pricing-page.test.ts` does, and fails the moment the two say different
 * things. A customer who reads $12 in the dashboard and $13 on the website has
 * caught one of them lying, and it does not matter which.
 */

const PRICING = readFileSync(join(import.meta.dirname, '..', '..', 'pricing', 'page.tsx'), 'utf8');

/** One plan's dollar sheet on the pricing page, split into its two periods. */
function pricingSheet(id: PaidPlanId | 'free'): { monthly: string; yearly: string } {
  const card = PRICING.slice(PRICING.indexOf(`id: '${id}'`));
  const usd = card.slice(card.indexOf('usd:'), card.indexOf('eur:'));
  if (usd.length === 0) throw new Error(`no USD sheet for ${id} — this anchor needs updating`);
  return {
    monthly: usd.slice(usd.indexOf('monthly:'), usd.indexOf('yearly:')),
    yearly: usd.slice(usd.indexOf('yearly:')),
  };
}

const PAID: readonly PaidPlanId[] = ['pro', 'team'];

function offer(id: OfferPlanId) {
  const found = PLAN_OFFERS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no offer for ${id}`);
  return found;
}

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
    expect(PRICING).toContain('return `Billed from ${seats} members up`;');
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
  });

  it('calls Pro unlimited on members only while the engine leaves it uncapped', () => {
    expect(PLANS.pro.limits.seats).toBeNull();
    expect(PLANS.pro.features.perEnvironmentGrants).toBe(false);
    expect(offer('pro').features).toContain(
      'Unlimited members — everyone can read every environment',
    );
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

    for (const feature of ['perEnvironmentGrants', 'secretPolicy', 'disableEnvExport'] as const) {
      expect(PLANS.pro.features[feature], feature).toBe(false);
      expect(PLANS.team.features[feature], feature).toBe(true);
    }
    expect(offer('team').features).toContain('Roles and per-environment access');
  });

  /**
   * The engine carries flags for capabilities nobody has yet — and the pricing
   * page marks every one of them "Coming soon". A page whose job is to persuade
   * is where one would most easily gain a tick, so the list is pinned.
   */
  it('lists no capability that is not built', () => {
    const unbuilt: (keyof PlanFeatures)[] = [
      'oidcSso',
      'changeApprovals',
      'breakGlass',
      'bulkRotate',
      'customRoles',
      'githubOidcFederation',
      'scheduledSecrets',
      'siemStreaming',
    ];
    const listed = SHIPPED_CAPABILITIES.map((capability) => capability.feature);
    for (const feature of unbuilt) expect(listed, feature).not.toContain(feature);
  });

  it('agrees with the pricing page’s comparison table wherever the two name the same row', () => {
    let compared = 0;
    for (const row of CAPABILITY_ROWS) {
      const at = PRICING.indexOf(`label: '${row.label}'`);
      if (at === -1) continue;
      const block = PRICING.slice(at, PRICING.indexOf('label:', at + 1));

      expect(block, `${row.label} is "Coming soon" on the pricing page`).not.toContain('NOT_YET');
      for (const plan of ['free', 'pro', 'team'] as const) {
        const value = new RegExp(`\\b${plan}: (true|false)`).exec(block)?.[1];
        expect(value, `${row.label}: no ${plan} value on the pricing page`).toBeDefined();
        expect(row.on[plan], `${row.label} on ${plan}`).toBe(value === 'true');
      }
      compared += 1;
    }
    // Not vacuous: most rows are named identically on both pages.
    expect(compared).toBeGreaterThanOrEqual(6);
  });

  it('reads every tick in the table from the engine', () => {
    for (const capability of SHIPPED_CAPABILITIES) {
      const row = CAPABILITY_ROWS.find((candidate) => candidate.label === capability.label);
      expect(row, capability.label).toBeDefined();
      for (const plan of ['free', 'pro', 'team'] as const) {
        expect(row?.on[plan], `${capability.label} on ${plan}`).toBe(
          PLANS[plan].features[capability.feature],
        );
      }
    }
  });

  it('mentions a trial if and only if the pricing page does', () => {
    const copy = [
      ...PLAN_OFFERS.flatMap((o) => [o.name, o.audience, o.caveat ?? '', ...o.features]),
      ...CAPABILITY_ROWS.flatMap((row) => [row.label, row.hint]),
    ].join('\n');

    expect(/\btrial\b/i.test(copy)).toBe(/\btrial\b/i.test(PRICING));
  });
});
