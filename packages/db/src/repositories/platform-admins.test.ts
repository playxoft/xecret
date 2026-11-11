import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  addPlatformAdmin,
  isPlatformAdmin,
  listPlatformAdmins,
  removePlatformAdmin,
} from './platform-admins';

/**
 * The admin list (migration 0035), against a real database: the rule that
 * there is always one is a lock and a count, and only a database shows whether
 * two removals at once can get past it.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.pg.query('delete from platform_admins');
});

async function seedUser(over: { deleted?: boolean } = {}): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `staff-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified, deleted_at)
     values ($1, $2, $3, true, $4)`,
    [id, `user_01${id.replaceAll('-', '').slice(0, 20)}`, email, over.deleted ? new Date() : null],
  );
  return { id, email };
}

async function changes(userId: string) {
  const result = await t.pg.query<{
    action: string;
    by_user_id: string | null;
    by_label: string | null;
  }>(
    `select action, by_user_id, by_label from platform_admin_changes where user_id = $1 order by at, id`,
    [userId],
  );
  return result.rows;
}

describe('the admin list', () => {
  it('adds an account once, and records who did it', async () => {
    const first = await seedUser();
    const second = await seedUser();

    expect(
      await t.db.transaction((tx) =>
        addPlatformAdmin(tx, { ...emailOf(first), by: { label: 'operator: ops' } }),
      ),
    ).toBe('added');
    expect(
      await t.db.transaction((tx) =>
        addPlatformAdmin(tx, { ...emailOf(second), by: { userId: first.id } }),
      ),
    ).toBe('added');
    expect(
      await t.db.transaction((tx) =>
        addPlatformAdmin(tx, { ...emailOf(second), by: { userId: first.id } }),
      ),
    ).toBe('already');

    expect(await isPlatformAdmin(t.db, second.id)).toBe(true);
    expect(await changes(second.id)).toEqual([
      { action: 'added', by_user_id: first.id, by_label: null },
    ]);
    const listed = await listPlatformAdmins(t.db);
    expect(listed.map((admin) => admin.userId)).toEqual([first.id, second.id]);
    expect(listed[1]?.addedByEmail).toBe(first.email);
    expect(listed[0]?.addedByEmail).toBeNull();
  });

  it('never counts a deleted account as an admin', async () => {
    const gone = await seedUser();
    await t.db.transaction((tx) =>
      addPlatformAdmin(tx, { ...emailOf(gone), by: { label: 'operator' } }),
    );
    await t.pg.query('update users set deleted_at = now() where id = $1', [gone.id]);

    expect(await isPlatformAdmin(t.db, gone.id)).toBe(false);
    expect(await listPlatformAdmins(t.db)).toEqual([]);
  });

  it('removes an admin and records it — but never the last one', async () => {
    const first = await seedUser();
    const second = await seedUser();
    for (const user of [first, second]) {
      await t.db.transaction((tx) =>
        addPlatformAdmin(tx, { ...emailOf(user), by: { label: 'operator' } }),
      );
    }

    expect(
      await t.db.transaction((tx) =>
        removePlatformAdmin(tx, { ...emailOf(second), by: { userId: first.id } }),
      ),
    ).toBe('removed');
    expect(await isPlatformAdmin(t.db, second.id)).toBe(false);
    expect((await changes(second.id)).map((change) => change.action)).toEqual(['added', 'removed']);

    expect(
      await t.db.transaction((tx) =>
        removePlatformAdmin(tx, { ...emailOf(first), by: { userId: first.id } }),
      ),
    ).toBe('last');
    expect(await isPlatformAdmin(t.db, first.id)).toBe(true);

    expect(
      await t.db.transaction((tx) =>
        removePlatformAdmin(tx, { ...emailOf(second), by: { userId: first.id } }),
      ),
    ).toBe('not-admin');
  });

  it('does not count a deleted admin towards keeping somebody', async () => {
    const live = await seedUser();
    const gone = await seedUser();
    for (const user of [live, gone]) {
      await t.db.transaction((tx) =>
        addPlatformAdmin(tx, { ...emailOf(user), by: { label: 'operator' } }),
      );
    }
    await t.pg.query('update users set deleted_at = now() where id = $1', [gone.id]);

    expect(
      await t.db.transaction((tx) =>
        removePlatformAdmin(tx, { ...emailOf(live), by: { label: 'operator' } }),
      ),
    ).toBe('last');
  });

  it('records every change with somebody behind it, by the database itself', async () => {
    const user = await seedUser();
    await expect(
      t.pg.query(
        `insert into platform_admin_changes (action, user_id, email) values ('added', $1, $2)`,
        [user.id, user.email],
      ),
    ).rejects.toThrow(/platform_admin_changes_by_check/);
  });
});

function emailOf(user: { id: string; email: string }): { userId: string; email: string } {
  return { userId: user.id, email: user.email };
}
