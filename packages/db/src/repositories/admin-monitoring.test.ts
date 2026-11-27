import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  ADMIN_OWNER_EMAILS_SHOWN,
  containsPattern,
  countAdminTotals,
  figuresOf,
  findUserForAdmin,
  listOrganizationMembersForAdmin,
  listOrganizationsForAdmin,
  listUserOrganizationsForAdmin,
  listUsersForAdmin,
  organizationFiguresForAdmin,
} from './admin-monitoring';
import type { AdminCursor, AdminPage } from './admin-monitoring';

/**
 * The admin page's monitoring reads, against a real database: what matters
 * is what a soft delete takes out of a count — at every level a secret sits
 * under — and that a newest-first page never skips or repeats a row, which
 * neither the SQL text nor a mock can show.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

const DAY = 24 * 60 * 60 * 1000;

async function seedUser(
  over: { email?: string; createdAt?: string; deleted?: boolean; verified?: boolean } = {},
): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = over.email ?? `person-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified, created_at, deleted_at)
     values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6)`,
    [
      id,
      `user_01${id.replaceAll('-', '').slice(0, 20)}`,
      email,
      over.verified ?? true,
      over.createdAt ?? null,
      over.deleted ? new Date() : null,
    ],
  );
  return { id, email };
}

async function addMember(orgId: string, userId: string, role: string, joinedAt?: string) {
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role, status, created_at)
     values ($1, $2, $3, $4, 'active', coalesce($5::timestamptz, now()))`,
    [randomUUID(), orgId, userId, role, joinedAt ?? null],
  );
}

async function seedOrg(
  over: { createdAt?: string; deleted?: boolean; owner?: { id: string } } = {},
): Promise<{ orgId: string; slug: string; ownerId: string }> {
  const owner = over.owner ?? (await seedUser());
  const orgId = randomUUID();
  const slug = `acme-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, created_at, deleted_at)
     values ($1, 'Acme', $2, $3, coalesce($4::timestamptz, now()), $5)`,
    [orgId, slug, owner.id, over.createdAt ?? null, over.deleted ? new Date() : null],
  );
  await t.pg.query(`insert into org_subscriptions (org_id) values ($1)`, [orgId]);
  await addMember(orgId, owner.id, 'owner');
  return { orgId, slug, ownerId: owner.id };
}

async function seedProject(orgId: string, createdBy: string, deleted = false): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by, deleted_at) values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      orgId,
      `Project ${id.slice(0, 4)}`,
      `p-${id.slice(0, 8)}`,
      createdBy,
      deleted ? new Date() : null,
    ],
  );
  return id;
}

async function seedEnvironment(projectId: string, deleted = false): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode, deleted_at)
     values ($1, $2, $3, $4, 'e2ee', $5)`,
    [id, projectId, `env ${id.slice(0, 4)}`, `e-${id.slice(0, 8)}`, deleted ? new Date() : null],
  );
  return id;
}

async function seedSecret(environmentId: string, createdBy: string, deleted = false) {
  const id = randomUUID();
  await t.pg.query(
    `insert into secrets (id, environment_id, name, created_by, deleted_at) values ($1, $2, $3, $4, $5)`,
    [
      id,
      environmentId,
      `KEY_${id.slice(0, 8).replaceAll('-', '_')}`,
      createdBy,
      deleted ? new Date() : null,
    ],
  );
}

async function seedInvitation(
  orgId: string,
  invitedBy: string,
  state: 'open' | 'expired' | 'accepted' | 'revoked',
) {
  await t.pg.query(
    `insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at)
     values ($1, $2, $3, 'viewer', $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      orgId,
      `invitee-${randomUUID().slice(0, 8)}@example.com`,
      randomBytes(32),
      invitedBy,
      new Date(Date.now() + (state === 'expired' ? -DAY : 7 * DAY)),
      state === 'accepted' ? new Date() : null,
      state === 'revoked' ? new Date() : null,
    ],
  );
}

async function seedSession(userId: string, method: string | null, createdAt: string) {
  await t.pg.query(
    `insert into sessions (id, user_id, token_hash, expires_at, sign_in_method, created_at)
     values ($1, $2, $3, now() + interval '30 days', $4, $5::timestamptz)`,
    [randomUUID(), userId, randomBytes(32), method, createdAt],
  );
}

/** Every page of a list, followed from the first by its cursors. */
async function everyPage<T>(
  read: (cursor: AdminCursor | undefined) => Promise<AdminPage<T>>,
): Promise<{ items: T[]; pages: number }> {
  const items: T[] = [];
  let cursor: AdminCursor | undefined;
  let pages = 0;
  for (;;) {
    const page = await read(cursor);
    pages += 1;
    items.push(...page.items);
    if (page.nextCursor === null) return { items, pages };
    cursor = page.nextCursor;
  }
}

