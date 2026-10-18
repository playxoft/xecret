import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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

beforeAll(async () => {
  t = await createTestDatabase();
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

async function seedOrg(over: { workosOrgId?: string; deleted?: boolean } = {}) {
  const id = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, workos_org_id, deleted_at)
     values ($1, 'Acme', $2, $3, $4, $5)`,
    [
      id,
      `acme-${id.slice(0, 8)}`,
      founderId,
      over.workosOrgId ?? null,
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

    expect((await findOrgByWorkosOrgId(t.db, id))?.id).toBe(orgId);
  });

  it('resolves nothing for an unknown id', async () => {
    expect(await findOrgByWorkosOrgId(t.db, workosOrg())).toBeNull();
  });

  it('does not resolve a soft-deleted organisation', async () => {
    // An SSO login must not JIT a member into an organisation that has ended.
    const id = workosOrg();
    await seedOrg({ workosOrgId: id, deleted: true });

    expect(await findOrgByWorkosOrgId(t.db, id)).toBeNull();
  });
});

describe('setOrgWorkosOrgId', () => {
  it('links an organisation that has no WorkOS Organization yet', async () => {
    const orgId = await seedOrg();
    const id = workosOrg();

    const organization = await setOrgWorkosOrgId(t.db, orgId, id);

    expect(organization.workosOrgId).toBe(id);
    expect(await linkOf(orgId)).toBe(id);
    expect((await findOrgByWorkosOrgId(t.db, id))?.id).toBe(orgId);
  });

  it('is idempotent for the id it already holds', async () => {
    const id = workosOrg();
    const orgId = await seedOrg({ workosOrgId: id });

    expect((await setOrgWorkosOrgId(t.db, orgId, id)).workosOrgId).toBe(id);
  });

  it('refuses to re-point an organisation at a different WorkOS Organization', async () => {
    // Re-pointing the link re-points the organisation's SSO at another
    // identity provider; the second of two concurrent "enable SSO" requests
    // must clean up its orphan at WorkOS, not win.
    const id = workosOrg();
    const orgId = await seedOrg({ workosOrgId: id });

    await expect(setOrgWorkosOrgId(t.db, orgId, workosOrg())).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await linkOf(orgId)).toBe(id);
  });

  it('refuses a WorkOS Organization already linked to another organisation', async () => {
    const id = workosOrg();
    await seedOrg({ workosOrgId: id });
    const orgId = await seedOrg();

    const error: unknown = await setOrgWorkosOrgId(t.db, orgId, id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RepositoryError);
    expect((error as RepositoryError).code).toBe('conflict');
    // The constraint violation, mapped — not the "already linked" re-read.
    expect((error as RepositoryError).message).toMatch(/another organisation/);
    expect(await linkOf(orgId)).toBeNull();
  });

  it('refuses a soft-deleted or unknown organisation with notFound', async () => {
    const deleted = await seedOrg({ deleted: true });

    await expect(setOrgWorkosOrgId(t.db, deleted, workosOrg())).rejects.toMatchObject({
      code: 'notFound',
    });
    await expect(setOrgWorkosOrgId(t.db, randomUUID(), workosOrg())).rejects.toMatchObject({
      code: 'notFound',
    });
    expect(await linkOf(deleted)).toBeNull();
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
    expect(Object.keys(repositories).filter((name) => /sso/i.test(name))).toEqual([
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
});
