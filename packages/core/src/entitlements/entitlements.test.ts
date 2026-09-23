import { describe, expect, it } from 'vitest';

import {
  FREE_ENTITLEMENTS,
  isControlPlaneActive,
  isDataPlaneActive,
  resolveEntitlements,
  resolvePlanId,
} from './entitlements';
import {
  checkLimit,
  featureError,
  hasAddon,
  hasFeature,
  limitError,
  meteredUnitsOwed,
} from './limits';
import {
  cheapestPlanWithFeature,
  cheapestPlanWithLimit,
  FAIR_USE,
  FETCHES_PER_METERED_UNIT,
  MINIMUM_SEATS,
  PLAN_IDS,
  PLAN_RANK,
  PLANS,
} from './plans';
import type {
  Entitlements,
  LimitedResource,
  PlanFeatures,
  PlanId,
  PlanLimits,
  SubscriptionState,
  SubscriptionStatus,
} from './types';

const ALL_STATUSES: readonly SubscriptionStatus[] = [
  'active',
  'trialing',
  'past_due',
  'on_hold',
  'cancelled',
  'expired',
];

/**
 * Every (weaker, stronger) neighbouring pair in the ladder.
 *
 * A helper rather than index arithmetic in each test, because `PLAN_IDS[i - 1]`
 * under `noUncheckedIndexedAccess` needs an assertion at every use, and an
 * assertion in a test is a place the test can lie about what it proved.
 */
function adjacentPlanPairs(): [PlanId, PlanId][] {
  const pairs: [PlanId, PlanId][] = [];
  let previous: PlanId | undefined;
  for (const id of PLAN_IDS) {
    if (previous !== undefined) pairs.push([previous, id]);
    previous = id;
  }
  return pairs;
}

function state(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    plan: 'free',
    status: 'active',
    addonSaml: false,
    addonDirectorySync: false,
    ...overrides,
  };
}

function entitlementsFor(plan: PlanId, overrides: Partial<SubscriptionState> = {}): Entitlements {
  return resolveEntitlements(state({ plan, ...overrides }));
}

/* ───────────────────────────────────────────────────────────────────────────
 * D19 — the fail-open rule.
 *
 * These are the tests that define what xecret is. They exist so that the change
 * which breaks the published promise cannot be made quietly: anyone "adding the
 * missing billing check" to the fetch path has to delete a test that says, in
 * words, why it is there.
 *
 * The promise, pricing-plan.md §5:
 *   "A build never fails because of billing or fair use."
 * ─────────────────────────────────────────────────────────────────────────── */
describe('D19 — a secret fetch is never refused for a billing reason', () => {
  it.each(ALL_STATUSES)('the data plane stays open under status %s', (status) => {
    expect(isDataPlaneActive(status)).toBe(true);
  });

  it('stays open for an expired card (on_hold) — the build still runs', () => {
    expect(isDataPlaneActive('on_hold')).toBe(true);
  });

  it('stays open after cancellation', () => {
    expect(isDataPlaneActive('cancelled')).toBe(true);
  });

  it('stays open after the subscription has fully expired', () => {
    // An expired organisation drops to Free limits going forward. It does not
    // lose access to secrets it already stored. Deleting or locking that data
    // would make us a hostage-taker rather than a custodian.
    expect(isDataPlaneActive('expired')).toBe(true);
  });

  it('exceeding the included fetch allowance is an invoice, not a refusal', () => {
    const team = entitlementsFor('team');
    const included = team.limits.includedFetchesPerMonth;

    // Ten times the allowance still bills rather than blocks: the overage is
    // computed, and nothing in this module can say "no" to a fetch.
    expect(meteredUnitsOwed(included * 10, included, 0, FETCHES_PER_METERED_UNIT)).toBeGreaterThan(
      0,
    );
    expect(isDataPlaneActive(team.status)).toBe(true);
  });
});

