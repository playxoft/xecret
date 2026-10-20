import { describe, expect, it } from 'vitest';
import type { SubscriptionRecord } from '@xecret/db/repositories';
import type { CatalogEntry } from './config';
import type { DodoSubscription } from './payloads';
import { decideSnapshot } from './snapshot';

/**
 * The snapshot rules at their edges, without a database: what a Dodo
 * subscription means for a row, for every status and every ownership case.
 */

const NOW = new Date('2026-10-20T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const TEAM_MONTHLY: CatalogEntry = { plan: 'team', interval: 'monthly', productId: 'pdt_team_m' };

function row(over: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    orgId: 'org',
    plan: 'free',
    status: 'active',
    billingInterval: null,
    seats: 1,
    currency: null,
    billingCountry: null,
    regionLockedUntil: null,
    currentPeriodEnd: null,
    currentPeriodStart: null,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    grandfatheredUntil: null,
    dodoCustomerId: null,
    dodoSubscriptionId: null,
    dodoProductId: null,
    dodoEventAt: null,
    renewalAmountMinor: null,
    addonSaml: false,
    addonDirectorySync: false,
    limitOverrides: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function snapshot(over: Partial<DodoSubscription> = {}): DodoSubscription {
  return {
    subscription_id: 'sub_1',
    status: 'active',
    product_id: 'pdt_team_m',
    quantity: 3,
    currency: 'USD',
    customer: { customer_id: 'cus_1' },
    billing: { country: 'US' },
    metadata: {},
    next_billing_date: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    previous_billing_date: new Date(NOW.getTime() - DAY).toISOString(),
    cancel_at_next_billing_date: false,
    trial_period_days: 0,
    created_at: new Date(NOW.getTime() - DAY).toISOString(),
    recurring_pre_tax_amount: 5700,
    addons: [],
    ...over,
  };
}

const decide = (
  current: SubscriptionRecord,
  incoming: DodoSubscription,
  over: { entry?: CatalogEntry | null; eventAt?: Date; samlAddonId?: string | null } = {},
) =>
  decideSnapshot({
    row: current,
    snapshot: incoming,
    entry: over.entry === undefined ? TEAM_MONTHLY : over.entry,
    eventAt: over.eventAt ?? NOW,
    now: NOW,
    samlAddonId: over.samlAddonId ?? null,
  });

const following = row({
  plan: 'team',
  billingInterval: 'monthly',
  seats: 3,
  dodoSubscriptionId: 'sub_1',
  dodoEventAt: new Date(NOW.getTime() - 60_000),
  currency: 'USD',
  billingCountry: 'US',
  regionLockedUntil: new Date(NOW.getTime() + 300 * DAY),
});

describe('decideSnapshot', () => {
  it('grants nothing for a subscription that has not started', () => {
    expect(decide(row(), snapshot({ status: 'pending' }))).toEqual({
      kind: 'ignore',
      reason: 'pending',
    });
  });

  it('holds a paused subscription as on hold, never as lapsed', () => {
    const decision = decide(following, snapshot({ status: 'paused' }));
    expect(decision.kind === 'apply' && decision.patch.status).toBe('on_hold');
    expect(decision.kind === 'apply' && decision.patch.plan).toBe('team');
  });

  it('treats a cancellation whose period is over as the end, and one still running as a flag', () => {
    const over = decide(
      following,
      snapshot({
        status: 'cancelled',
        next_billing_date: new Date(NOW.getTime() - 1000).toISOString(),
      }),
    );
    expect(over.kind === 'apply' && over.ended).toBe(true);
    expect(over.kind === 'apply' && over.patch.plan).toBe('free');

    const running = decide(following, snapshot({ status: 'cancelled' }));
    expect(running.kind === 'apply' && running.ended).toBe(false);
    expect(running.kind === 'apply' && running.patch).toMatchObject({
      plan: 'team',
      status: 'active',
      cancelAtPeriodEnd: true,
    });
  });

  it('ends a subscription on a product since removed from the catalogue, rather than holding it forever', () => {
    const decision = decide(following, snapshot({ status: 'expired' }), { entry: null });
    expect(decision.kind === 'apply' && decision.ended).toBe(true);
  });

  it('refuses an unknown product while live', () => {
    expect(decide(row(), snapshot(), { entry: null })).toEqual({
      kind: 'ignore',
      reason: 'unknown-product',
    });
  });

  it('ignores an ending subscription the row does not follow', () => {
    expect(decide(following, snapshot({ subscription_id: 'sub_old', status: 'expired' }))).toEqual({
      kind: 'ignore',
      reason: 'other-subscription',
    });
    expect(decide(row(), snapshot({ status: 'failed' }))).toEqual({
      kind: 'ignore',
      reason: 'other-subscription',
    });
  });

  it('applies a snapshot at the same instant again — re-delivery is harmless', () => {
    const decision = decide(following, snapshot(), { eventAt: following.dodoEventAt! });
    expect(decision.kind).toBe('apply');
    expect(decision.kind === 'apply' && decision.change.material).toBe(false);
  });

  it('does not restart the region lock on a renewal', () => {
    const decision = decide(following, snapshot());
    expect(decision.kind === 'apply' && decision.patch.regionLockedUntil).toBeUndefined();
  });

  it('starts a new region lock for a returning customer once the old one has run out', () => {
    const lapsed = row({
      dodoSubscriptionId: 'sub_old',
      regionLockedUntil: new Date(NOW.getTime() - DAY),
      billingCountry: 'IN',
      currency: 'INR',
    });
    const decision = decide(lapsed, snapshot({ subscription_id: 'sub_new' }));
    expect(decision.kind === 'apply' && decision.activated).toBe(true);
    expect(decision.kind === 'apply' && decision.patch).toMatchObject({
      currency: 'USD',
      billingCountry: 'US',
    });
    expect(
      decision.kind === 'apply' && decision.patch.regionLockedUntil!.getTime(),
    ).toBeGreaterThan(NOW.getTime() + 360 * DAY);
  });

  it('takes the seats Dodo bills, never fewer than one', () => {
    const decision = decide(following, snapshot({ quantity: 0 }));
    expect(decision.kind === 'apply' && decision.seats.billed).toBe(1);
  });

  it('ends a trial by the clock it is handed', () => {
    const created = new Date(NOW.getTime() - 15 * DAY).toISOString();
    const decision = decide(row(), snapshot({ trial_period_days: 14, created_at: created }));
    expect(decision.kind === 'apply' && decision.patch.status).toBe('active');
    expect(decision.kind === 'apply' && decision.patch.trialEndsAt!.getTime()).toBeLessThan(
      NOW.getTime(),
    );
  });

  it('switches the SAML add-on on only for a positive quantity of the configured add-on', () => {
    const none = decide(following, snapshot({ addons: [{ addon_id: 'adn_saml', quantity: 0 }] }), {
      samlAddonId: 'adn_saml',
    });
    expect(none.kind === 'apply' && none.addonTurnedOn).toBe(false);

    const unconfigured = decide(
      following,
      snapshot({ addons: [{ addon_id: 'adn_saml', quantity: 1 }] }),
    );
    expect(unconfigured.kind === 'apply' && unconfigured.addonTurnedOn).toBe(false);
  });
});
