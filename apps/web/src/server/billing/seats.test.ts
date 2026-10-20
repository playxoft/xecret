import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { UNCAPPED_SEAT_LIMIT } from '@xecret/core/entitlements';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { findSubscription, listSeatSyncs } from '@xecret/db/repositories';
import type { Bindings } from '../bindings';
import { createLogger } from '../logging';
import type { LogEntry } from '../logging';

/**
 * Seat sync: the membership changes, the bill follows — after the commit,
 * with every failure left as a debt rather than a lost change. Dodo is a stub
 * here; nothing reaches it.
 */

const dodo = vi.hoisted(() => ({ changePlan: vi.fn() }));
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  billingProvider: () => dodo,
}));

const { assertNotStillBilled, syncSeats } = await import('./seats');
const { DodoApiError } = await import('./client');

let t: TestDatabase;
let lines: LogEntry[] = [];

const BILLING_ENV = {
  XECRET_ENV: 'production',
  XECRET_PUBLIC_URL: 'https://xecret.playxoft.com',
  DODO_API_KEY: 'dodo-example-not-a-real-key',
  DODO_WEBHOOK_SECRET: `whsec_${btoa('example-not-a-real-key-32-bytes!')}`,
  DODO_ENVIRONMENT: 'test_mode',
  DODO_PRODUCT_PRO_MONTHLY: 'pdt_pro_m',
  DODO_PRODUCT_PRO_YEARLY: 'pdt_pro_y',
  DODO_PRODUCT_TEAM_MONTHLY: 'pdt_team_m',
  DODO_PRODUCT_TEAM_YEARLY: 'pdt_team_y',
  DODO_METER_SECRET_FETCH: 'secret_fetch_kilo',
};

function services(env: Record<string, unknown> = BILLING_ENV) {
  return {
    env: env as unknown as Bindings,
    db: t.db,
    log: createLogger({
      sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
    }).logger,
    meta: {
      requestId: randomUUID(),
      rayId: null,
      ipAddress: null,
      userAgent: null,
      method: 'POST',
      path: '/',
      startedAt: Date.now(),
    },
  };
}

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  dodo.changePlan.mockReset();
  dodo.changePlan.mockResolvedValue(undefined);
  lines = [];
});

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_01${id.replaceAll('-', '').slice(0, 20)}`, `p-${id.slice(0, 8)}@example.com`],
  );
  return id;
}

async function addMember(orgId: string, status = 'active'): Promise<void> {
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role, status) values ($1, $2, $3, 'developer', $4)`,
    [randomUUID(), orgId, await seedUser(), status],
  );
}

