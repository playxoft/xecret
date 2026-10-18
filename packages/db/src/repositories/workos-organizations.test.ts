import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashToken } from '@xecret/core/auth';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import * as repositories from './index';
import { joinOrganizationJustInTime } from './invitations';
import {
  findOrgByWorkosOrgId,
  setOrgWorkosOrgId,
  updateOrganization,
  updateOrgSsoSettings,
} from './organizations';
import { RepositoryError } from './shared';

/**
 * The organisation half of WS-1 and WS-5: the lazy `workos_org_id` link, the
 * lookup the sign-in callback resolves WorkOS organisations through, the two
 * SSO policy flags and their one setter, and the just-in-time join that reads
 * the opt-in — against a real database, because all of it is about which rows a
 * predicate admits and what a lock serialises.
 */

let t: TestDatabase;
let founderId: string;
/** What migration 0023 recorded in `workos_home`, before this file points it at the test environment. */
let seededHome: string | null;

beforeAll(async () => {
  t = await createTestDatabase();
  seededHome = await repositories.findWorkosHome(t.db);
  // This database belongs to the test deployment's WorkOS environment, as an
  // operator records it (docs/self-hosting.md).
  await t.pg.query(`update workos_home set client_id = $1`, [CLIENT_ID]);
  founderId = randomUUID();
  await t.pg.query(`insert into users (id, firebase_uid, email) values ($1, $2, $3)`, [
    founderId,
    `fb-${founderId}`,
    `founder-${founderId.slice(0, 8)}@example.com`,
  ]);
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

/** This deployment's WorkOS environment, as the settings route passes it. */
const CLIENT_ID = 'client_01TESTCLIENT';

async function seedOrg(over: { workosOrgId?: string; deleted?: boolean } = {}) {
  const id = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, workos_org_id, workos_client_id, deleted_at)
     values ($1, 'Acme', $2, $3, $4, $5, $6)`,
    [
      id,
      `acme-${id.slice(0, 8)}`,
      founderId,
      over.workosOrgId ?? null,
      over.workosOrgId === undefined ? null : CLIENT_ID,
      over.deleted ? new Date() : null,
    ],
  );
  return id;
}

async function linkOf(orgId: string): Promise<string | null | undefined> {
  const result = await t.pg.query<{ workos_org_id: string | null }>(
    `select workos_org_id from organizations where id = $1`,
    [orgId],
  );
  return result.rows[0]?.workos_org_id;
}

const workosOrg = () => `org_01T${randomUUID().replaceAll('-', '').slice(0, 20)}`;

describe('findOrgByWorkosOrgId', () => {
  it('resolves the organisation a WorkOS Organization is linked to', async () => {
    const id = workosOrg();
    const orgId = await seedOrg({ workosOrgId: id });

    expect((await findOrgByWorkosOrgId(t.db, id, CLIENT_ID))?.id).toBe(orgId);
  });

  it('resolves nothing for an unknown id', async () => {
    expect(await findOrgByWorkosOrgId(t.db, workosOrg(), CLIENT_ID)).toBeNull();
  });

  it('does not resolve a soft-deleted organisation', async () => {
    // An SSO login must not JIT a member into an organisation that has ended.
    const id = workosOrg();
    await seedOrg({ workosOrgId: id, deleted: true });

    expect(await findOrgByWorkosOrgId(t.db, id, CLIENT_ID)).toBeNull();
  });

  it('does not resolve a link made in another WorkOS environment (review round 2)', async () => {
    // The sign-in path asks with its own client id: a Staging link over the
    // production database must not let a Staging identity provider JIT anybody
    // into a production organisation, or be named on the confirmation.
    const id = workosOrg();
    await seedOrg({ workosOrgId: id });

    expect(await findOrgByWorkosOrgId(t.db, id, 'client_01ANOTHERENVIRONMENT')).toBeNull();
  });
});

describe('workos_home (migration 0023)', () => {
  it('is seeded with the production WorkOS environment, the one this deployment’s links belong to', () => {
    expect(seededHome).toBe('client_01M36CECX3Z66Q2FYY2FN8WG73');
  });

  it('holds one row at most, and only a client id', async () => {
    await expect(
      t.pg.query(`insert into workos_home (id, client_id) values (true, 'client_01SECOND')`),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      t.pg.query(`insert into workos_home (id, client_id) values (false, 'client_01SECOND')`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.pg.query(`update workos_home set client_id = 'not a client id'`),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('setOrgWorkosOrgId', () => {
  async function clientOf(orgId: string): Promise<string | null | undefined> {
    const result = await t.pg.query<{ workos_client_id: string | null }>(
      `select workos_client_id from organizations where id = $1`,
      [orgId],
    );
    return result.rows[0]?.workos_client_id;
  }

  it('links an organisation that has no WorkOS Organization yet, with the environment it was made in', async () => {
    const orgId = await seedOrg();
    const id = workosOrg();

    const linked = await setOrgWorkosOrgId(t.db, orgId, id, CLIENT_ID);

    expect(linked.changed).toBe(true);
    expect(linked.organization.workosOrgId).toBe(id);
    expect(linked.organization.workosClientId).toBe(CLIENT_ID);
    expect(await linkOf(orgId)).toBe(id);
    expect(await clientOf(orgId)).toBe(CLIENT_ID);
    expect((await findOrgByWorkosOrgId(t.db, id, CLIENT_ID))?.id).toBe(orgId);
  });

  it('writes no link from an environment this database does not belong to, or with none recorded (review round 2)', async () => {
    // Local development runs against WorkOS Staging over the production
    // database; round 1 only refused to *act* on such a link. Now it cannot be
    // written, whatever the caller checked first.
    const orgId = await seedOrg();

    await expect(
      setOrgWorkosOrgId(t.db, orgId, workosOrg(), 'client_01ANOTHERENVIRONMENT'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await linkOf(orgId)).toBeNull();

    await t.pg.query(`delete from workos_home`);
    try {
      await expect(setOrgWorkosOrgId(t.db, orgId, workosOrg(), CLIENT_ID)).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect(await linkOf(orgId)).toBeNull();
    } finally {
      await t.pg.query(`insert into workos_home (id, client_id) values (true, $1)`, [CLIENT_ID]);
    }
  });

  it('is idempotent for the id it already holds, and says it changed nothing', async () => {
    // Review C5: two enables racing used to get the row back alike, and both
    // answered 201 and both filed `org.sso.enabled`. Only the write that
    // linked it may say so.
    const id = workosOrg();
    const orgId = await seedOrg({ workosOrgId: id });

    const again = await setOrgWorkosOrgId(t.db, orgId, id, CLIENT_ID);

    expect(again.changed).toBe(false);
    expect(again.organization.workosOrgId).toBe(id);
  });

  it('tells two concurrent links of the same id apart: exactly one of them changed the row', async () => {
    const orgId = await seedOrg();
    const id = workosOrg();

    const results = await Promise.all([
      setOrgWorkosOrgId(t.db, orgId, id, CLIENT_ID),
      setOrgWorkosOrgId(t.db, orgId, id, CLIENT_ID),
    ]);

    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
  });

  it('refuses the same id from a different WorkOS environment rather than adopting it', async () => {
    // Review S9: local development runs against WorkOS Staging over the
    // production database. A link is answered as "already on" only for the
    // environment that made it.
    const id = workosOrg();
    const orgId = await seedOrg({ workosOrgId: id });

    await expect(
      setOrgWorkosOrgId(t.db, orgId, id, 'client_01ANOTHERENVIRONMENT'),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await clientOf(orgId)).toBe(CLIENT_ID);
  });

  it('refuses to re-point an organisation at a different WorkOS Organization', async () => {
    // Re-pointing the link re-points the organisation's SSO at another
    // identity provider; the second of two concurrent "enable SSO" requests
    // must clean up its orphan at WorkOS, not win.
    const id = workosOrg();
    const orgId = await seedOrg({ workosOrgId: id });

    await expect(setOrgWorkosOrgId(t.db, orgId, workosOrg(), CLIENT_ID)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await linkOf(orgId)).toBe(id);
  });

  it('refuses a WorkOS Organization already linked to another organisation', async () => {
    const id = workosOrg();
    await seedOrg({ workosOrgId: id });
    const orgId = await seedOrg();

    const error: unknown = await setOrgWorkosOrgId(t.db, orgId, id, CLIENT_ID).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RepositoryError);
    expect((error as RepositoryError).code).toBe('conflict');
    // The constraint violation, mapped — not the "already linked" re-read.
    expect((error as RepositoryError).message).toMatch(/another organisation/);
    expect(await linkOf(orgId)).toBeNull();
  });

  it('refuses a soft-deleted or unknown organisation with notFound', async () => {
    const deleted = await seedOrg({ deleted: true });

    await expect(setOrgWorkosOrgId(t.db, deleted, workosOrg(), CLIENT_ID)).rejects.toMatchObject({
      code: 'notFound',
    });
    await expect(
      setOrgWorkosOrgId(t.db, randomUUID(), workosOrg(), CLIENT_ID),
    ).rejects.toMatchObject({ code: 'notFound' });
    expect(await linkOf(deleted)).toBeNull();
  });

  it('never stores a link without its environment, for any writer (migration 0022)', async () => {
    const orgId = await seedOrg();

    await expect(
      t.pg.query(`update organizations set workos_org_id = $2 where id = $1`, [orgId, workosOrg()]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('holds that rule as a VALID constraint since migration 0023', async () => {
    const result = await t.pg.query<{ convalidated: boolean }>(
      `select convalidated from pg_constraint where conname = 'organizations_workos_link_client_check'`,
    );
    expect(result.rows).toEqual([{ convalidated: true }]);
  });
});

describe('sso_required and jit_join_enabled', () => {
  async function flagsOf(orgId: string) {
    const result = await t.pg.query<{ sso_required: boolean; jit_join_enabled: boolean }>(
      `select sso_required, jit_join_enabled from organizations where id = $1`,
      [orgId],
    );
    return result.rows[0];
  }

  it('both default to false on a new organisation', async () => {
    const orgId = await seedOrg();
    expect(await flagsOf(orgId)).toEqual({ sso_required: false, jit_join_enabled: false });
  });

  it('have exactly one setter, the one the SSO settings route guards', () => {
    // The tripwire #100 left, now that WS-5 is here. The flag's setter shipped
    // with the guards its absence was waiting for: owner/admin and a browser
    // session, the SAML add-on and an active connection before it can be
    // switched on (`app/api/orgs/[orgSlug]/sso/route.ts`), and a standing
    // owner exemption in the callback (`server/sign-in.ts`, step 5) so a
    // misconfigured identity provider cannot lock an organisation out. A
    // *second* setter would be a way round those guards: if this fails, put
    // them in front of it too, then update the list.
    // The match is deliberately broad: it may fail loudly on an innocent name,
    // and that is the trade — it can never pass silently on a guilty one.
    // `countNonSsoAccess` is the one innocent name so far: a read (review
    // round 1, S3) that writes nothing at all.
    expect(Object.keys(repositories).filter((name) => /sso/i.test(name))).toEqual([
      'countNonSsoAccess',
      'updateOrgSsoSettings',
    ]);
  });

  it('switches either flag on for a linked organisation, and reports what it replaced', async () => {
    const orgId = await seedOrg({ workosOrgId: workosOrg() });

    const first = await updateOrgSsoSettings(t.db, orgId, { jitJoinEnabled: true });
    expect(first.previous).toEqual({ ssoRequired: false, jitJoinEnabled: false });
    expect(first.organization.jitJoinEnabled).toBe(true);
    expect(first.organization.ssoRequired).toBe(false);

    const second = await updateOrgSsoSettings(t.db, orgId, { ssoRequired: true });
    expect(second.previous).toEqual({ ssoRequired: false, jitJoinEnabled: true });
    expect(await flagsOf(orgId)).toEqual({ sso_required: true, jit_join_enabled: true });
  });

  it('refuses to switch either flag on for an organisation that never enabled SSO', async () => {
    // Both flags are about the organisation's connection; with no WorkOS link
    // there is none, and `sso_required` would refuse every member's every
    // sign-in with nothing able to satisfy it.
    const orgId = await seedOrg();

    for (const patch of [{ ssoRequired: true }, { jitJoinEnabled: true }]) {
      await expect(updateOrgSsoSettings(t.db, orgId, patch)).rejects.toMatchObject({
        code: 'conflict',
      });
    }
    expect(await flagsOf(orgId)).toEqual({ sso_required: false, jit_join_enabled: false });
  });

  it('always lets a flag be switched off', async () => {
    const orgId = await seedOrg({ workosOrgId: workosOrg() });
    await updateOrgSsoSettings(t.db, orgId, { ssoRequired: true, jitJoinEnabled: true });

    const off = await updateOrgSsoSettings(t.db, orgId, { ssoRequired: false });

    expect(off.previous.ssoRequired).toBe(true);
    expect(await flagsOf(orgId)).toEqual({ sso_required: false, jit_join_enabled: true });
  });

  it('answers notFound for a soft-deleted or unknown organisation', async () => {
    const deleted = await seedOrg({ workosOrgId: workosOrg(), deleted: true });

    await expect(updateOrgSsoSettings(t.db, deleted, { ssoRequired: false })).rejects.toMatchObject(
      { code: 'notFound' },
    );
    await expect(
      updateOrgSsoSettings(t.db, randomUUID(), { ssoRequired: false }),
    ).rejects.toMatchObject({ code: 'notFound' });
  });

  it('are held to the WorkOS link by the database too, for any writer that is not the setter', async () => {
    // `organizations_sso_flags_need_link_check`, migration 0021: what holds for
    // a psql session or the next caller that forgot.
    const orgId = await seedOrg();

    for (const column of ['sso_required', 'jit_join_enabled']) {
      await expect(
        t.pg.query(`update organizations set ${column} = true where id = $1`, [orgId]),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      t.pg.query(
        `insert into organizations (id, name, slug, created_by, sso_required)
         values ($1, 'Acme', $2, $3, true)`,
        [randomUUID(), `acme-${randomUUID().slice(0, 8)}`, founderId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('cannot be set through the organisation patch either', async () => {
    // The other way a setter could arrive: as a field on the patch
    // `updateOrganization` already accepts. Checked at the type level — `tsc`
    // covers this file, and `NoSsoField` stops compiling the moment the patch
    // grows a key containing "sso" in any case — and at runtime, where an
    // `ssoRequired` smuggled past the type must not reach the column.
    type PatchKey = Extract<keyof Parameters<typeof updateOrganization>[2], string>;
    type SsoKey = Extract<Lowercase<PatchKey>, `${string}sso${string}`>;
    const NoSsoField: [SsoKey] extends [never] ? true : false = true;
    expect(NoSsoField).toBe(true);

    const orgId = await seedOrg({ workosOrgId: workosOrg() });
    await updateOrganization(t.db, orgId, {
      name: 'Renamed',
      ssoRequired: true,
      jitJoinEnabled: true,
    } as never);

    const result = await t.pg.query<{
      name: string;
      sso_required: boolean;
      jit_join_enabled: boolean;
    }>(`select name, sso_required, jit_join_enabled from organizations where id = $1`, [orgId]);
    expect(result.rows[0]).toEqual({
      name: 'Renamed',
      sso_required: false,
      jit_join_enabled: false,
    });
  });
});

describe('joinOrganizationJustInTime', () => {
  /** An organisation linked to WorkOS, its founder an owner holding one seat. */
  async function ssoOrg(over: { jit?: boolean; seatLimit?: number } = {}) {
    const orgId = await seedOrg({ workosOrgId: workosOrg() });
    await t.pg.query(
      `update organizations set jit_join_enabled = $2, seat_limit = $3 where id = $1`,
      [orgId, over.jit ?? true, over.seatLimit ?? 5],
    );
    await t.pg.query(
      `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), orgId, founderId],
    );
    return orgId;
  }

  async function newcomer() {
    const id = randomUUID();
    await t.pg.query(`insert into users (id, firebase_uid, email) values ($1, $2, $3)`, [
      id,
      `fb-${id}`,
      `new-${id.slice(0, 8)}@example.com`,
    ]);
    return id;
  }

  async function membershipOf(orgId: string, userId: string) {
    const result = await t.pg.query<{ role: string; status: string; invited_by: string | null }>(
      `select role, status, invited_by from org_members where org_id = $1 and user_id = $2`,
      [orgId, userId],
    );
    return result.rows;
  }

  it('admits nobody to an organisation that has not opted in, writing nothing', async () => {
    // PR #114's constraint: linking an organisation to WorkOS must not, by
    // itself, start admitting everybody its identity provider signs in.
    const orgId = await ssoOrg({ jit: false });
    const userId = await newcomer();

    const joined = await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' });

    expect(joined).toEqual({ outcome: 'not-enabled' });
    expect(await membershipOf(orgId, userId)).toEqual([]);
  });

  it('joins a newcomer at the role asked for — viewer — once the organisation opted in', async () => {
    const orgId = await ssoOrg();
    const userId = await newcomer();

    const joined = await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' });

    expect(joined.outcome).toBe('joined');
    expect(await membershipOf(orgId, userId)).toEqual([
      { role: 'viewer', status: 'active', invited_by: null },
    ]);
  });

  it('refuses for want of a seat, counting open invitations as taken', async () => {
    const orgId = await ssoOrg({ seatLimit: 2 });
    await t.pg.query(
      `insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, 'invited@example.com', 'developer', $3, $4, now() + interval '1 day')`,
      [
        randomUUID(),
        orgId,
        new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
        founderId,
      ],
    );
    const userId = await newcomer();

    const joined = await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' });

    expect(joined).toEqual({ outcome: 'no-seat' });
    expect(await membershipOf(orgId, userId)).toEqual([]);
  });

  it('reads the opt-in itself, so switching it off stops the next join whatever its caller read', async () => {
    // The callback checks the flag on the row it found first, to skip the
    // transaction; this is the check that counts, under the lock.
    const orgId = await ssoOrg();
    await updateOrgSsoSettings(t.db, orgId, { jitJoinEnabled: false });
    const userId = await newcomer();

    const joined = await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' });

    expect(joined).toEqual({ outcome: 'not-enabled' });
    expect(await membershipOf(orgId, userId)).toEqual([]);
  });

  async function memberIdOf(orgId: string, userId: string): Promise<string> {
    const result = await t.pg.query<{ id: string }>(
      `select id from org_members where org_id = $1 and user_id = $2`,
      [orgId, userId],
    );
    return result.rows[0]!.id;
  }

  async function removalsOf(orgId: string, userId: string) {
    const result = await t.pg.query<{ removed_by: string | null }>(
      `select removed_by from org_member_removals where org_id = $1 and user_id = $2`,
      [orgId, userId],
    );
    return result.rows;
  }

  it('never re-admits somebody the organisation removed, however their identity provider vouches', async () => {
    // Review S4: removal deleted the membership and left nothing behind, so a
    // person removed here but still in the IdP rejoined as a viewer at their
    // next single sign-on.
    const orgId = await ssoOrg();
    const userId = await newcomer();
    expect(
      (await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' })).outcome,
    ).toBe('joined');
    await repositories.removeMember(
      t.db,
      { orgId, memberId: await memberIdOf(orgId, userId), removedBy: founderId },
      () => {},
    );
    expect(await removalsOf(orgId, userId)).toEqual([{ removed_by: founderId }]);

    const again = await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' });

    expect(again).toEqual({ outcome: 'removed' });
    expect(await membershipOf(orgId, userId)).toEqual([]);
  });

  it('clears the removal when the person is invited back and accepts, and records a fresh one if removed again', async () => {
    const orgId = await ssoOrg();
    const userId = await newcomer();
    await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' });
    await repositories.removeMember(
      t.db,
      { orgId, memberId: await memberIdOf(orgId, userId), removedBy: founderId },
      () => {},
    );
    const email = (
      await t.pg.query<{ email: string }>(`select email::text from users where id = $1`, [userId])
    ).rows[0]!.email;

    const issued = await repositories.createInvitation(t.db, {
      orgId,
      email,
      role: 'developer',
      invitedBy: founderId,
    });
    // Invited, not yet accepted: still not a way in through the identity provider.
    expect(
      (await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' })).outcome,
    ).toBe('removed');
    await repositories.acceptInvitation(t.db, {
      tokenHash: await sha256(issued.token),
      userId,
      userEmail: email,
    });

    expect(await removalsOf(orgId, userId)).toEqual([]);
    expect(await membershipOf(orgId, userId)).toEqual([
      expect.objectContaining({ role: 'developer', status: 'active' }),
    ]);

    await repositories.removeMember(
      t.db,
      { orgId, memberId: await memberIdOf(orgId, userId) },
      null,
    );
    expect(await removalsOf(orgId, userId)).toEqual([{ removed_by: null }]);
    expect(
      (await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' })).outcome,
    ).toBe('removed');
  });

  async function emailOf(userId: string): Promise<string> {
    return (
      await t.pg.query<{ email: string }>(`select email::text from users where id = $1`, [userId])
    ).rows[0]!.email;
  }

  async function openInvitationsFor(orgId: string, email: string) {
    const result = await t.pg.query<{ id: string }>(
      `select id from invitations
        where org_id = $1 and email = $2 and accepted_at is null and revoked_at is null`,
      [orgId, email],
    );
    return result.rows;
  }

  it('does not let an invitation from before a just-in-time join re-open the door after a removal (review round 2)', async () => {
    // invite (as an admin, say) → the person joins by SSO instead, as a viewer
    // → is removed → the old, never-used link is accepted. It used to succeed,
    // at the invitation's higher role, and clear the removal record.
    const orgId = await ssoOrg();
    const userId = await newcomer();
    const email = await emailOf(userId);
    const old = await repositories.createInvitation(t.db, {
      orgId,
      email,
      role: 'admin',
      invitedBy: founderId,
    });

    expect(
      (await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' })).outcome,
    ).toBe('joined');
    // Joined some other way: the invitation is moot, and withdrawn.
    expect(await openInvitationsFor(orgId, email)).toEqual([]);

    await repositories.removeMember(
      t.db,
      { orgId, memberId: await memberIdOf(orgId, userId), removedBy: founderId },
      () => {},
    );

    await expect(
      repositories.acceptInvitation(t.db, {
        tokenHash: await sha256(old.token),
        userId,
        userEmail: email,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await membershipOf(orgId, userId)).toEqual([]);
    expect(await removalsOf(orgId, userId)).toEqual([{ removed_by: founderId }]);
    expect(
      (await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' })).outcome,
    ).toBe('removed');
  });

  it('withdraws every invitation still open for a member’s address when they are removed', async () => {
    const orgId = await ssoOrg();
    const userId = await newcomer();
    const email = await emailOf(userId);
    await joinOrganizationJustInTime(t.db, { orgId, userId, role: 'viewer' });
    // A row no route can write any more (an invitation to a current member is
    // refused) — the leftover the removal must not leave open.
    await t.pg.query(
      `insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, $3, 'admin', $4, $5, now() + interval '1 day')`,
      [
        randomUUID(),
        orgId,
        email.toUpperCase(),
        new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
        founderId,
      ],
    );

    await repositories.removeMember(
      t.db,
      { orgId, memberId: await memberIdOf(orgId, userId), removedBy: founderId },
      () => {},
    );

    expect(await openInvitationsFor(orgId, email)).toEqual([]);
  });

  it('clears a removal only for an invitation sent after it, even one that slipped past every revocation', async () => {
    const orgId = await ssoOrg();
    const userId = await newcomer();
    const email = await emailOf(userId);
    const old = await repositories.createInvitation(t.db, {
      orgId,
      email,
      role: 'developer',
      invitedBy: founderId,
    });
    // A removal record newer than the invitation, with the invitation still
    // open — what an older build's removal left behind.
    await t.pg.query(
      `insert into org_member_removals (org_id, user_id, removed_by, removed_at)
       values ($1, $2, $3, now() + interval '1 second')`,
      [orgId, userId, founderId],
    );

    await repositories.acceptInvitation(t.db, {
      tokenHash: await sha256(old.token),
      userId,
      userEmail: email,
    });

    expect(await removalsOf(orgId, userId)).toEqual([{ removed_by: founderId }]);
  });
});

const sha256 = hashToken;

describe('accepting an invitation into an organisation that requires single sign-on', () => {
  async function requiringOrg(workosOrgId: string) {
    const orgId = await seedOrg({ workosOrgId });
    await t.pg.query(
      `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), orgId, founderId],
    );
    await updateOrgSsoSettings(t.db, orgId, { ssoRequired: true });
    return orgId;
  }

  async function invited(orgId: string, role: 'developer' | 'owner' = 'developer') {
    const userId = randomUUID();
    const email = `invitee-${userId.slice(0, 8)}@example.com`;
    await t.pg.query(`insert into users (id, firebase_uid, email) values ($1, $2, $3)`, [
      userId,
      `fb-${userId}`,
      email,
    ]);
    const issued = await repositories.createInvitation(t.db, {
      orgId,
      email,
      role,
      invitedBy: founderId,
    });
    return { userId, email, tokenHash: await sha256(issued.token) };
  }

  it('refuses a session that did not come through the organisation’s own SSO, joining nothing', async () => {
    // Review S3: a newcomer signed in with a password (no memberships, so
    // nothing to refuse at sign-in) could walk in through an invitation.
    const workosOrgId = workosOrg();
    const orgId = await requiringOrg(workosOrgId);

    for (const ssoWorkosOrgId of [null, undefined, workosOrg()]) {
      const who = await invited(orgId);
      await expect(
        repositories.acceptInvitation(t.db, {
          tokenHash: who.tokenHash,
          userId: who.userId,
          userEmail: who.email,
          ssoWorkosOrgId,
        }),
      ).rejects.toMatchObject({ code: 'ssoRequired' });
      const rows = await t.pg.query(`select 1 from org_members where user_id = $1`, [who.userId]);
      expect(rows.rows).toEqual([]);
    }
  });

  it('admits a session from the organisation’s own SSO', async () => {
    const workosOrgId = workosOrg();
    const orgId = await requiringOrg(workosOrgId);
    const who = await invited(orgId);

    const accepted = await repositories.acceptInvitation(t.db, {
      tokenHash: who.tokenHash,
      userId: who.userId,
      userEmail: who.email,
      ssoWorkosOrgId: workosOrgId,
    });

    expect(accepted.member.role).toBe('developer');
  });

  it('exempts an invitation to be an owner, as owners are exempt everywhere', async () => {
    const orgId = await requiringOrg(workosOrg());
    const who = await invited(orgId, 'owner');

    const accepted = await repositories.acceptInvitation(t.db, {
      tokenHash: who.tokenHash,
      userId: who.userId,
      userEmail: who.email,
      ssoWorkosOrgId: null,
    });

    expect(accepted.member.role).toBe('owner');
  });
});

describe('countNonSsoAccess', () => {
  it('counts the live sessions and CLI tokens of non-owner members that did not come through this SSO', async () => {
    const workosOrgId = workosOrg();
    const orgId = await seedOrg({ workosOrgId });
    const person = async (role: string) => {
      const id = randomUUID();
      await t.pg.query(`insert into users (id, firebase_uid, email) values ($1, $2, $3)`, [
        id,
        `fb-${id}`,
        `p-${id.slice(0, 8)}@example.com`,
      ]);
      await t.pg.query(
        `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`,
        [randomUUID(), orgId, id, role],
      );
      return id;
    };
    const session = async (userId: string, over: { sso?: string; revoked?: boolean } = {}) => {
      await repositories.createSession(t.db, {
        userId,
        token: `xst_live_${randomUUID().replaceAll('-', '')}`,
        ipAddress: null,
        userAgent: null,
        signInMethod: over.sso === undefined ? 'password' : 'sso',
        ssoWorkosOrgId: over.sso ?? null,
      });
      if (over.revoked) {
        await t.pg.query(
          `update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`,
          [userId],
        );
      }
    };

    const developer = await person('developer');
    const owner = await person('owner');
    await session(developer); // counted: a password session
    await session(developer, { sso: workosOrg() }); // counted: another organisation's SSO
    await session(developer, { sso: workosOrgId }); // not: this organisation's SSO
    await session(owner); // not: owners are exempt
    const gone = await person('viewer');
    await session(gone, { revoked: true }); // not: revoked
    await repositories.createCliToken(t.db, { orgId, userId: developer, name: 'laptop' });
    await repositories.createCliToken(t.db, {
      orgId,
      userId: developer,
      name: 'sso laptop',
      signInMethod: 'sso',
      ssoWorkosOrgId: workosOrgId,
    });
    // Approved in another organisation of theirs: a CLI token acts as its user
    // in every organisation they belong to, so it reaches this one too (review
    // round 2, L8) — and is counted.
    const elsewhere = await seedOrg();
    await repositories.createCliToken(t.db, { orgId: elsewhere, userId: developer, name: 'ci' });

    expect(await repositories.countNonSsoAccess(t.db, { orgId, workosOrgId })).toEqual({
      sessions: 2,
      cliTokens: 2,
    });
  });
});
