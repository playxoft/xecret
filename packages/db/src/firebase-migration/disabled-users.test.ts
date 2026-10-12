import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import type { BackfillDbRow } from './backfill';
import { planDisabledSoftDelete, softDeleteDisabledRow } from './disabled-users';

const row = (over: Partial<BackfillDbRow> & { id: string }): BackfillDbRow => ({
  firebaseUid: null,
  workosUserId: null,
  email: `${over.id}@example.com`,
  deleted: false,
  ...over,
});

describe('planDisabledSoftDelete', () => {
  it('lists every disabled user with a row, with what will happen to it', () => {
    const plan = planDisabledSoftDelete({
      rows: [
        row({ id: 'r1', firebaseUid: 'fbOff1' }),
        row({ id: 'r2', firebaseUid: 'fbOff2', deleted: true }),
        row({ id: 'r3', firebaseUid: 'fbOff3', workosUserId: 'user_01GAP' }),
        row({ id: 'r4', firebaseUid: 'fbOff4' }),
        row({ id: 'r5', firebaseUid: 'fbActive' }),
        row({ id: 'r6' }),
      ],
      disabledUids: new Set(['fbOff1', 'fbOff2', 'fbOff3', 'fbOff4', 'fbOffNoRow']),
      keep: new Set(['fbOff4']),
    });
    expect(plan.items).toEqual([
      {
        userId: 'r1',
        firebaseUid: 'fbOff1',
        state: 'active',
        linkedWorkosUserId: null,
        kept: false,
      },
      {
        userId: 'r2',
        firebaseUid: 'fbOff2',
        state: 'already-deleted',
        linkedWorkosUserId: null,
        kept: false,
      },
      {
        userId: 'r3',
        firebaseUid: 'fbOff3',
        state: 'active',
        linkedWorkosUserId: 'user_01GAP',
        kept: false,
      },
      {
        userId: 'r4',
        firebaseUid: 'fbOff4',
        state: 'active',
        linkedWorkosUserId: null,
        kept: true,
      },
    ]);
    expect(plan.withoutRow).toEqual(['fbOffNoRow']);
    expect(plan.unknownKeep).toEqual([]);
  });

  it('reports a --keep that names no disabled user with a row', () => {
    const plan = planDisabledSoftDelete({
      rows: [row({ id: 'r1', firebaseUid: 'fbOff1' }), row({ id: 'r5', firebaseUid: 'fbActive' })],
      disabledUids: new Set(['fbOff1']),
      keep: new Set(['fbActive', 'fbTypo']),
    });
    expect(plan.unknownKeep).toEqual(['fbActive', 'fbTypo']);
  });
});

describe('softDeleteDisabledRow (real PostgreSQL, real migrations)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, TEST_DATABASE_TIMEOUT_MS);

  afterAll(async () => {
    await t.close();
  });

  async function seedUser(over: { deleted?: boolean } = {}) {
    const id = randomUUID();
    const firebaseUid = `fb${id.replaceAll('-', '').slice(0, 26)}`;
    await t.pg.query(
      `insert into users (id, firebase_uid, email, deleted_at) values ($1, $2, $3, $4)`,
      [id, firebaseUid, `${id}@example.com`, over.deleted ? new Date() : null],
    );
    const orgId = randomUUID();
    await t.pg.query(
      `insert into organizations (id, name, slug, created_by) values ($1, 'Org', $2, $3)`,
      [orgId, `org-${orgId.slice(0, 8)}`, id],
    );
    for (let i = 0; i < 2; i += 1) {
      await t.pg.query(
        `insert into sessions (id, user_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '1 day')`,
        [randomUUID(), id, randomBytes(32)],
      );
    }
    await t.pg.query(
      `insert into cli_tokens (id, user_id, org_id, name, token_hash, token_prefix)
       values ($1, $2, $3, 'laptop', $4, 'test-prefix')`,
      [randomUUID(), id, orgId, randomBytes(32)],
    );
    return { id, firebaseUid, orgId };
  }

  async function stateOf(id: string) {
    const user = await t.pg.query<{ deleted_at: Date | null; workos_user_id: string | null }>(
      `select deleted_at, workos_user_id from users where id = $1`,
      [id],
    );
    const live = await t.pg.query<{ sessions: number; tokens: number }>(
      `select (select count(*)::int from sessions where user_id = $1 and revoked_at is null) as sessions,
              (select count(*)::int from cli_tokens where user_id = $1 and revoked_at is null) as tokens`,
      [id],
    );
    return { deleted: user.rows[0]?.deleted_at != null, ...live.rows[0] };
  }

  it('soft-deletes the row and revokes its sessions and CLI tokens, touching nothing else', async () => {
    const a = await seedUser();
    const b = await seedUser();
    expect(await softDeleteDisabledRow(t.db, a.id, a.firebaseUid)).toEqual({
      result: 'soft-deleted',
      revokedSessions: 2,
      revokedCliTokens: 1,
    });
    expect(await stateOf(a.id)).toEqual({ deleted: true, sessions: 0, tokens: 0 });
    expect(await stateOf(b.id)).toEqual({ deleted: false, sessions: 2, tokens: 1 });
    // Less than account deletion: the organisation it founded is untouched.
    const org = await t.pg.query<{ deleted_at: Date | null }>(
      `select deleted_at from organizations where id = $1`,
      [a.orgId],
    );
    expect(org.rows[0]?.deleted_at).toBeNull();
  });

  it('is idempotent, and writes nothing to a row that is not active', async () => {
    const a = await seedUser();
    await softDeleteDisabledRow(t.db, a.id, a.firebaseUid);
    expect(await softDeleteDisabledRow(t.db, a.id, a.firebaseUid)).toEqual({
      result: 'not-active',
    });
    const gone = await seedUser({ deleted: true });
    expect(await softDeleteDisabledRow(t.db, gone.id, gone.firebaseUid)).toEqual({
      result: 'not-active',
    });
    // A deleted row's sessions are left as they were: nothing was decided about it here.
    expect(await stateOf(gone.id)).toEqual({ deleted: true, sessions: 2, tokens: 1 });
  });

  it('refuses a row that no longer carries the Firebase uid it was planned for', async () => {
    const a = await seedUser();
    expect(await softDeleteDisabledRow(t.db, a.id, 'fbSomebodyElse')).toEqual({
      result: 'not-active',
    });
    expect(await stateOf(a.id)).toEqual({ deleted: false, sessions: 2, tokens: 1 });
  });
});