describe('countAdminTotals', () => {
  it('counts only what is live, inside live parents, at every level a secret sits under', async () => {
    const now = new Date();
    const before = await countAdminTotals(t.db, now);

    // One live organisation holding two live projects, one environment each,
    // with live secrets in both; and a deleted thing at every level under it.
    const { orgId, ownerId } = await seedOrg();
    const project = await seedProject(orgId, ownerId);
    const other = await seedProject(orgId, ownerId);
    const env = await seedEnvironment(project);
    const otherEnv = await seedEnvironment(other);
    await seedSecret(env, ownerId);
    await seedSecret(env, ownerId);
    await seedSecret(otherEnv, ownerId);
    await seedSecret(env, ownerId, true); // a deleted secret
    const goneEnv = await seedEnvironment(project, true); // a deleted environment…
    await seedSecret(goneEnv, ownerId); // …and the live secret inside it
    const goneProject = await seedProject(orgId, ownerId, true); // a deleted project…
    await seedSecret(await seedEnvironment(goneProject), ownerId); // …with a live environment and secret

    // A deleted organisation with live everything inside it.
    const gone = await seedOrg({ deleted: true });
    const inGone = await seedEnvironment(await seedProject(gone.orgId, gone.ownerId));
    await seedSecret(inGone, gone.ownerId);

    // Accounts: two owners above, one deleted, one that signed up three weeks ago.
    await seedUser({ deleted: true });
    await seedUser({ createdAt: new Date(now.getTime() - 21 * DAY).toISOString() });

    const after = await countAdminTotals(t.db, now);

    expect(after.organizations - before.organizations).toBe(1);
    expect(after.projects - before.projects).toBe(2);
    expect(after.environments - before.environments).toBe(2);
    expect(after.secrets - before.secrets).toBe(3);
    expect(after.users - before.users).toBe(3);
    // The two owners signed up just now; the third, three weeks ago.
    expect(after.signups.last7Days - before.signups.last7Days).toBe(2);
    expect(after.signups.last30Days - before.signups.last30Days).toBe(3);
  });
});

