import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FREE_SEAT_LIMIT } from '@xecret/core/entitlements';
import { billedByDodo, carriesProviderIds, operatorManaged } from '../repositories/billing';
import { findSubscription } from '../repositories/subscriptions';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';

/**
 * Migration 0033: the Free plan seats three — the column default, and the
 * backfill of the Free organisations still sitting on the old default of 5.
 *
 * Every migration has already run on this database, on no rows. Each test seeds
 * the organisations it asserts on, in the states the backfill has to tell
 * apart, with the old default written explicitly, and then runs the backfill's
 * own statement, read out of the migration file, so what is tested is what
 * ships — warnings captured, because the warnings are how an operator learns
 * what was left. No test reads a row another left behind, so any one of them
 * runs alone.
 */

const MIGRATION = fileURLToPath(
  new URL('../../migrations/0033_free_seat_limit.sql', import.meta.url),
);

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

/** The migration's statements, as the migrator splits them, without comment lines. */
function statements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

/** Runs the backfill and returns the warnings it raised. */
async function backfill(): Promise<string[]> {
  const block = statements().find((statement) => statement.startsWith('DO $$'));
  expect(block).toBeDefined();
  const warnings: string[] = [];
  await t.pg.exec(block!, {
    onNotice: (notice) => {
      if (notice.severity === 'WARNING') warnings.push(notice.message ?? '');
    },
  });
  return warnings;
}

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_${id.slice(0, 8)}`, `m33-${id.slice(0, 8)}@example.com`],
  );
  return id;
}

interface Seed {
  plan?: 'free' | 'pro' | 'team' | null;
  seatLimit?: number;
  seated?: number;
  /** Members holding a seat while suspended — suspension frees no seat. */
  suspended?: number;
  /** Members with no seat assigned, who are not counted. */
  unseated?: number;
  openInvitations?: number;
  /** Invitations that no longer promise a seat: one expired, one revoked, one accepted. */
  closedInvitations?: boolean;
  subscription?: Record<string, unknown>;
  deleted?: boolean;
}

/** An organisation as it stood before the migration: `seat_limit` the old default unless said. */
async function seedOrg(seed: Seed = {}): Promise<string> {
  const founder = await seedUser();
  const orgId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, seat_limit, deleted_at)
     values ($1, 'Acme', $2, $3, $4, $5)`,
    [
      orgId,
      `m33-${orgId.slice(0, 8)}`,
      founder,
      seed.seatLimit ?? 5,
      seed.deleted ? new Date() : null,
    ],
  );

  const plan = seed.plan === undefined ? 'free' : seed.plan;
  if (plan !== null) {
    const columns = {
      plan,
      billing_interval: plan === 'free' ? null : 'monthly',
      ...seed.subscription,
    };
    const names = Object.keys(columns);
    await t.pg.query(
      `insert into org_subscriptions (org_id, ${names.join(', ')})
       values ($1, ${names.map((_, index) => `$${index + 2}`).join(', ')})`,
      [orgId, ...Object.values(columns)],
    );
  }

  const member = async (status: 'active' | 'suspended', seatAssigned: boolean, role: string) =>
    t.pg.query(
      `insert into org_members (id, org_id, user_id, role, status, seat_assigned)
       values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), orgId, await seedUser(), role, status, seatAssigned],
    );
  // The founder holds the first seat, as provisioning seats them.
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, founder],
  );
  for (let i = 1; i < (seed.seated ?? 1); i += 1) await member('active', true, 'developer');
  for (let i = 0; i < (seed.suspended ?? 0); i += 1) await member('suspended', true, 'developer');
  for (let i = 0; i < (seed.unseated ?? 0); i += 1) await member('active', false, 'viewer');

  const invite = async (over: { expiresAt?: string; revoked?: boolean; accepted?: boolean }) =>
    t.pg.query(
      `insert into invitations
         (id, org_id, email, role, token_hash, invited_by, expires_at, revoked_at, accepted_at, accepted_by)
       values ($1, $2, $3, 'developer', $4, $5, now() + ($6)::interval, $7, $8, $9)`,
      [
        randomUUID(),
        orgId,
        `invitee-${randomUUID().slice(0, 8)}@example.com`,
        new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
        founder,
        over.expiresAt ?? '7 days',
        over.revoked ? new Date() : null,
        over.accepted ? new Date() : null,
        over.accepted ? founder : null,
      ],
    );
  for (let i = 0; i < (seed.openInvitations ?? 0); i += 1) await invite({});
  if (seed.closedInvitations) {
    await invite({ expiresAt: '-1 day' });
    await invite({ revoked: true });
    await invite({ accepted: true });
  }

  return orgId;
}

async function seatLimitOf(orgId: string): Promise<number> {
  const result = await t.pg.query<{ seat_limit: number }>(
    `select seat_limit from organizations where id = $1`,
    [orgId],
  );
  return result.rows[0]!.seat_limit;
}

const warnedAbout = (warnings: string[], orgId: string) =>
  warnings.filter((warning) => warning.includes(orgId));

describe('migration 0033, the column default', () => {
  it('creates an organisation with the Free plan’s three seats', async () => {
    const result = await t.pg.query<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_name = 'organizations' and column_name = 'seat_limit'`,
    );
    expect(Number(result.rows[0]!.column_default)).toBe(3);
    expect(FREE_SEAT_LIMIT).toBe(3);

    const founder = await seedUser();
    const orgId = randomUUID();
    await t.pg.query(
      `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
      [orgId, `m33-${orgId.slice(0, 8)}`, founder],
    );
    expect(await seatLimitOf(orgId)).toBe(3);
  });
});

describe('migration 0033, the backfill', () => {
  it('moves a one-person Free organisation from 5 to 3, and says nothing about it', async () => {
    const orgId = await seedOrg();
    const warnings = await backfill();
    expect(await seatLimitOf(orgId)).toBe(3);
    expect(warnedAbout(warnings, orgId)).toEqual([]);
  });

  it('reads an organisation with no subscription row as Free, as entitlement resolution does', async () => {
    const orgId = await seedOrg({ plan: null });
    await backfill();
    expect(await seatLimitOf(orgId)).toBe(3);
  });

  it('moves one already holding exactly three seats — at its limit, not over it', async () => {
    const seated = await seedOrg({ seated: 3 });
    const promised = await seedOrg({ seated: 2, openInvitations: 1 });
    await backfill();
    expect(await seatLimitOf(seated)).toBe(3);
    expect(await seatLimitOf(promised)).toBe(3);
  });

  it('counts neither an unseated member nor an invitation that no longer promises a seat', async () => {
    const orgId = await seedOrg({ seated: 2, unseated: 2, closedInvitations: true });
    await backfill();
    expect(await seatLimitOf(orgId)).toBe(3);
  });

  it('leaves an organisation seating more than three at 5, and reports it', async () => {
    const orgId = await seedOrg({ seated: 4 });
    const warnings = await backfill();
    expect(await seatLimitOf(orgId)).toBe(5);
    expect(warnedAbout(warnings, orgId)).toEqual([
      expect.stringMatching(/4 seated member\(s\) and 0 open invitation\(s\)/),
    ]);
  });

  it('counts a suspended member and an open invitation as seats taken', async () => {
    const suspended = await seedOrg({ seated: 3, suspended: 1 });
    const promised = await seedOrg({ seated: 2, openInvitations: 2 });
    const warnings = await backfill();

    expect(await seatLimitOf(suspended)).toBe(5);
    expect(await seatLimitOf(promised)).toBe(5);
    expect(warnedAbout(warnings, suspended)).toEqual([
      expect.stringMatching(/4 seated member\(s\) and 0 open invitation\(s\)/),
    ]);
    expect(warnedAbout(warnings, promised)).toEqual([
      expect.stringMatching(/2 seated member\(s\) and 2 open invitation\(s\)/),
    ]);
  });

  it('leaves a Free organisation that carries anything of a Dodo subscription, and reports it', async () => {
    // A paid checkout waiting for its activation — billed by Dodo.
    const awaiting = await seedOrg({
      subscription: { dodo_subscription_id: `sub_${randomUUID()}` },
    });
    // A subscription that ended: ids kept, the 5 written by the ending.
    const ended = await seedOrg({
      subscription: {
        dodo_subscription_id: `sub_${randomUUID()}`,
        dodo_customer_id: `cus_${randomUUID()}`,
        dodo_event_at: new Date(),
        dodo_mode: 'live_mode',
      },
    });
    // Each remaining provider column on its own: any one of them is enough.
    const lone = await Promise.all(
      [
        { dodo_customer_id: `cus_${randomUUID()}` },
        { dodo_product_id: 'pdt_pro_monthly' },
        { dodo_event_id: `evt_${randomUUID()}` },
        { dodo_scheduled_change_at: new Date() },
        { dodo_mode: 'test_mode' },
        { dodo_event_at: new Date() },
      ].map((subscription) => seedOrg({ subscription })),
    );

    const warnings = await backfill();
    for (const orgId of [awaiting, ended, ...lone]) {
      expect(await seatLimitOf(orgId)).toBe(5);
      expect(warnedAbout(warnings, orgId)).toEqual([
        expect.stringMatching(/carries a Dodo subscription's ids/),
      ]);
    }
  });

  it('leaves a Free organisation support has granted an override, and reports it', async () => {
    const overridden = await seedOrg({ subscription: { limit_overrides: { projects: 50 } } });
    const empty = await seedOrg({ subscription: { limit_overrides: {} } });
    // A JSON `null` in the column — what a cleared override can leave — is no
    // override either.
    const jsonNull = await seedOrg();
    await t.pg.query(
      `update org_subscriptions set limit_overrides = 'null'::jsonb where org_id = $1`,
      [jsonNull],
    );

    const warnings = await backfill();
    expect(await seatLimitOf(overridden)).toBe(5);
    expect(warnedAbout(warnings, overridden)).toEqual([
      expect.stringMatching(/support has overridden its limits/),
    ]);
    // An empty override is no override.
    expect(await seatLimitOf(empty)).toBe(3);
    expect(await seatLimitOf(jsonNull)).toBe(3);
    expect(warnedAbout(warnings, jsonNull)).toEqual([]);
  });

  it('never touches a paid plan, a deleted organisation or one already at three, and reports none of them', async () => {
    const operatorGranted = await seedOrg({ plan: 'pro' });
    const billed = await seedOrg({
      plan: 'team',
      subscription: { dodo_subscription_id: `sub_${randomUUID()}`, dodo_product_id: 'pdt_team' },
    });
    const alreadyThree = await seedOrg({ seatLimit: 3 });
    const deleted = await seedOrg({ deleted: true });

    const warnings = await backfill();
    expect(await seatLimitOf(operatorGranted)).toBe(5);
    expect(await seatLimitOf(billed)).toBe(5);
    expect(await seatLimitOf(alreadyThree)).toBe(3);
    expect(await seatLimitOf(deleted)).toBe(5);
    for (const orgId of [operatorGranted, billed, alreadyThree, deleted]) {
      expect(warnedAbout(warnings, orgId)).toEqual([]);
    }
  });

  /**
   * A ceiling above three that is not the old default was chosen by someone —
   * support, the operator tool — and is left as it is. But it is still a Free
   * organisation seating more than its plan publishes, so it is reported.
   */
  it('leaves any other Free ceiling above three as it is set, and reports it', async () => {
    const raised = await seedOrg({ seatLimit: 10 });
    const four = await seedOrg({ seatLimit: 4 });

    const warnings = await backfill();
    expect(await seatLimitOf(raised)).toBe(10);
    expect(await seatLimitOf(four)).toBe(4);
    expect(warnedAbout(warnings, raised)).toEqual([
      expect.stringMatching(/keeps seat_limit 10: a ceiling above the Free plan's 3/),
    ]);
    expect(warnedAbout(warnings, four)).toEqual([expect.stringMatching(/keeps seat_limit 4/)]);
  });

  /**
   * The SQL restates the billing repository's predicates, because a migration
   * cannot call them. This holds the two together: across every subscription
   * shape a Free row can take, the backfill moves exactly the rows those
   * predicates say belong to nobody but the organisation.
   */
  it('moves exactly the Free rows the billing repository says neither Dodo nor an operator manages', async () => {
    const shapes: Record<string, unknown>[] = [
      {},
      { limit_overrides: {} },
      { dodo_subscription_id: `sub_${randomUUID()}` },
      { dodo_subscription_id: `sub_${randomUUID()}`, dodo_event_at: new Date() },
      { dodo_customer_id: `cus_${randomUUID()}` },
      { dodo_product_id: 'pdt_pro_monthly' },
      { dodo_mode: 'live_mode' },
      { dodo_event_id: `evt_${randomUUID()}` },
      { dodo_scheduled_change_at: new Date() },
    ];
    const seeded = await Promise.all(shapes.map((subscription) => seedOrg({ subscription })));

    await backfill();

    let moved = 0;
    for (const orgId of seeded) {
      const row = await findSubscription(t.db, orgId);
      expect(row, orgId).not.toBeNull();
      const ownOnly = !carriesProviderIds(row!) && !billedByDodo(row!) && !operatorManaged(row!);
      expect(await seatLimitOf(orgId), orgId).toBe(ownOnly ? 3 : 5);
      if (ownOnly) moved += 1;
    }
    expect(moved).toBe(2);
  });

  it('changes nothing when run again', async () => {
    const seeded = [
      await seedOrg(),
      await seedOrg({ seated: 4 }),
      await seedOrg({ seatLimit: 10 }),
      await seedOrg({ subscription: { dodo_customer_id: `cus_${randomUUID()}` } }),
    ];
    const rowsOf = async () =>
      (
        await t.pg.query(
          `select id, seat_limit, updated_at from organizations where id = any($1) order by id`,
          [seeded],
        )
      ).rows;

    await backfill();
    const before = await rowsOf();
    expect(before).toHaveLength(seeded.length);
    await backfill();
    expect(await rowsOf()).toEqual(before);
  });
});
