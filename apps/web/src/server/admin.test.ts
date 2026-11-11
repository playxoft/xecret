import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import { ADMIN_ACTOR_LABEL, adminAudit, asciiAddress, isAdmin, requireAdmin } from './admin';
import type { ServiceContext } from './context';
import { ApiError } from './errors';
import { createLogger } from './logging';
import type { LogEntry } from './logging';

/**
 * The gate in front of the admin page (`server/admin.ts`): an admin is a live
 * account with a row in `platform_admins`, signed in with a browser session on
 * a verified address — and nobody else, whatever credential they hold. Against
 * a real database, because the row is the whole of the rule.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `staff-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_01${id.replaceAll('-', '').slice(0, 20)}`, email],
  );
  return { id, email };
}

/** A user with a `platform_admins` row — what `npm run admin` or another admin writes. */
async function seedAdmin(): Promise<{ id: string; email: string }> {
  const user = await seedUser();
  await t.pg.query(`insert into platform_admins (user_id) values ($1)`, [user.id]);
  return user;
}

function session(user: { id: string; email: string }, emailVerified = true): Principal {
  return {
    kind: 'user',
    sessionId: randomUUID(),
    user: { id: user.id, email: user.email, emailVerified, displayName: 'Staff', avatarUrl: null },
    vaultUnlockedAt: new Date(),
    lastSeenAt: new Date(),
    vaultAutoLockMinutes: null,
    signIn: { method: 'password', ssoWorkosOrgId: null },
  };
}

const cliTokenOf = (user: { id: string }): Principal => ({
  kind: 'cliToken',
  tokenId: randomUUID(),
  tokenName: 'laptop',
  userId: user.id,
  orgId: randomUUID(),
  signIn: { method: 'password', ssoWorkosOrgId: null },
});

const serviceToken = (): Principal => ({
  kind: 'serviceToken',
  tokenId: randomUUID(),
  tokenName: 'ci',
  orgId: randomUUID(),
  projectId: randomUUID(),
  environmentId: randomUUID(),
  accessLevel: 'read',
});

function services(): { services: ServiceContext; lines: LogEntry[] } {
  const lines: LogEntry[] = [];
  const log = createLogger({
    sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
    minimum: 'debug',
  }).logger;
  return { services: { db: t.db, log } as unknown as ServiceContext, lines };
}

describe('asciiAddress', () => {
  it('folds an address to lower case, and trims it', () => {
    expect(asciiAddress('  Kelly@Example.COM ')).toBe('kelly@example.com');
    expect(asciiAddress('ops+billing@example.com')).toBe('ops+billing@example.com');
  });

  it('refuses a look-alike letter rather than folding it into somebody else’s address', () => {
    // U+212A KELVIN SIGN lower-cases to "k" in Unicode: folded, "Kelly@" would
    // be "kelly@" — another person's mailbox.
    expect(asciiAddress('Kelly@example.com')).toBeNull();
    expect('Kelly@example.com'.toLowerCase()).toBe('kelly@example.com');
    expect(asciiAddress('josé@example.com')).toBeNull();
  });

  it('refuses whitespace inside an address, and an empty one', () => {
    expect(asciiAddress('kelly @example.com')).toBeNull();
    expect(asciiAddress('kelly@exa\tmple.com')).toBeNull();
    expect(asciiAddress('')).toBeNull();
    expect(asciiAddress('   ')).toBeNull();
  });
});

describe('isAdmin', () => {
  it('admits a verified session whose account has a row', async () => {
    const admin = await seedAdmin();
    expect(await isAdmin({ db: t.db }, session(admin))).toBe(true);
  });

  it('refuses the same account’s session when its address is not verified', async () => {
    const admin = await seedAdmin();
    expect(await isAdmin({ db: t.db }, session(admin, false))).toBe(false);
  });

  it('refuses an account with no row — whatever its address', async () => {
    const user = await seedUser();
    expect(await isAdmin({ db: t.db }, session(user))).toBe(false);
  });

  it('refuses an account that was deleted, even though its row is still there', async () => {
    const admin = await seedAdmin();
    await t.pg.query(`update users set deleted_at = now() where id = $1`, [admin.id]);
    expect(await isAdmin({ db: t.db }, session(admin))).toBe(false);
  });

  it('refuses every token — the admin’s own CLI token included', async () => {
    const admin = await seedAdmin();
    expect(await isAdmin({ db: t.db }, cliTokenOf(admin))).toBe(false);
    expect(await isAdmin({ db: t.db }, serviceToken())).toBe(false);
  });

  it('stops admitting an account from the moment its row is removed', async () => {
    const admin = await seedAdmin();
    expect(await isAdmin({ db: t.db }, session(admin))).toBe(true);
    await t.pg.query(`delete from platform_admins where user_id = $1`, [admin.id]);
    expect(await isAdmin({ db: t.db }, session(admin))).toBe(false);
  });
});

describe('requireAdmin', () => {
  it('hands an admin back as the session it is', async () => {
    const admin = session(await seedAdmin());
    expect(await requireAdmin(services().services, admin)).toBe(admin);
  });

  it('answers anybody else a 404, and logs the refusal without saying who knocked', async () => {
    const { services: context, lines } = services();
    const admin = await seedAdmin();
    const stranger = await seedUser();
    for (const principal of [
      session(stranger),
      session(admin, false),
      cliTokenOf(admin),
      serviceToken(),
    ]) {
      const thrown = await requireAdmin(context, principal).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).status).toBe(404);
      expect((thrown as ApiError).code).toBe('not_found');
    }
    const warnings = lines.filter((line) => line.level === 'warn');
    expect(warnings).toHaveLength(4);
    expect(JSON.stringify(warnings)).not.toContain(stranger.email);
  });
});

describe('adminAudit', () => {
  it('attributes the change to xecret support, as the system — never the admin’s IP or browser', () => {
    const orgId = randomUUID();
    const meta = { ipAddress: '203.0.113.9', userAgent: 'vitest', requestId: 'req_admin_1' };
    const record = adminAudit({ meta } as unknown as ServiceContext, orgId).success(
      'plan.changed',
      null,
      { operator: ADMIN_ACTOR_LABEL, plan: 'team' },
    );
    expect(record).toMatchObject({
      orgId,
      actorType: 'system',
      actorId: null,
      actorLabel: ADMIN_ACTOR_LABEL,
      // Every owner of the organisation reads this row; the request's address
      // and agent are the staff member's, and stay on the server's log line.
      ipAddress: null,
      userAgent: null,
      requestId: 'req_admin_1',
      outcome: 'success',
      metadata: { operator: ADMIN_ACTOR_LABEL, plan: 'team' },
    });
    expect(ADMIN_ACTOR_LABEL).toBe('xecret support');
  });
});