describe('listOrganizationsForAdmin', () => {
  it('lists live organisations newest first, and its cursor neither skips nor repeats a row', async () => {
    // Three a microsecond apart, and two at the very same instant: a cursor
    // rounded to the millisecond would lose the first three, and one without
    // the id would lose one of the pair.
    const at = (micro: number) => `2031-01-01T00:00:00.1234${micro}Z`;
    const seeded = [
      await seedOrg({ createdAt: at(11) }),
      await seedOrg({ createdAt: at(12) }),
      await seedOrg({ createdAt: at(13) }),
      await seedOrg({ createdAt: at(14) }),
      await seedOrg({ createdAt: at(14) }),
    ];
    const deleted = await seedOrg({ createdAt: at(15), deleted: true });

    const { items, pages } = await everyPage((cursor) =>
      listOrganizationsForAdmin(t.db, { cursor, limit: 1 }),
    );

    const ids = items.map((org) => org.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(deleted.orgId);
    expect(pages).toBe(ids.length);

    // Newest first, the tie broken by the larger id.
    const pair = [seeded[3]!.orgId, seeded[4]!.orgId].sort().reverse();
    const expected = [...pair, seeded[2]!.orgId, seeded[1]!.orgId, seeded[0]!.orgId];
    expect(ids.filter((id) => expected.includes(id))).toEqual(expected);
    for (let index = 1; index < items.length; index += 1) {
      expect(items[index - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        items[index]!.createdAt.getTime(),
      );
    }
    expect(items.find((org) => org.id === seeded[0]!.orgId)).toMatchObject({
      role: null,
      subscription: { plan: 'free' },
    });
  });

  it('says the last page is the last, rather than offering an empty one', async () => {
    const total = (
      await everyPage((cursor) => listOrganizationsForAdmin(t.db, { cursor, limit: 100 }))
    ).items.length;
    const page = await listOrganizationsForAdmin(t.db, { limit: total });
    expect(page.items).toHaveLength(total);
    expect(page.nextCursor).toBeNull();
  });
});

describe('organizationFiguresForAdmin', () => {
  it('counts members, open invitations, projects, environments and secrets — never a deleted one', async () => {
    const { orgId, ownerId } = await seedOrg();
    const second = await seedUser();
    await addMember(orgId, second.id, 'owner', '2020-01-01T00:00:00Z');
    const developer = await seedUser();
    await addMember(orgId, developer.id, 'developer');
    const leaver = await seedUser();
    await addMember(orgId, leaver.id, 'owner');
    await t.pg.query(`update users set deleted_at = now() where id = $1`, [leaver.id]);

    await seedInvitation(orgId, ownerId, 'open');
    await seedInvitation(orgId, ownerId, 'open');
    await seedInvitation(orgId, ownerId, 'expired');
    await seedInvitation(orgId, ownerId, 'accepted');
    await seedInvitation(orgId, ownerId, 'revoked');

    const project = await seedProject(orgId, ownerId);
    const env = await seedEnvironment(project);
    await seedSecret(env, ownerId);
    await seedSecret(env, ownerId, true);
    await seedSecret(await seedEnvironment(project, true), ownerId);
    await seedSecret(await seedEnvironment(await seedProject(orgId, ownerId, true)), ownerId);

    const empty = await seedOrg();
    const gone = await seedOrg({ deleted: true });

    const figures = await organizationFiguresForAdmin(
      t.db,
      [orgId, empty.orgId, gone.orgId, orgId],
      new Date(),
    );

    const { email: firstOwner } = (
      await t.pg.query<{ email: string }>(`select email from users where id = $1`, [ownerId])
    ).rows[0]!;
    expect(figuresOf(figures, orgId)).toEqual({
      // The longest-standing owner first; a deleted account's address never.
      ownerEmails: [second.email, firstOwner],
      members: 3,
      pendingInvitations: 2,
      projects: 1,
      environments: 1,
      secrets: 1,
    });
    expect(figuresOf(figures, empty.orgId)).toMatchObject({
      members: 1,
      pendingInvitations: 0,
      projects: 0,
      environments: 0,
      secrets: 0,
    });
    // A deleted organisation is not counted at all.
    expect(figures.has(gone.orgId)).toBe(false);
    expect(figuresOf(figures, gone.orgId)).toEqual({
      ownerEmails: [],
      members: 0,
      pendingInvitations: 0,
      projects: 0,
      environments: 0,
      secrets: 0,
    });
  });

  it('answers an empty page without asking the database', async () => {
    const issued = t.statements.length;
    expect((await organizationFiguresForAdmin(t.db, [], new Date())).size).toBe(0);
    expect(t.statements.length).toBe(issued);
  });

  it('takes two statements for a page, whatever its size', async () => {
    const orgs = await Promise.all([seedOrg(), seedOrg(), seedOrg(), seedOrg()]);
    const issued = t.statements.length;
    await organizationFiguresForAdmin(
      t.db,
      orgs.map((org) => org.orgId),
      new Date(),
    );
    expect(t.statements.length - issued).toBe(2);
  });

  it('names at most a handful of owners for one organisation', async () => {
    const { orgId } = await seedOrg();
    for (let index = 0; index < ADMIN_OWNER_EMAILS_SHOWN + 2; index += 1) {
      await addMember(orgId, (await seedUser()).id, 'owner');
    }
    const figures = figuresOf(await organizationFiguresForAdmin(t.db, [orgId], new Date()), orgId);
    expect(figures.ownerEmails).toHaveLength(ADMIN_OWNER_EMAILS_SHOWN);
    expect(figures.members).toBe(ADMIN_OWNER_EMAILS_SHOWN + 3);
  });
});

describe('listOrganizationMembersForAdmin', () => {
  it('lists members on live accounts, the longest-standing first, and nothing of a deleted organisation', async () => {
    const { orgId, ownerId } = await seedOrg();
    const early = await seedUser();
    await addMember(orgId, early.id, 'viewer', '2020-01-01T00:00:00Z');
    const gone = await seedUser();
    await addMember(orgId, gone.id, 'admin');
    await t.pg.query(`update users set deleted_at = now() where id = $1`, [gone.id]);

    const members = await listOrganizationMembersForAdmin(t.db, orgId, 50);
    expect(members.map((member) => [member.userId, member.role])).toEqual([
      [early.id, 'viewer'],
      [ownerId, 'owner'],
    ]);
    expect(Object.keys(members[0]!).sort()).toEqual(
      ['displayName', 'email', 'joinedAt', 'role', 'userId'].sort(),
    );

    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [orgId]);
    expect(await listOrganizationMembersForAdmin(t.db, orgId, 50)).toEqual([]);
  });
});

describe('listUsersForAdmin', () => {
  it('lists live accounts newest first, with their last sign-in method and live organisations', async () => {
    const marker = randomUUID().slice(0, 8);
    const at = (micro: number) => `2032-01-01T00:00:00.5678${micro}Z`;
    const oldest = await seedUser({ email: `u1-${marker}@example.com`, createdAt: at(11) });
    const middle = await seedUser({ email: `u2-${marker}@example.com`, createdAt: at(12) });
    const newest = await seedUser({ email: `u3-${marker}@example.com`, createdAt: at(13) });
    await seedUser({ email: `u4-${marker}@example.com`, createdAt: at(14), deleted: true });

    await seedSession(middle.id, 'password', '2032-02-01T00:00:00Z');
    await seedSession(middle.id, 'passkey', '2032-03-01T00:00:00Z');
    await seedSession(newest.id, null, '2032-03-01T00:00:00Z');
    await seedOrg({ owner: middle });
    const gone = await seedOrg({ owner: middle, deleted: true });
    expect(gone.ownerId).toBe(middle.id);

    const { items, pages } = await everyPage((cursor) =>
      listUsersForAdmin(t.db, { query: marker, cursor, limit: 2 }),
    );

    expect(pages).toBe(2);
    expect(items.map((user) => user.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(items[1]).toEqual({
      id: middle.id,
      email: middle.email,
      displayName: null,
      emailVerified: true,
      createdAt: new Date('2032-01-01T00:00:00.567Z'),
      lastLoginAt: null,
      // The most recent session's.
      lastSignInMethod: 'passkey',
      // The deleted organisation is not counted.
      organizationCount: 1,
    });
    // A session from before migration 0022 says nothing, and neither does none.
    expect(items[0]!.lastSignInMethod).toBeNull();
    expect(items[2]!.lastSignInMethod).toBeNull();
    expect(items[2]!.organizationCount).toBe(0);
  });

  it('matches an address in any case, as typed — a wildcard is a character, not a pattern', async () => {
    const marker = randomUUID().slice(0, 8);
    const plain = await seedUser({ email: `ada_${marker}@example.com` });
    const lookalike = await seedUser({ email: `adax${marker}@example.com` });

    const found = await listUsersForAdmin(t.db, { query: `ADA_${marker}`, limit: 50 });
    expect(found.items.map((user) => user.id)).toEqual([plain.id]);
    expect(found.items.map((user) => user.id)).not.toContain(lookalike.id);

    const everything = await listUsersForAdmin(t.db, { query: '%', limit: 50 });
    expect(everything.items).toEqual([]);
    expect(containsPattern('a%b_c\\d')).toBe('%a\\%b\\_c\\\\d%');
  });
});

describe('findUserForAdmin and listUserOrganizationsForAdmin', () => {
  it('finds a live account and its live organisations, and nothing for a deleted one', async () => {
    const person = await seedUser();
    const first = await seedOrg();
    await addMember(first.orgId, person.id, 'developer', '2021-01-01T00:00:00Z');
    const own = await seedOrg({ owner: person });
    const gone = await seedOrg({ deleted: true });
    await addMember(gone.orgId, person.id, 'admin');

    expect(await findUserForAdmin(t.db, person.id)).toMatchObject({
      id: person.id,
      organizationCount: 2,
    });
    const memberships = await listUserOrganizationsForAdmin(t.db, person.id, 50);
    expect(memberships.map((org) => [org.id, org.role])).toEqual([
      [first.orgId, 'developer'],
      [own.orgId, 'owner'],
    ]);
    expect(Object.keys(memberships[0]!).sort()).toEqual(
      ['id', 'joinedAt', 'name', 'role', 'slug'].sort(),
    );

    await t.pg.query(`update users set deleted_at = now() where id = $1`, [person.id]);
    expect(await findUserForAdmin(t.db, person.id)).toBeNull();
    expect(await listUserOrganizationsForAdmin(t.db, person.id, 50)).toEqual([]);
    expect(await findUserForAdmin(t.db, randomUUID())).toBeNull();
  });
});
