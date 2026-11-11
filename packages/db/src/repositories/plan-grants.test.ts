import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FREE_SEAT_LIMIT } from '@xecret/core/entitlements';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import { findSubscription } from './subscriptions';
import { recordCheckout } from './billing';
import {
  applyPlanGrant,
  createPromoCode,
  endPlanGrant,
  findOrganizationsForAdmin,
  findPromoCode,
  listGrantsEndingBy,
  listPlanGrants,
  listPromoCodes,
  promoCodeExists,
  revokePromoCode,
  spendGrantRedemption,
} from './plan-grants';
import type { PlanGrantRequest } from './plan-grants';

/**
 * Migration 0035 and the grant and promo-code repositories, against a real
 * database: what matters is what the CHECKs refuse, what the conditional
 * count admits and what the keys forbid — none of it visible in the SQL text.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

async function seedUser(email?: string): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [
      id,
      `user_01${id.replaceAll('-', '').slice(0, 20)}`,
      email ?? `person-${id.slice(0, 8)}@example.com`,
    ],
  );
  return id;
}

interface Seeded {
  orgId: string;
  ownerId: string;
  slug: string;
}

async function seedOrg(
  subscription: {
    plan?: string;
    dodoSubscription?: string | null;
    product?: string | null;
    eventAt?: Date | null;
    seatLimit?: number;
    deleted?: boolean;
    ownerEmail?: string;
  } = {},
): Promise<Seeded> {
  const ownerId = await seedUser(subscription.ownerEmail);
  const orgId = randomUUID();
  const slug = `acme-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, seat_limit, deleted_at)
     values ($1, 'Acme', $2, $3, $4, $5)`,
    [
      orgId,
      slug,
      ownerId,
      subscription.seatLimit ?? FREE_SEAT_LIMIT,
      subscription.deleted ? new Date() : null,
    ],
  );
  const plan = subscription.plan ?? 'free';
  await t.pg.query(
    `insert into org_subscriptions
       (org_id, plan, billing_interval, dodo_subscription_id, dodo_product_id, dodo_event_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      orgId,
      plan,
      plan === 'free' ? null : 'monthly',
      subscription.dodoSubscription ?? null,
      subscription.product !== undefined
        ? subscription.product
        : plan !== 'free' && subscription.dodoSubscription
          ? 'pdt_seeded'
          : null,
      subscription.eventAt ?? null,
    ],
  );
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')`,
    [randomUUID(), orgId, ownerId],
  );
  return { orgId, ownerId, slug };
}

async function seatLimitOf(orgId: string): Promise<number> {
  const result = await t.pg.query<{ seat_limit: number }>(
    `select seat_limit from organizations where id = $1`,
    [orgId],
  );
  return result.rows[0]!.seat_limit;
}

const DAY = 24 * 60 * 60 * 1000;

function grant(orgId: string, over: Partial<PlanGrantRequest> = {}): PlanGrantRequest {
  return {
    orgId,
    plan: 'team',
    seats: null,
    endsAt: new Date(Date.now() + 30 * DAY),
    note: 'Granted by xecret support',
    overDodo: false,
    onlyFromFree: false,
    ...over,
  };
}

describe('applyPlanGrant', () => {
  it('puts a Free organisation on the plan, with its end, note and seat pair', async () => {
    const { orgId } = await seedOrg({ seatLimit: 5 });
    const endsAt = new Date(Date.now() + 30 * DAY);

    const outcome = await t.db.transaction((tx) =>
      applyPlanGrant(tx, grant(orgId, { endsAt, seats: 10 })),
    );

    expect(outcome.ok).toBe(true);
    const row = await findSubscription(t.db, orgId);
    expect(row).toMatchObject({
      plan: 'team',
      billingInterval: 'yearly',
      status: 'active',
      seats: 10,
      grantEndsAt: endsAt,
      grantNote: 'Granted by xecret support',
    });
    expect(await seatLimitOf(orgId)).toBe(10);
  });

  it('never lowers the access ceiling when no seat count is given', async () => {
    const { orgId } = await seedOrg({ seatLimit: 7 });

    await t.db.transaction((tx) => applyPlanGrant(tx, grant(orgId, { plan: 'pro' })));

    expect(await seatLimitOf(orgId)).toBe(7);
  });

  it('writes a grant with no end', async () => {
    const { orgId } = await seedOrg();

    await t.db.transaction((tx) => applyPlanGrant(tx, grant(orgId, { endsAt: null })));

    expect((await findSubscription(t.db, orgId))?.grantEndsAt).toBeNull();
  });

  it('refuses an organisation that was deleted', async () => {
    const { orgId } = await seedOrg({ deleted: true });

    const outcome = await t.db.transaction((tx) => applyPlanGrant(tx, grant(orgId)));

    expect(outcome).toEqual({ ok: false, refusal: 'not-found' });
  });

  it('lets an admin replace a grant — a longer end, another plan', async () => {
    const { orgId } = await seedOrg();
    await t.db.transaction((tx) => applyPlanGrant(tx, grant(orgId)));
    const later = new Date(Date.now() + 90 * DAY);

    const outcome = await t.db.transaction((tx) =>
      applyPlanGrant(tx, grant(orgId, { plan: 'enterprise', endsAt: later })),
    );

    expect(outcome.ok).toBe(true);
    expect(await findSubscription(t.db, orgId)).toMatchObject({
      plan: 'enterprise',
      grantEndsAt: later,
    });
  });

  it('refuses an organisation Dodo bills, unless told to take it off Dodo', async () => {
    const { orgId } = await seedOrg({
      plan: 'pro',
      dodoSubscription: 'sub_live',
      eventAt: new Date(),
    });

    const refused = await t.db.transaction((tx) => applyPlanGrant(tx, grant(orgId)));
    expect(refused).toEqual({ ok: false, refusal: 'billed-by-dodo' });
    expect((await findSubscription(t.db, orgId))?.plan).toBe('pro');

    const forced = await t.db.transaction((tx) =>
      applyPlanGrant(tx, grant(orgId, { overDodo: true })),
    );
    expect(forced).toMatchObject({ ok: true, detached: { dodoSubscriptionId: 'sub_live' } });
    expect(await findSubscription(t.db, orgId)).toMatchObject({
      plan: 'team',
      dodoSubscriptionId: null,
      dodoProductId: null,
    });
  });

  it('takes a Free row off the ids of a subscription that ended, without being told', async () => {
    const { orgId } = await seedOrg({ dodoSubscription: 'sub_ended', eventAt: new Date() });

    const outcome = await t.db.transaction((tx) => applyPlanGrant(tx, grant(orgId)));

    expect(outcome).toMatchObject({ ok: true, detached: { dodoSubscriptionId: 'sub_ended' } });
    expect((await findSubscription(t.db, orgId))?.dodoSubscriptionId).toBeNull();
  });

  it('refuses a row waiting for its paid checkout to activate', async () => {
    const { orgId } = await seedOrg({ dodoSubscription: 'sub_waiting', eventAt: null });

    const outcome = await t.db.transaction((tx) =>
      applyPlanGrant(tx, grant(orgId, { overDodo: false })),
    );

    expect(outcome).toEqual({ ok: false, refusal: 'awaiting-activation' });
  });

  describe('as a redemption', () => {
    it('refuses an organisation that already has a grant', async () => {
      const { orgId } = await seedOrg();
      await t.db.transaction((tx) => applyPlanGrant(tx, grant(orgId)));

      const outcome = await t.db.transaction((tx) =>
        applyPlanGrant(tx, grant(orgId, { onlyFromFree: true })),
      );

      expect(outcome).toEqual({ ok: false, refusal: 'already-granted' });
    });

    it('refuses an organisation that pays through Dodo, even told to take it off', async () => {
      const { orgId } = await seedOrg({
        plan: 'team',
        dodoSubscription: 'sub_paying',
        eventAt: new Date(),
      });

      const outcome = await t.db.transaction((tx) =>
        applyPlanGrant(tx, grant(orgId, { onlyFromFree: true, overDodo: true })),
      );

      expect(outcome).toEqual({ ok: false, refusal: 'already-subscribed' });
    });
  });
});

describe('the grant end date (migration 0035)', () => {
  it('is refused on a Free row by the database itself', async () => {
    const { orgId } = await seedOrg();

    await expect(
      t.pg.query(`update org_subscriptions set grant_ends_at = now() where org_id = $1`, [orgId]),
    ).rejects.toThrow(/org_subscriptions_grant_ends_check/);
  });

  it('is refused on a row Dodo bills by the database itself', async () => {
    const { orgId } = await seedOrg({
      plan: 'pro',
      dodoSubscription: 'sub_x',
      eventAt: new Date(),
    });

    await expect(
      t.pg.query(`update org_subscriptions set grant_ends_at = now() where org_id = $1`, [orgId]),
    ).rejects.toThrow(/org_subscriptions_grant_ends_check/);
  });
});

describe('endPlanGrant', () => {
  it('returns a grant to Free, the ceiling to Free’s, and keeps add-ons and overrides', async () => {
    const { orgId } = await seedOrg();
    await t.db.transaction((tx) => applyPlanGrant(tx, grant(orgId, { seats: 12 })));
    await t.pg.query(
      `update org_subscriptions set addon_saml = true,
              limit_overrides = '{"projects": 50}'::jsonb where org_id = $1`,
      [orgId],
    );

    const ended = await t.db.transaction((tx) => endPlanGrant(tx, orgId));

    expect(ended?.previous.plan).toBe('team');
    expect(await findSubscription(t.db, orgId)).toMatchObject({
      plan: 'free',
      billingInterval: null,
      seats: 1,
      grantEndsAt: null,
      grantNote: null,
      addonSaml: true,
      limitOverrides: { projects: 50 },
    });
    expect(await seatLimitOf(orgId)).toBe(FREE_SEAT_LIMIT);
  });

  it('does nothing to a row Dodo bills', async () => {
    const { orgId } = await seedOrg({
      plan: 'pro',
      dodoSubscription: 'sub_y',
      eventAt: new Date(),
    });

    expect(await t.db.transaction((tx) => endPlanGrant(tx, orgId))).toBeNull();
    expect((await findSubscription(t.db, orgId))?.plan).toBe('pro');
  });

  it('leaves a grant whose end moved past the sweep’s moment since it was listed', async () => {
    const { orgId } = await seedOrg();
    await t.db.transaction((tx) =>
      applyPlanGrant(tx, grant(orgId, { endsAt: new Date(Date.now() + 10 * DAY) })),
    );

    const ended = await t.db.transaction((tx) => endPlanGrant(tx, orgId, { dueBy: new Date() }));

    expect(ended).toBeNull();
    expect((await findSubscription(t.db, orgId))?.plan).toBe('team');
  });
});

describe('listGrantsEndingBy and listPlanGrants', () => {
  it('lists live grants due by the moment, and nothing else', async () => {
    const due = await seedOrg();
    const later = await seedOrg();
    const forever = await seedOrg();
    const deleted = await seedOrg();
    await t.db.transaction(async (tx) => {
      await applyPlanGrant(tx, grant(due.orgId, { endsAt: new Date(Date.now() + 60_000) }));
      await applyPlanGrant(tx, grant(later.orgId, { endsAt: new Date(Date.now() + 20 * DAY) }));
      await applyPlanGrant(tx, grant(forever.orgId, { endsAt: null }));
      await applyPlanGrant(tx, grant(deleted.orgId, { endsAt: new Date(Date.now() + 60_000) }));
    });
    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [deleted.orgId]);

    const listed = await listGrantsEndingBy(t.db, {
      before: new Date(Date.now() + DAY),
      limit: 1000,
    });
    const ids = listed.map((row) => row.orgId);

    expect(ids).toContain(due.orgId);
    expect(ids).not.toContain(later.orgId);
    expect(ids).not.toContain(forever.orgId);
    expect(ids).not.toContain(deleted.orgId);

    const all = (await listPlanGrants(t.db, 1000)).map((row) => row.orgId);
    expect(all).toEqual(expect.arrayContaining([due.orgId, later.orgId, forever.orgId]));
    expect(all).not.toContain(deleted.orgId);
    // Soonest to end first; a grant with no end after every dated one.
    expect(all.indexOf(due.orgId)).toBeLessThan(all.indexOf(later.orgId));
    expect(all.indexOf(later.orgId)).toBeLessThan(all.indexOf(forever.orgId));
  });
});

describe('findOrganizationsForAdmin', () => {
  it('finds a person’s organisations by address, whatever its case, with their role', async () => {
    const email = `Admin-Search-${randomUUID().slice(0, 8)}@Example.com`;
    const { orgId } = await seedOrg({ ownerEmail: email.toLowerCase() });

    const found = await findOrganizationsForAdmin(t.db, { email: email.toUpperCase() }, 50);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: orgId, role: 'owner' });
    expect(found[0]!.subscription.plan).toBe('free');
  });

  it('finds one organisation by slug, and never a deleted one', async () => {
    const live = await seedOrg();
    const gone = await seedOrg({ deleted: true });

    expect((await findOrganizationsForAdmin(t.db, { slug: live.slug }, 50))[0]?.id).toBe(
      live.orgId,
    );
    expect(await findOrganizationsForAdmin(t.db, { slug: gone.slug }, 50)).toEqual([]);
  });
});

describe('promo codes', () => {
  function uniqueCode(prefix = 'CODE'): string {
    return `${prefix}${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  }

  async function grantCode(over: { maxRedemptions?: number | null; expiresAt?: Date | null } = {}) {
    const createdBy = await seedUser();
    return createPromoCode(t.db, {
      code: uniqueCode('FREE'),
      kind: 'grant',
      description: null,
      allowedEmails: null,
      maxRedemptions: over.maxRedemptions ?? null,
      expiresAt: over.expiresAt ?? null,
      createdBy,
      grantPlan: 'team',
      grantDays: 30,
      grantSeats: null,
    });
  }

  it('stores a discount code with what Dodo was told', async () => {
    const createdBy = await seedUser();
    const code = uniqueCode('HALF');
    await createPromoCode(t.db, {
      code,
      kind: 'discount',
      description: 'Launch week',
      allowedEmails: ['someone@example.com'],
      maxRedemptions: 10,
      expiresAt: null,
      createdBy,
      discountType: 'percentage',
      discountAmount: 5000,
      discountCurrency: null,
      discountCycles: 3,
      discountPlans: ['pro', 'team'],
      dodoDiscountId: 'dsc_1',
      dodoMode: 'test_mode',
    });

    expect(await findPromoCode(t.db, code)).toMatchObject({
      kind: 'discount',
      discountPlans: ['pro', 'team'],
      allowedEmails: ['someone@example.com'],
    });
    expect(await promoCodeExists(t.db, code)).toBe(true);
  });

  it('refuses a code Dodo would not accept, and a discount with nothing at Dodo', async () => {
    for (const code of ['lower', 'AB', 'SEVENTEENCHARSXYZ', 'WITH-DASH']) {
      await expect(
        t.pg.query(`insert into promo_codes (code, kind, grant_plan) values ($1, 'grant', 'pro')`, [
          code,
        ]),
      ).rejects.toThrow(/promo_codes_code_check/);
    }

    await expect(
      t.pg.query(
        `insert into promo_codes (code, kind, discount_type, discount_amount, discount_plans)
         values ($1, 'discount', 'percentage', 1000, array['pro']::plan_id[])`,
        [uniqueCode('NODODO')],
      ),
    ).rejects.toThrow(/promo_codes_discount_check/);
  });

  it('refuses a discount for a plan checkout does not sell', async () => {
    await expect(
      t.pg.query(
        `insert into promo_codes (code, kind, discount_type, discount_amount, discount_plans,
                                  dodo_discount_id, dodo_mode)
         values ($1, 'discount', 'percentage', 1000, array['enterprise']::plan_id[], 'dsc', 'live_mode')`,
        [uniqueCode('ENT')],
      ),
    ).rejects.toThrow(/promo_codes_discount_check/);
  });

  it('spends a grant code once per organisation and once per person', async () => {
    const code = await grantCode();
    const first = await seedOrg();
    const second = await seedOrg();

    const spent = await t.db.transaction((tx) =>
      spendGrantRedemption(tx, { codeId: code.id, orgId: first.orgId, userId: first.ownerId }),
    );
    expect(spent).toEqual({ ok: true });

    const sameOrg = await t.db.transaction((tx) =>
      spendGrantRedemption(tx, { codeId: code.id, orgId: first.orgId, userId: second.ownerId }),
    );
    expect(sameOrg).toEqual({ ok: false, refusal: 'org-redeemed' });

    const samePerson = await t.db.transaction((tx) =>
      spendGrantRedemption(tx, { codeId: code.id, orgId: second.orgId, userId: first.ownerId }),
    );
    expect(samePerson).toEqual({ ok: false, refusal: 'user-redeemed' });

    expect((await findPromoCode(t.db, code.code))?.redemptions).toBe(1);
  });

  it('stops at the code’s limit', async () => {
    const code = await grantCode({ maxRedemptions: 1 });
    const first = await seedOrg();
    const second = await seedOrg();

    await t.db.transaction((tx) =>
      spendGrantRedemption(tx, { codeId: code.id, orgId: first.orgId, userId: first.ownerId }),
    );
    const refused = await t.db.transaction((tx) =>
      spendGrantRedemption(tx, { codeId: code.id, orgId: second.orgId, userId: second.ownerId }),
    );

    expect(refused).toEqual({ ok: false, refusal: 'unavailable' });
    expect((await findPromoCode(t.db, code.code))?.redemptions).toBe(1);
  });

  it('refuses a code that expired or was revoked', async () => {
    const expired = await grantCode({ expiresAt: new Date(Date.now() - 60_000) });
    const revoked = await grantCode();
    const admin = await seedUser();
    expect((await revokePromoCode(t.db, revoked.id, admin))?.revokedBy).toBe(admin);
    expect(await revokePromoCode(t.db, revoked.id, admin)).toBeNull();
    const org = await seedOrg();

    for (const code of [expired, revoked]) {
      const outcome = await t.db.transaction((tx) =>
        spendGrantRedemption(tx, { codeId: code.id, orgId: org.orgId, userId: org.ownerId }),
      );
      expect(outcome).toEqual({ ok: false, refusal: 'unavailable' });
    }
  });

  it('gives the redemption back when the transaction that spent it fails', async () => {
    const code = await grantCode();
    const org = await seedOrg();

    await expect(
      t.db.transaction(async (tx) => {
        await spendGrantRedemption(tx, { codeId: code.id, orgId: org.orgId, userId: org.ownerId });
        throw new Error('the grant failed');
      }),
    ).rejects.toThrow('the grant failed');

    expect((await findPromoCode(t.db, code.code))?.redemptions).toBe(0);
  });

  it('lists codes newest first, with the checkouts each started', async () => {
    const createdBy = await seedUser();
    const code = await createPromoCode(t.db, {
      code: uniqueCode('LIST'),
      kind: 'discount',
      description: null,
      allowedEmails: null,
      maxRedemptions: null,
      expiresAt: null,
      createdBy,
      discountType: 'flat',
      discountAmount: 500,
      discountCurrency: 'USD',
      discountCycles: null,
      discountPlans: ['pro'],
      dodoDiscountId: 'dsc_list',
      dodoMode: 'test_mode',
    });
    const org = await seedOrg();
    await recordCheckout(t.db, {
      sessionId: `cks_${randomUUID()}`,
      orgId: org.orgId,
      plan: 'pro',
      billingInterval: 'monthly',
      quantity: 1,
      createdBy: org.ownerId,
      nonce: randomUUID().replaceAll('-', ''),
      promoCodeId: code.id,
    });

    const listed = await listPromoCodes(t.db, 200);

    expect(listed[0]?.id).toBe(code.id);
    expect(listed[0]?.checkoutsStarted).toBe(1);
  });
});
