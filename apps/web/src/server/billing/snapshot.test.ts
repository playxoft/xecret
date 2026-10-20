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
    meteredFrom: null,
    dodoMode: null,
    dodoEventId: null,
    onHoldSince: null,
    dodoScheduledChangeAt: null,
    dodoCurrency: null,
    dodoBillingCountry: null,
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
  over: {
    entry?: CatalogEntry | null;
    eventAt?: Date;
    samlAddonId?: string | null;
    webhookId?: string | null;
    mode?: 'test_mode' | 'live_mode';
    attachable?: boolean;
    now?: Date;
  } = {},
) =>
  decideSnapshot({
    row: current,
    snapshot: incoming,
    entry: over.entry === undefined ? TEAM_MONTHLY : over.entry,
    eventAt: over.eventAt ?? NOW,
    now: over.now ?? NOW,
    samlAddonId: over.samlAddonId ?? null,
    mode: over.mode ?? 'test_mode',
    webhookId: over.webhookId === undefined ? 'msg_default' : over.webhookId,
    // A subscription the row does not follow yet is, here, one from its own checkout.
    attachable: over.attachable ?? true,
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

  it('orders two snapshots stamped alike by webhook id — whichever arrives first, the same one wins', () => {
    const at = new Date(NOW.getTime() - 1000);
    const applied = (webhookId: string, quantity: number) =>
      row({ ...following, dodoEventAt: at, dodoEventId: webhookId, seats: quantity });
    // msg_b after msg_a: applied.
    expect(
      decide(applied('msg_a', 4), snapshot({ quantity: 5 }), { eventAt: at, webhookId: 'msg_b' })
        .kind,
    ).toBe('apply');
    // msg_a after msg_b: stale — the row stays as msg_b left it.
    expect(
      decide(applied('msg_b', 5), snapshot({ quantity: 4 }), { eventAt: at, webhookId: 'msg_a' }),
    ).toEqual({ kind: 'ignore', reason: 'stale' });
  });

  it('never writes a row recorded under the other Dodo mode', () => {
    const testRow = row({ ...following, dodoMode: 'test_mode' });
    expect(decide(testRow, snapshot(), { mode: 'live_mode' })).toEqual({
      kind: 'ignore',
      reason: 'other-mode',
    });
    const decision = decide(testRow, snapshot(), { mode: 'test_mode' });
    expect(decision.kind === 'apply' && decision.patch.dodoMode).toBe('test_mode');
  });

  it('attaches a new subscription to a Free row only from its own open checkout', () => {
    expect(decide(row(), snapshot(), { attachable: false })).toEqual({
      kind: 'ignore',
      reason: 'unverified-checkout',
    });
    expect(decide(row(), snapshot(), { attachable: true }).kind).toBe('apply');
  });

  it('gives a plan back to the subscription a row left only when Dodo says it is active again', () => {
    const endedHere = row({
      dodoSubscriptionId: 'sub_1',
      dodoEventAt: new Date(NOW.getTime() - DAY),
    });
    expect(decide(endedHere, snapshot({ status: 'on_hold' }))).toEqual({
      kind: 'ignore',
      reason: 'not-reactivating',
    });
    const back = decide(endedHere, snapshot({ status: 'active' }));
    expect(back.kind === 'apply' && back.patch.plan).toBe('team');
    // A linked first checkout (no snapshot applied yet) is not a return.
    const linked = row({ dodoSubscriptionId: 'sub_1', dodoEventAt: null });
    expect(decide(linked, snapshot({ status: 'on_hold' })).kind).toBe('apply');
  });

  it('meters from the activation, or from a trial’s end — and keeps it across renewals', () => {
    const start = new Date(NOW.getTime() - DAY);
    const activated = decide(row(), snapshot({ previous_billing_date: start.toISOString() }));
    expect(activated.kind === 'apply' && activated.patch.meteredFrom?.getTime()).toBe(
      start.getTime(),
    );

    const created = new Date(NOW.getTime() - 2 * DAY);
    const trial = decide(
      row(),
      snapshot({ trial_period_days: 14, created_at: created.toISOString() }),
    );
    expect(trial.kind === 'apply' && trial.patch.meteredFrom?.getTime()).toBe(
      created.getTime() + 14 * DAY,
    );

    const meteredFrom = new Date(NOW.getTime() - 40 * DAY);
    const renewal = decide(row({ ...following, meteredFrom }), snapshot());
    expect(renewal.kind === 'apply' && renewal.patch.meteredFrom?.getTime()).toBe(
      meteredFrom.getTime(),
    );
  });

  it('records when a subscription went on hold, keeps it while it stays there, and clears it after', () => {
    const held = decide(following, snapshot({ status: 'on_hold' }));
    expect(held.kind === 'apply' && held.patch.onHoldSince?.getTime()).toBe(NOW.getTime());

    const since = new Date(NOW.getTime() - 5 * DAY);
    const still = decide(
      row({ ...following, status: 'on_hold', onHoldSince: since }),
      snapshot({ status: 'on_hold' }),
    );
    expect(still.kind === 'apply' && still.patch.onHoldSince?.getTime()).toBe(since.getTime());

    const paid = decide(row({ ...following, status: 'on_hold', onHoldSince: since }), snapshot());
    expect(paid.kind === 'apply' && paid.patch.onHoldSince).toBeNull();
  });

  it('records a plan change Dodo has scheduled, and its absence', () => {
    const at = new Date(NOW.getTime() + 20 * DAY).toISOString();
    const scheduled = decide(following, snapshot({ scheduled_change: { effective_at: at } }));
    expect(scheduled.kind === 'apply' && scheduled.patch.dodoScheduledChangeAt?.toISOString()).toBe(
      at,
    );
    const none = decide(following, snapshot({ scheduled_change: null }));
    expect(none.kind === 'apply' && none.patch.dodoScheduledChangeAt).toBeNull();
  });

  it('drops support’s limit overrides with the plan they were granted on', () => {
    const ended = decide(
      row({ ...following, limitOverrides: { projects: 2000 } }),
      snapshot({ status: 'expired' }),
    );
    expect(ended.kind === 'apply' && ended.patch).toMatchObject({
      plan: 'free',
      limitOverrides: null,
      meteredFrom: null,
    });
  });

  it('raises a region disagreement once, when Dodo’s report changes — not on every snapshot', () => {
    const locked = row({ ...following, dodoCurrency: 'USD', dodoBillingCountry: 'US' });
    const first = decide(locked, snapshot({ currency: 'INR', billing: { country: 'IN' } }));
    expect(first.kind === 'apply' && first.regionMismatch).toBe(true);
    // The renewal amount is kept with Dodo's own currency, whatever the lock kept.
    expect(first.kind === 'apply' && first.patch).toMatchObject({
      dodoCurrency: 'INR',
      dodoBillingCountry: 'IN',
    });

    const again = decide(
      row({ ...locked, dodoCurrency: 'INR', dodoBillingCountry: 'IN' }),
      snapshot({ currency: 'INR', billing: { country: 'IN' } }),
    );
    expect(again.kind === 'apply' && again.regionMismatch).toBe(false);
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
