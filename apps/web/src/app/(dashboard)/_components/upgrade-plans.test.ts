import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MINIMUM_SEATS, PLANS } from '@xecret/core/entitlements';
import type { PlanFeatures } from '@xecret/core/entitlements';
import {
  billingChoiceFromQuery,
  CAPABILITY_ROWS,
  ENTERPRISE_CAVEAT,
  FREE_PRICE,
  nextCeiling,
  pastTheAllowance,
  PLAN_OFFERS,
  SHIPPED_CAPABILITIES,
  switchPlanHref,
  USD_PRICES,
  WEBHOOKS_ROW,
  YEARLY_SAVING_UP_TO,
  yearlySaving,
} from './upgrade-plans';
import type { OfferPlanId, PaidPlanId } from './upgrade-plans';

/**
 * The in-app plans page against the public pricing page, the engine, and the
 * server that enforces the engine.
 *
 * ── Why sources are read ──
 * The pricing page is the one place a price is written, and it cannot export
 * its sheets — a `page.tsx` exports only what Next allows. So the in-app page
 * restates the US-dollar figures and this file reads `pricing/page.tsx` the way
 * `pricing-page.test.ts` does, and fails the moment the two say different
 * things. And a capability is only worth a tick if the server refuses it
 * without the plan, which only the route handlers can say — so they are read
 * too, for the `requireFeature` behind every capability the page lists.
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

/** Every sentence the plan data puts on the page. */
const COPY = [
  ...PLAN_OFFERS.flatMap((o) => [o.name, o.audience, o.caveat ?? '', ...o.features]),
  ...CAPABILITY_ROWS.flatMap((row) => [row.label, row.hint]),
].join('\n');

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
   * The flags behind every bullet above and every tick in the table, read from
   * the server: each one is refused somewhere without the plan. A flag in
   * `PLANS` that nothing checks would be selling something everybody has.
   */
  it('lists only capabilities a route refuses without the plan', () => {
    for (const { feature } of SHIPPED_CAPABILITIES) {
      expect(gated(feature), `${feature} has no requireFeature behind it`).toBe(true);
    }
    // The one limit-shaped row: refused at the plan's webhook ceiling.
    expect(SERVER).toMatch(/requireCapacity\(\s*\w+,\s*'webhooks'/);
  });

  it('lists no capability the engine names but nobody has built', () => {
    const unbuilt: (keyof PlanFeatures)[] = [
      'oidcSso',
      'changeApprovals',
      'breakGlass',
      'bulkRotate',
      'githubOidcFederation',
      'scheduledSecrets',
      'siemStreaming',
    ];
    const listed = SHIPPED_CAPABILITIES.map((capability) => capability.feature);
    for (const feature of unbuilt) expect(listed, feature).not.toContain(feature);
  });

  /**
   * Per-environment access: `PLANS` gives it to Team and `/pricing` sells it
   * there, but no route checks the flag — every plan can grant it. Until the
   * owner decides between enforcing the gate and rewording `/pricing`, this
   * page claims it nowhere, directly or by implication.
   *
   * The first three assertions are a tripwire, not a wish: when somebody adds
   * the gate they fail, and the note at the top of `upgrade-plans.ts` — and
   * this test — are what to revisit. Two shapes a gate could take are named:
   * a `requireFeature` refusing a write, and a read-side check written as a
   * plain read of the flag. The third is the net under both: the flag's name
   * appears nowhere in server code at all — not as a string, a property or a
   * destructured binding — so any gate, however written, trips it.
   */
  it('claims per-environment access nowhere while nothing enforces it', () => {
    const REVISIT = 'perEnvironmentGrants is enforced now — revisit the note in upgrade-plans.ts';
    expect(gated('perEnvironmentGrants'), REVISIT).toBe(false);
    expect(SERVER, REVISIT).not.toMatch(
      /\bfeatures\s*\??\.\s*perEnvironmentGrants\b|\bfeatures\s*\??\.?\s*\[\s*['"`]perEnvironmentGrants['"`]\s*\]/,
    );
    expect(SERVER, REVISIT).not.toMatch(/\bperEnvironmentGrants\b/);
    expect(SHIPPED_CAPABILITIES.map((c) => c.feature)).not.toContain('perEnvironmentGrants');
    expect(COPY).not.toMatch(/per-environment (access|grants)/i);
    expect(COPY).not.toMatch(/every environment/i);
    expect(COPY).not.toMatch(/out of production|must not see production/i);
  });

  it('places custom roles where the engine gates them: Enterprise, not Team', () => {
    expect(gated('customRoles')).toBe(true);
    expect(PLANS.team.features.customRoles).toBe(false);
    expect(PLANS.enterprise.features.customRoles).toBe(true);
    expect(COPY).not.toMatch(/custom roles/i);
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
    expect(/\btrial\b/i.test(COPY)).toBe(/\btrial\b/i.test(PRICING));
  });
});

/**
 * The table's rows, split by whether the pricing page's comparison table names
 * them too. Listed by hand so the boundary of the guarantee is visible: a row
 * on the left is checked against `/pricing` cell by cell; a row on the right
 * exists only in the app, and is checked against `PLANS` (the ticks) and the
 * server (the gate) above — there is nothing on `/pricing` to agree with.
 */
const NAMED_ON_PRICING = [
  'Secret referencing and environment inheritance',
  'Personal local overrides',
  'Environment promotion, with a diff',
  'Point-in-time restore',
  'Token IP allowlists and lifetime policy',
  WEBHOOKS_ROW,
] as const;

const IN_APP_ONLY = {
  'Alerts on reads from new addresses': 'newIpReadAlerts',
  'A secret policy for names and values': 'secretPolicy',
  'Plaintext export switched off per environment': 'disableEnvExport',
} as const satisfies Record<string, keyof PlanFeatures>;

describe('the table against the pricing page’s comparison table', () => {
  it('accounts for every row, on one side of the boundary or the other', () => {
    expect([...CAPABILITY_ROWS.map((row) => row.label)].sort()).toEqual(
      [...NAMED_ON_PRICING, ...Object.keys(IN_APP_ONLY)].sort(),
    );
  });

  it.each(NAMED_ON_PRICING)('agrees with /pricing on "%s"', (label) => {
    const row = CAPABILITY_ROWS.find((candidate) => candidate.label === label);
    const at = PRICING.indexOf(`label: '${label}'`);
    expect(at, `"${label}" is no longer a row on the pricing page`).toBeGreaterThan(-1);
    const block = PRICING.slice(at, PRICING.indexOf('label:', at + 1));

    expect(block, `"${label}" is "Coming soon" on the pricing page`).not.toContain('NOT_YET');
    for (const plan of ['free', 'pro', 'team'] as const) {
      const value = new RegExp(`\\b${plan}: (true|false)`).exec(block)?.[1];
      expect(value, `${label}: no ${plan} value on the pricing page`).toBeDefined();
      expect(row?.on[plan], `${label} on ${plan}`).toBe(value === 'true');
    }
  });

  it.each(Object.entries(IN_APP_ONLY))(
    '"%s" is not on /pricing, and stands on PLANS and its gate',
    (label, feature) => {
      expect(PRICING).not.toContain(`label: '${label}'`);
      const row = CAPABILITY_ROWS.find((candidate) => candidate.label === label);
      for (const plan of ['free', 'pro', 'team'] as const) {
        expect(row?.on[plan], `${label} on ${plan}`).toBe(PLANS[plan].features[feature]);
      }
      expect(gated(feature)).toBe(true);
    },
  );
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
