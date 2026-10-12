import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import { checkMappedUser, loadBackfillRows, planBackfill, writeBackfillLink } from './backfill';
import type { BackfillDbRow } from './backfill';
import type { MappingEntry } from './mapping';
import type { WorkosUserSummary } from './workos-api';

const entry = (over: Partial<MappingEntry> = {}): MappingEntry => ({
  workosUserId: 'user_01AAA',
  outcome: 'created',
  passwordImported: true,
  recordedAt: '2026-10-12T00:00:00.000Z',
  ...over,
});

const workosUser = (over: Partial<WorkosUserSummary> = {}): WorkosUserSummary => ({
  id: 'user_01AAA',
  email: 'ada@example.com',
  emailVerified: true,
  externalId: 'fbA',
  ...over,
});

describe('checkMappedUser', () => {
  it('accepts a verified user whose external id is the uid', () => {
    expect(checkMappedUser('fbA', entry(), 'ada@example.com', workosUser())).toBeNull();
    // The address may have moved since: the external id is the proof.
    expect(checkMappedUser('fbA', entry(), 'old@example.com', workosUser())).toBeNull();
  });

  it('refuses an id the environment in use does not have (the wrong environment’s mapping)', () => {
    expect(checkMappedUser('fbA', entry(), 'ada@example.com', null)).toBe('workos-user-missing');
    expect(checkMappedUser('fbA', entry(), 'ada@example.com', workosUser({ id: 'user_02' }))).toBe(
      'workos-user-missing',
    );
  });

  it('refuses a user that is not provably this Firebase account', () => {
    expect(
      checkMappedUser('fbA', entry(), 'ada@example.com', workosUser({ externalId: 'fbB' })),
    ).toBe('workos-identity-mismatch');
    // Without an external id, only a reused user may prove itself by address…
    expect(
      checkMappedUser('fbA', entry(), 'ada@example.com', workosUser({ externalId: null })),
    ).toBe('workos-identity-mismatch');
    // …and only by the same address.
    expect(
      checkMappedUser(
        'fbA',
        entry({ outcome: 'reuse-existing' }),
        'grace@example.com',
        workosUser({ externalId: null }),
      ),
    ).toBe('workos-identity-mismatch');
    expect(
      checkMappedUser(
        'fbA',
        entry({ outcome: 'reuse-existing' }),
        null,
        workosUser({ externalId: null }),
      ),
    ).toBe('workos-identity-mismatch');
  });

  it('accepts a reused user by its address', () => {
    expect(
      checkMappedUser(
        'fbA',
        entry({ outcome: 'reuse-existing' }),
        'ADA@example.com',
        workosUser({ externalId: null }),
      ),
    ).toBeNull();
  });

  it('refuses an unverified user even when it is provably the one', () => {
    expect(
      checkMappedUser('fbA', entry(), 'ada@example.com', workosUser({ emailVerified: false })),
    ).toBe('workos-user-unverified');
  });
});

describe('planBackfill', () => {
  const row = (over: Partial<BackfillDbRow>): BackfillDbRow => ({
    id: 'row',
    firebaseUid: null,
    workosUserId: null,
    deleted: false,
    ...over,
  });

  it('decides every row, and lists what has no row', () => {
    const plan = planBackfill({
      rows: [
        row({ id: 'r1', firebaseUid: 'fb1' }),
        row({ id: 'r2', firebaseUid: 'fb2', deleted: true }),
        row({ id: 'r3', firebaseUid: 'fb3', workosUserId: 'user_03' }),
        row({ id: 'r4', firebaseUid: 'fb4', workosUserId: 'user_04old' }),
        row({ id: 'r5', firebaseUid: 'fb5' }),
        row({ id: 'r6', firebaseUid: 'fb6' }),
        row({ id: 'r7', firebaseUid: 'fbGone' }),
        row({ id: 'r8', firebaseUid: 'fb8' }),
        row({ id: 'r9', workosUserId: 'user_08' }),
        row({ id: 'r10' }),
      ],
      exportUids: new Set(['fb1', 'fb2', 'fb3', 'fb4', 'fb5', 'fb6', 'fb8', 'fbNoRow']),
      mapping: new Map([
        ['fb1', 'user_01'],
        ['fb2', 'user_02'],
        ['fb3', 'user_03'],
        ['fb4', 'user_04new'],
        ['fb8', 'user_08'],
        ['fbNoRow', 'user_99'],
      ]),
      rejected: new Map([['fb6', 'workos-user-missing' as const]]),
    });

    expect(plan.items).toEqual([
      {
        action: 'update',
        userId: 'r1',
        firebaseUid: 'fb1',
        workosUserId: 'user_01',
        deleted: false,
      },
      {
        action: 'update',
        userId: 'r2',
        firebaseUid: 'fb2',
        workosUserId: 'user_02',
        deleted: true,
      },
      { action: 'already-linked', userId: 'r3', firebaseUid: 'fb3', workosUserId: 'user_03' },
      {
        action: 'linked-elsewhere',
        userId: 'r4',
        firebaseUid: 'fb4',
        currentWorkosUserId: 'user_04old',
        mappedWorkosUserId: 'user_04new',
      },
      { action: 'not-imported', userId: 'r5', firebaseUid: 'fb5', deleted: false },
      {
        action: 'mapping-rejected',
        userId: 'r6',
        firebaseUid: 'fb6',
        reason: 'workos-user-missing',
      },
      { action: 'no-firebase-user', userId: 'r7', firebaseUid: 'fbGone', deleted: false },
      {
        action: 'held-by-other-row',
        userId: 'r8',
        firebaseUid: 'fb8',
        workosUserId: 'user_08',
        holderUserId: 'r9',
      },
    ]);
    expect(plan.firebaseUidsWithoutRow).toEqual(['fbNoRow']);
    expect(plan.rowsWithoutFirebaseUid).toBe(2);
  });
});