describe('the control plane does fail closed', () => {
  it.each(['active', 'trialing', 'past_due', 'on_hold'] as const)(
    'accepts writes under %s',
    (status) => {
      expect(isControlPlaneActive(status)).toBe(true);
    },
  );

  it.each(['cancelled', 'expired'] as const)('refuses writes under %s', (status) => {
    expect(isControlPlaneActive(status)).toBe(false);
  });

  it('keeps the dashboard reachable on a declined card', () => {
    // past_due must not lock the owner out, or they cannot reach the page that
    // fixes the card. Dunning is an email's job, not a lockout's.
    expect(isControlPlaneActive('past_due')).toBe(true);
    expect(resolveEntitlements(state({ status: 'past_due' })).controlPlaneActive).toBe(true);
  });

  it('refuses the sixth project on Free', () => {
    const free = entitlementsFor('free');
    expect(checkLimit(free, 'projects', 5).kind).toBe('exceeded');
  });

  it('refuses a second member on Free', () => {
    const free = entitlementsFor('free');
    expect(checkLimit(free, 'seats', 1).kind).toBe('exceeded');
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('plan definitions', () => {
  it('every plan id has a definition, and every definition matches its key', () => {
    for (const id of PLAN_IDS) {
      expect(PLANS[id]).toBeDefined();
      expect(PLANS[id].id).toBe(id);
    }
    expect(Object.keys(PLANS).sort()).toEqual([...PLAN_IDS].sort());
  });

  it('ranks are a total order with no gaps or ties', () => {
    const ranks = PLAN_IDS.map((id) => PLAN_RANK[id]);
    expect(ranks).toEqual([0, 1, 2, 3]);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  /**
   * Monotonicity. This is the property the accumulating `...SPREAD` construction
   * in plans.ts exists to guarantee, asserted rather than assumed — because the
   * construction is a convention and a future editor can write a flat literal
   * that quietly drops a feature from Enterprise.
   */
  it('features are monotonic: no plan loses a capability the tier below has', () => {
    for (const [weaker, stronger] of adjacentPlanPairs()) {
      const lower = PLANS[weaker].features;
      const higher = PLANS[stronger].features;

      for (const key of Object.keys(lower) as (keyof PlanFeatures)[]) {
        if (lower[key]) {
          expect(higher[key], `${stronger} lost "${key}", which ${weaker} has`).toBe(true);
        }
      }
    }
  });

  it('countable limits are monotonic: no plan gets a smaller ceiling than the tier below', () => {
    for (const [weaker, stronger] of adjacentPlanPairs()) {
      const lower = PLANS[weaker].limits;
      const higher = PLANS[stronger].limits;

      for (const key of Object.keys(lower) as (keyof PlanLimits)[]) {
        const lo = lower[key];
        const hi = higher[key];

        // null is unlimited: a higher tier may go from a number to null, never back.
        if (lo === null) {
          expect(hi, `${stronger} narrowed unlimited "${key}"`).toBeNull();
          continue;
        }
        if (hi === null) continue;
        expect(hi, `${stronger} has a smaller "${key}" than ${weaker}`).toBeGreaterThanOrEqual(lo);
      }
    }
  });

  it('every feature flag is declared on every plan', () => {
    const reference = Object.keys(PLANS.free.features).sort();
    for (const id of PLAN_IDS) {
      expect(Object.keys(PLANS[id].features).sort()).toEqual(reference);
    }
  });

  it('every limit field is declared on every plan', () => {
    const reference = Object.keys(PLANS.free.limits).sort();
    for (const id of PLAN_IDS) {
      expect(Object.keys(PLANS[id].limits).sort()).toEqual(reference);
    }
  });
});

/**
 * The published numbers, asserted one by one.
 *
 * Written out longhand rather than derived, because the point is to fail when
 * somebody changes a limit in plans.ts without changing it in the pricing plan
 * and on the pricing page. A test that recomputed these from the same constants
 * would pass through any such change silently.
 *
 * Source: .local/plans/pricing-plan.md §3.
 */
describe('the published Free-tier limits', () => {
  const free = PLANS.free.limits;

  it('1 organisation', () => expect(free.organizations).toBe(1));
  it('5 projects', () => expect(free.projects).toBe(5));
  it('3 environments per project', () => expect(free.environmentsPerProject).toBe(3));
  it('1 seat', () => expect(free.seats).toBe(1));
  it('10 service tokens', () => expect(free.serviceTokens).toBe(10));
  it('2 CLI devices per user', () => expect(free.cliDevicesPerUser).toBe(2));
  it('20,000 included fetches', () => expect(free.includedFetchesPerMonth).toBe(20_000));
  it('7 days of audit history', () => expect(free.auditRetentionDays).toBe(7));
  it('the last 5 secret versions', () => expect(free.secretVersionsRetained).toBe(5));
  it('no point-in-time restore', () => expect(free.pitrDays).toBe(0));
  it('no webhooks', () => expect(free.webhooks).toBe(0));
});

describe('the published paid-tier limits', () => {
  it('included fetches per plan', () => {
    expect(PLANS.pro.limits.includedFetchesPerMonth).toBe(150_000);
    expect(PLANS.team.limits.includedFetchesPerMonth).toBe(1_000_000);
    expect(PLANS.enterprise.limits.includedFetchesPerMonth).toBe(10_000_000);
  });

  it('audit retention per plan', () => {
    expect(PLANS.pro.limits.auditRetentionDays).toBe(30);
    expect(PLANS.team.limits.auditRetentionDays).toBe(180);
    expect(PLANS.enterprise.limits.auditRetentionDays).toBe(365);
  });

  it('minimum seats per plan', () => {
    expect(MINIMUM_SEATS.pro).toBe(1);
    expect(MINIMUM_SEATS.team).toBe(3);
    expect(MINIMUM_SEATS.enterprise).toBe(10);
  });

  /**
   * Every countable ceiling on a paid self-serve rung is a number.
   *
   * Pro and Team used to publish `null` — "unlimited" — on all of these, which
   * was a promise with a fair-use ceiling quietly behind it: the real limit was
   * whatever an operator decided during an incident, and the first customer to
   * meet it found out the published word was not the rule. A number that support
   * raises for free with an override says the same thing honestly.
   *
   * Seats are deliberately absent from this list; see the test below.
   */
  it('publishes a number, not "unlimited", for every countable on Pro and Team', () => {
    const countable = [
      'organizations',
      'projects',
      'environmentsPerProject',
      'serviceTokens',
      'secretsPerEnvironment',
      'webhooks',
      'cliDevicesPerUser',
    ] as const;

    for (const plan of ['pro', 'team'] as const) {
      for (const resource of countable) {
        expect(PLANS[plan].limits[resource]).toBeTypeOf('number');
      }
    }
  });

  it('leaves the countables uncapped only on Enterprise, where a contract sets them', () => {
    expect(PLANS.enterprise.limits.projects).toBeNull();
    expect(PLANS.enterprise.limits.organizations).toBeNull();
    expect(PLANS.enterprise.limits.secretsPerEnvironment).toBeNull();
  });

  it('gives every paid rung more of each countable than the one below it', () => {
    const countable = [
      'organizations',
      'projects',
      'environmentsPerProject',
      'serviceTokens',
      'secretsPerEnvironment',
    ] as const;

    for (const resource of countable) {
      const free = PLANS.free.limits[resource];
      const pro = PLANS.pro.limits[resource];
      const team = PLANS.team.limits[resource];
      // Free and Pro are both numbers by construction above; the assertion is
      // that the ladder never steps backwards, which is the failure a hand-edited
      // limits table actually produces.
      expect(typeof free === 'number' && typeof pro === 'number' && pro > free).toBe(true);
      expect(typeof pro === 'number' && typeof team === 'number' && team > pro).toBe(true);
    }
  });

  it('Pro has unlimited seats — the deliberate decision, not an oversight', () => {
    // pricing-plan.md §3, "On unlimited seats at Pro". Pro is uncapped because
    // the gate to Team is per-environment access control, which is a real need
    // rather than an artificial ceiling.
    expect(PLANS.pro.limits.seats).toBeNull();
  });
});

describe('the Pro → Team gate', () => {
  it('Pro cannot restrict who reads production', () => {
    expect(PLANS.pro.features.perEnvironmentGrants).toBe(false);
  });

  it('Team can', () => {
    expect(PLANS.team.features.perEnvironmentGrants).toBe(true);
  });

  it('is the entire commercial reason Pro can offer unlimited seats', () => {
    // If this ever fails, Team has lost its reason to exist and the pricing
    // model needs rewriting before the code does.
    expect(PLANS.pro.limits.seats).toBeNull();
    expect(PLANS.pro.features.perEnvironmentGrants).toBe(false);
    expect(PLANS.team.features.perEnvironmentGrants).toBe(true);
  });
});

describe('feature placement', () => {
  it('OIDC SSO starts at Team — there is no SSO tax', () => {
    // pricing-plan.md §8.1: OIDC is built in-house and costs us nothing per
    // customer, so it ships in the mid tier. Moving it up is a pricing change,
    // not a refactor.
    expect(cheapestPlanWithFeature('oidcSso')).toBe('team');
  });

  it('the Pro bundle starts at Pro', () => {
    for (const feature of [
      'secretReferencing',
      'personalOverrides',
      'environmentPromotion',
      'pointInTimeRestore',
      'tokenIpAllowlist',
      'newIpReadAlerts',
    ] as const) {
      expect(cheapestPlanWithFeature(feature), feature).toBe('pro');
    }
  });

  it('the Team bundle starts at Team', () => {
    for (const feature of [
      'perEnvironmentGrants',
      'changeApprovals',
      'secretPolicy',
      'disableEnvExport',
      'breakGlass',
      'bulkRotate',
    ] as const) {
      expect(cheapestPlanWithFeature(feature), feature).toBe('team');
    }
  });

  /**
   * Where Scale's four capabilities landed when the tier was removed.
   *
   * Two came down to Team and two went up to Enterprise, and the split is a
   * product decision worth pinning rather than leaving to whoever next edits the
   * feature table. Federation and expiring secrets are security posture that
   * small teams with outside help need most; custom roles and SIEM streaming are
   * bought by an organisation that has a security function, which is the same
   * organisation that is signing a contract.
   */
  it('two of the retired Scale bundle start at Team', () => {
    for (const feature of ['githubOidcFederation', 'scheduledSecrets'] as const) {
      expect(cheapestPlanWithFeature(feature), feature).toBe('team');
    }
  });

  it('the other two start at Enterprise', () => {
    for (const feature of ['customRoles', 'siemStreaming'] as const) {
      expect(cheapestPlanWithFeature(feature), feature).toBe('enterprise');
    }
  });

  it('Free has no gated feature at all', () => {
    expect(Object.values(PLANS.free.features).every((v) => v === false)).toBe(true);
  });
});

describe('add-ons are not plan features', () => {
  it('no plan grants SAML or Directory Sync', () => {
    for (const id of PLAN_IDS) {
      expect(id in PLANS).toBe(true);
      // The type system already forbids it; this asserts the intent survives a
      // future widening of PlanFeatures.
      expect('samlSso' in PLANS[id].features).toBe(false);
      expect('directorySync' in PLANS[id].features).toBe(false);
    }
  });

  it('default to off, even on Enterprise', () => {
    expect(hasAddon(entitlementsFor('enterprise'), 'samlSso')).toBe(false);
    expect(hasAddon(entitlementsFor('enterprise'), 'directorySync')).toBe(false);
  });

  it('are granted per organisation, independently of the plan', () => {
    const team = entitlementsFor('team', { addonSaml: true });
    expect(hasAddon(team, 'samlSso')).toBe(true);
    expect(hasAddon(team, 'directorySync')).toBe(false);
  });
});

describe('resolveEntitlements', () => {
  it('produces a frozen object', () => {
    const e = entitlementsFor('team');
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.limits)).toBe(true);
    expect(Object.isFrozen(e.addons)).toBe(true);
  });

  /**
   * Scale was sold as the tier above Team and then withdrawn. A row can still
   * say so — `plan_id` is a Postgres enum and enums are additive-only — and the
   * difference between resolving it to Team and letting it fall through to Free
   * is a customer losing per-environment grants they paid for, silently, on the
   * authorization path.
   */
  it('resolves a retired plan to what replaced it, not to Free', () => {
    const e = resolveEntitlements(state({ plan: 'scale' as PlanId }));

    expect(e.plan).toBe('team');
    expect(e.features.perEnvironmentGrants).toBe(true);
    expect(e.limits).toEqual(PLANS.team.limits);
  });

  it('resolvePlanId answers the same way for every input the resolver takes', () => {
    expect(resolvePlanId('team')).toBe('team');
    expect(resolvePlanId('scale')).toBe('team');
    expect(resolvePlanId('platinum')).toBe('free');
    // `in` would match this through Object.prototype; the guard must not.
    expect(resolvePlanId('constructor')).toBe('free');
  });

  it('falls back to Free for an unrecognised plan rather than throwing', () => {
    const e = resolveEntitlements(state({ plan: 'platinum' as PlanId }));
    expect(e.plan).toBe('free');
    expect(e.limits.projects).toBe(5);
  });

  it('FREE_ENTITLEMENTS matches a freshly resolved Free org', () => {
    expect(FREE_ENTITLEMENTS.plan).toBe('free');
    expect(FREE_ENTITLEMENTS.limits).toEqual(entitlementsFor('free').limits);
  });
});

describe('limit overrides are raise-only', () => {
  it('raises a ceiling', () => {
    const e = entitlementsFor('free', { limitOverrides: { projects: 50 } });
    expect(e.limits.projects).toBe(50);
  });

  it('ignores an attempt to lower one', () => {
    // A stale or malformed override must never downgrade a paying customer.
    const e = entitlementsFor('free', { limitOverrides: { projects: 2 } });
    expect(e.limits.projects).toBe(5);
  });

  it('ignores an equal value', () => {
    const e = entitlementsFor('free', { limitOverrides: { projects: 5 } });
    expect(e.limits.projects).toBe(5);
  });

  it('can raise a ceiling to unlimited', () => {
    const e = entitlementsFor('free', { limitOverrides: { projects: null } });
    expect(e.limits.projects).toBeNull();
  });

  // Enterprise, because it is now the only plan with an unlimited countable —
  // Pro and Team publish numbers, which is the point of them publishing numbers.
  it('cannot narrow an already-unlimited ceiling', () => {
    const e = entitlementsFor('enterprise', { limitOverrides: { projects: 10 } });
    expect(e.limits.projects).toBeNull();
  });

  it('can still raise a paid rung’s real ceiling', () => {
    const e = entitlementsFor('pro', { limitOverrides: { projects: 500 } });
    expect(e.limits.projects).toBe(500);
  });

  it('ignores a field nobody defined', () => {
    const e = entitlementsFor('free', { limitOverrides: { wibble: 9000 } });
    expect(e.limits.projects).toBe(5);
    expect('wibble' in e.limits).toBe(false);
  });

  it('ignores non-finite and non-numeric values', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '50' as unknown as number]) {
      const e = entitlementsFor('free', { limitOverrides: { projects: bad } });
      expect(e.limits.projects).toBe(5);
    }
  });

  it('leaves untouched fields alone', () => {
    const e = entitlementsFor('free', { limitOverrides: { projects: 50 } });
    expect(e.limits.environmentsPerProject).toBe(3);
    expect(e.limits.organizations).toBe(1);
  });
});

describe('checkLimit', () => {
  it('allows below the ceiling', () => {
    expect(checkLimit(entitlementsFor('free'), 'projects', 0)).toMatchObject({ kind: 'ok' });
  });

  it('warns at 80% of a hard ceiling', () => {
    expect(checkLimit(entitlementsFor('free'), 'projects', 4)).toMatchObject({
      kind: 'warn',
      reason: 'approaching',
    });
  });

  it('refuses at the ceiling, because current is the count before the addition', () => {
    const verdict = checkLimit(entitlementsFor('free'), 'projects', 5);
    expect(verdict.kind).toBe('exceeded');
  });

  it('names a plan that would allow it', () => {
    const verdict = checkLimit(entitlementsFor('free'), 'projects', 5);
    expect(verdict.kind === 'exceeded' && verdict.upgradeTo).toBe('pro');
  });

  it('never refuses where the plan limit is unlimited', () => {
    const enterprise = entitlementsFor('enterprise');
    expect(checkLimit(enterprise, 'projects', 1_000_000).kind).not.toBe('exceeded');
  });

  it('warns — never refuses — past a fair-use ceiling', () => {
    const enterprise = entitlementsFor('enterprise');
    const verdict = checkLimit(enterprise, 'projects', FAIR_USE.projects);
    expect(verdict).toMatchObject({ kind: 'warn', reason: 'fairUse', limit: null });
  });

  /**
   * The other half of the same rule, now that Pro and Team have real numbers:
   * a *plan* ceiling does refuse, and it names the tier that would not.
   */
  it('refuses past a paid plan’s own ceiling, naming where to go', () => {
    const pro = entitlementsFor('pro');
    const projects = PLANS.pro.limits.projects;
    expect(typeof projects).toBe('number');
    const verdict = checkLimit(pro, 'projects', projects as number);
    expect(verdict.kind).toBe('exceeded');
    if (verdict.kind === 'exceeded') expect(verdict.upgradeTo).toBe('team');
  });

  it('honours a raised ceiling', () => {
    const e = entitlementsFor('free', { limitOverrides: { projects: 50 } });
    expect(checkLimit(e, 'projects', 5).kind).toBe('ok');
  });

  it('handles a zero ceiling without dividing by zero', () => {
    const verdict = checkLimit(entitlementsFor('free'), 'webhooks', 0);
    expect(verdict.kind).toBe('exceeded');
  });

  it.each([
    'organizations',
    'projects',
    'environmentsPerProject',
    'serviceTokens',
    'seats',
    'cliDevicesPerUser',
    'webhooks',
    'secretsPerEnvironment',
  ] as const satisfies readonly LimitedResource[])('resolves a verdict for %s', (resource) => {
    expect(['ok', 'warn', 'exceeded']).toContain(
      checkLimit(entitlementsFor('free'), resource, 0).kind,
    );
  });
});

describe('cheapestPlanWithLimit', () => {
  it('treats unlimited as clearing any requirement', () => {
    expect(cheapestPlanWithLimit('projects', 1_000_000)).toBe('enterprise');
  });

  it('finds the cheapest plan that clears a small requirement', () => {
    expect(cheapestPlanWithLimit('projects', 3)).toBe('free');
  });

  it('does not recommend the plan the caller is already on', () => {
    const verdict = checkLimit(entitlementsFor('enterprise'), 'webhooks', 1_000_000);
    // Enterprise is unlimited here, so there is nothing to exceed.
    expect(verdict.kind).not.toBe('exceeded');
  });
});

describe('error bodies', () => {
  it('a limit refusal carries everything a client needs to act', () => {
    const free = entitlementsFor('free');
    const verdict = checkLimit(free, 'projects', 5);
    if (verdict.kind !== 'exceeded') throw new Error('expected exceeded');

    const body = limitError(free, 'projects', verdict);
    expect(body).toMatchObject({
      error: 'plan_limit',
      resource: 'projects',
      limit: 5,
      current: 5,
      plan: 'free',
      upgradeTo: 'pro',
    });
    expect(body.message).toContain('pro');
  });

  it('a feature refusal names the plan that includes it', () => {
    const free = entitlementsFor('free');
    const body = featureError(free, 'oidcSso', cheapestPlanWithFeature('oidcSso'));
    expect(body.upgradeTo).toBe('team');
    expect(body.message).toContain('team');
  });

  it('leaks nothing identifying', () => {
    const free = entitlementsFor('free');
    const verdict = checkLimit(free, 'projects', 5);
    if (verdict.kind !== 'exceeded') throw new Error('expected exceeded');

    // These bodies are logged. Only plan shape may appear in them.
    const serialised = JSON.stringify(limitError(free, 'projects', verdict));
    expect(serialised).not.toMatch(/token|secret|key|email|password/i);
  });
});

describe('hasFeature', () => {
  it('is false on Free and true on the tier that includes it', () => {
    expect(hasFeature(entitlementsFor('free'), 'oidcSso')).toBe(false);
    expect(hasFeature(entitlementsFor('team'), 'oidcSso')).toBe(true);
  });

  it('ignores status — a lapsed Team org keeps its Team feature set', () => {
    // Features are what the plan says. Whether the control plane accepts a
    // write is a separate question with a separate answer.
    expect(hasFeature(entitlementsFor('team', { status: 'expired' }), 'oidcSso')).toBe(true);
  });
});

describe('meteredUnitsOwed', () => {
  it('bills nothing inside the allowance', () => {
    expect(meteredUnitsOwed(400_000, 500_000, 0, 1_000)).toBe(0);
  });

  it('bills whole units only — a partial thousand waits', () => {
    expect(meteredUnitsOwed(500_999, 500_000, 0, 1_000)).toBe(0);
    expect(meteredUnitsOwed(501_000, 500_000, 0, 1_000)).toBe(1);
  });

  it('subtracts what was already sent, so a flush cannot double-bill', () => {
    expect(meteredUnitsOwed(510_000, 500_000, 10, 1_000)).toBe(0);
    expect(meteredUnitsOwed(515_000, 500_000, 10, 1_000)).toBe(5);
  });

  it('never returns a credit', () => {
    // A counter reset or a replayed flush produces 0, not a negative charge.
    expect(meteredUnitsOwed(0, 500_000, 50, 1_000)).toBe(0);
    expect(meteredUnitsOwed(100, 500_000, 9_999, 1_000)).toBe(0);
  });

  it('the published overage example from the Dodo setup guide', () => {
    // 700,000 fetches on Team: 700 - 500 = 200 units at $0.01 = $2.00
    expect(meteredUnitsOwed(700_000, 500_000, 0, FETCHES_PER_METERED_UNIT)).toBe(200);
  });
});