/** A Team organisation Dodo bills `billed` seats for, with `members` seated. */
async function billedOrg(
  billed: number,
  members: number,
  over: Record<string, unknown> = {},
): Promise<string> {
  const ownerId = await seedUser();
  const orgId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, seat_limit) values ($1, 'Acme', $2, $3, $4)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, ownerId, UNCAPPED_SEAT_LIMIT],
  );
  const row = {
    plan: 'team',
    billing_interval: 'monthly',
    status: 'active',
    seats: billed,
    dodo_subscription_id: `sub_${orgId.slice(0, 12)}`,
    dodo_customer_id: 'cus_example0001',
    dodo_product_id: 'pdt_team_m',
    ...over,
  };
  const columns = ['org_id', ...Object.keys(row)];
  await t.pg.query(
    `insert into org_subscriptions (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    [orgId, ...Object.values(row)],
  );
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, ownerId],
  );
  for (let index = 1; index < members; index += 1) await addMember(orgId);
  return orgId;
}

async function auditActions(
  orgId: string,
): Promise<{ action: string; outcome: string; metadata: Record<string, unknown> }[]> {
  const result = await t.pg.query<{
    action: string;
    outcome: string;
    metadata: Record<string, unknown>;
  }>(`select action, outcome, metadata from audit_logs where org_id = $1 order by id`, [orgId]);
  return result.rows;
}

describe('syncSeats', () => {
  it('pushes a new member to Dodo — the difference charged now — and records it', async () => {
    const orgId = await billedOrg(3, 4);

    expect(await syncSeats(services(), orgId)).toBe('synced');

    expect(dodo.changePlan).toHaveBeenCalledTimes(1);
    expect(dodo.changePlan).toHaveBeenCalledWith(`sub_${orgId.slice(0, 12)}`, {
      productId: 'pdt_team_m',
      quantity: 4,
      proration: 'difference_immediately',
      effectiveAt: 'immediately',
      onPaymentFailure: 'apply_change',
    });
    expect((await findSubscription(t.db, orgId))?.seats).toBe(4);
    expect((await listSeatSyncs(t.db, 1000)).some((debt) => debt.orgId === orgId)).toBe(false);
    expect(await auditActions(orgId)).toEqual([
      {
        action: 'billing.seats_synced',
        outcome: 'success',
        metadata: { seatCount: 4, previousSeatCount: 3 },
      },
    ]);
  });

  it('bills a suspended member exactly as before — suspension is never a discount', async () => {
    const orgId = await billedOrg(4, 3);
    await addMember(orgId, 'suspended');
    expect(await syncSeats(services(), orgId)).toBe('in-sync');
    expect(dodo.changePlan).not.toHaveBeenCalled();
  });

  it('does not bill a pending invitation until it is accepted', async () => {
    const orgId = await billedOrg(3, 3);
    await t.pg.query(
      `insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
       select $1, $2, 'later@example.com', 'viewer', $3, user_id, now() + interval '7 days'
         from org_members where org_id = $2 and role = 'owner'`,
      [randomUUID(), orgId, new Uint8Array(32).fill(5)],
    );
    expect(await syncSeats(services(), orgId)).toBe('in-sync');
    expect(dodo.changePlan).not.toHaveBeenCalled();
  });

  it('never bills below the plan’s minimum when members leave', async () => {
    const orgId = await billedOrg(5, 2);
    await syncSeats(services(), orgId);
    expect(dodo.changePlan.mock.calls[0]![1]).toMatchObject({ quantity: 3 });
  });

  it('leaves a debt, and changes nothing, when Dodo cannot be reached — and never throws', async () => {
    const orgId = await billedOrg(3, 4);
    dodo.changePlan.mockRejectedValue(new DodoApiError('upstream_5xx', 503));

    expect(await syncSeats(services(), orgId)).toBe('failed');

    expect((await findSubscription(t.db, orgId))?.seats).toBe(3);
    const debt = (await listSeatSyncs(t.db, 1000)).find((row) => row.orgId === orgId);
    expect(debt).toMatchObject({ attempts: 1, lastError: 'upstream_5xx' });
    const [record] = await auditActions(orgId);
    expect(record).toMatchObject({
      action: 'billing.seats_synced',
      outcome: 'error',
      metadata: { seatCount: 4, previousSeatCount: 3, reason: 'upstreamUnavailable' },
    });

    // The retry, once Dodo is back, pays the debt.
    dodo.changePlan.mockResolvedValue(undefined);
    expect(await syncSeats(services(), orgId)).toBe('synced');
    expect((await listSeatSyncs(t.db, 1000)).some((row) => row.orgId === orgId)).toBe(false);
  });

  it('converges on the latest count when somebody joins while a push is in flight', async () => {
    const orgId = await billedOrg(3, 4);
    dodo.changePlan.mockImplementationOnce(async () => {
      await addMember(orgId); // a fifth, joining mid-push
    });

    expect(await syncSeats(services(), orgId)).toBe('synced');

    expect(
      dodo.changePlan.mock.calls.map((call) => (call[1] as { quantity: number }).quantity),
    ).toEqual([4, 5]);
    expect((await findSubscription(t.db, orgId))?.seats).toBe(5);
  });

  it('touches nothing for Free, for an operator’s grant, or with payments off', async () => {
    const free = await billedOrg(1, 4, {
      plan: 'free',
      billing_interval: null,
      dodo_subscription_id: null,
      dodo_product_id: null,
    });
    const manual = await billedOrg(10, 4, {
      plan: 'enterprise',
      billing_interval: 'yearly',
      dodo_subscription_id: null,
    });
    expect(await syncSeats(services(), free)).toBe('not-billed');
    expect(await syncSeats(services(), manual)).toBe('not-billed');

    const paid = await billedOrg(3, 4);
    expect(await syncSeats(services({ XECRET_ENV: 'production' }), paid)).toBe('off');
    expect(dodo.changePlan).not.toHaveBeenCalled();
  });

  it('queues the change, loudly, on a half-configured deployment', async () => {
    const orgId = await billedOrg(3, 4);
    expect(await syncSeats(services({ ...BILLING_ENV, DODO_API_KEY: undefined }), orgId)).toBe(
      'failed',
    );
    expect((await listSeatSyncs(t.db, 1000)).some((row) => row.orgId === orgId)).toBe(true);
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('never logs the customer id', async () => {
    const orgId = await billedOrg(3, 4);
    dodo.changePlan.mockRejectedValue(new DodoApiError('invalid', 422, 'BAD'));
    await syncSeats(services(), orgId);
    expect(JSON.stringify(lines)).not.toContain('cus_example0001');
  });
});

describe('assertNotStillBilled', () => {
  it('refuses to delete an organisation Dodo would keep billing', async () => {
    const orgId = await billedOrg(3, 1);
    await expect(assertNotStillBilled(t.db, orgId)).rejects.toThrow(/Cancel it first/);
  });

  it('allows it once the subscription is set to end, and for Free or an operator’s grant', async () => {
    await expect(
      assertNotStillBilled(t.db, await billedOrg(3, 1, { cancel_at_period_end: true })),
    ).resolves.toBeUndefined();
    await expect(
      assertNotStillBilled(
        t.db,
        await billedOrg(1, 1, {
          plan: 'free',
          billing_interval: null,
          dodo_subscription_id: null,
          dodo_product_id: null,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertNotStillBilled(
        t.db,
        await billedOrg(10, 1, {
          plan: 'enterprise',
          billing_interval: 'yearly',
          dodo_subscription_id: null,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