describe('writeBackfillLink (real PostgreSQL, real migrations)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, TEST_DATABASE_TIMEOUT_MS);

  afterAll(async () => {
    await t.close();
  });

  async function seed(over: { workosUserId?: string; deleted?: boolean } = {}) {
    const id = randomUUID();
    const firebaseUid = `fb${id.replaceAll('-', '').slice(0, 26)}`;
    await t.pg.query(
      `insert into users (id, firebase_uid, workos_user_id, email, deleted_at) values ($1, $2, $3, $4, $5)`,
      [
        id,
        firebaseUid,
        over.workosUserId ?? null,
        `${id}@example.com`,
        over.deleted ? new Date() : null,
      ],
    );
    return { id, firebaseUid };
  }

  async function linkOf(id: string) {
    const result = await t.pg.query<{ workos_user_id: string | null }>(
      `select workos_user_id from users where id = $1`,
      [id],
    );
    return result.rows[0]?.workos_user_id;
  }

  const workosId = () => `user_01T${randomUUID().replaceAll('-', '').slice(0, 20)}`;

  it('links an unlinked row by its Firebase uid', async () => {
    const { id, firebaseUid } = await seed();
    const w = workosId();
    expect(await writeBackfillLink(t.db, firebaseUid, w)).toEqual({ result: 'updated' });
    expect(await linkOf(id)).toBe(w);
  });

  it('is idempotent: the same link again is already-linked, not an error', async () => {
    const { firebaseUid } = await seed();
    const w = workosId();
    await writeBackfillLink(t.db, firebaseUid, w);
    expect(await writeBackfillLink(t.db, firebaseUid, w)).toEqual({ result: 'already-linked' });
  });

  it('never overwrites a link a sign-in already made', async () => {
    const existing = workosId();
    const { id, firebaseUid } = await seed({ workosUserId: existing });
    expect(await writeBackfillLink(t.db, firebaseUid, workosId())).toEqual({
      result: 'linked-elsewhere',
      currentWorkosUserId: existing,
    });
    expect(await linkOf(id)).toBe(existing);
  });

  it('reports 23505 — the WorkOS id is already on another row — and names that row', async () => {
    const taken = workosId();
    const holder = await seed({ workosUserId: taken });
    const { id, firebaseUid } = await seed();
    expect(await writeBackfillLink(t.db, firebaseUid, taken)).toEqual({
      result: 'unique-violation',
      holderUserId: holder.id,
    });
    expect(await linkOf(id)).toBeNull();
  });

  it('reports 23514 — not a WorkOS id — and writes nothing', async () => {
    const { id, firebaseUid } = await seed();
    expect(await writeBackfillLink(t.db, firebaseUid, firebaseUid)).toEqual({
      result: 'format-violation',
    });
    expect(await linkOf(id)).toBeNull();
  });

  it('links a soft-deleted row too (the linking pass refuses it either way)', async () => {
    const { id, firebaseUid } = await seed({ deleted: true });
    const w = workosId();
    expect(await writeBackfillLink(t.db, firebaseUid, w)).toEqual({ result: 'updated' });
    expect(await linkOf(id)).toBe(w);
  });

  it('reports a uid with no row', async () => {
    expect(await writeBackfillLink(t.db, 'fbNobodyHasThisUid', workosId())).toEqual({
      result: 'row-missing',
    });
  });

  it('writes only workos_user_id, and only on the matching row', async () => {
    const a = await seed();
    const b = await seed();
    const before = await t.pg.query(`select * from users where id = $1`, [a.id]);
    await writeBackfillLink(t.db, a.firebaseUid, workosId());
    const after = await t.pg.query<Record<string, unknown>>(`select * from users where id = $1`, [
      a.id,
    ]);
    const changed = Object.keys(after.rows[0] ?? {}).filter(
      (k) =>
        JSON.stringify((before.rows[0] as Record<string, unknown>)[k]) !==
        JSON.stringify(after.rows[0]?.[k]),
    );
    expect(changed).toEqual(['workos_user_id']);
    expect(await linkOf(b.id)).toBeNull();
  });

  it('loads every row with the fields the planner needs', async () => {
    const { id, firebaseUid } = await seed({ deleted: true });
    const rows = await loadBackfillRows(t.db);
    expect(rows.find((r) => r.id === id)).toEqual({
      id,
      firebaseUid,
      workosUserId: null,
      deleted: true,
    });
  });
});
