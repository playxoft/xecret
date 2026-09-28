import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import * as repositories from './index';
import { findOrgByWorkosOrgId, setOrgWorkosOrgId, updateOrganization } from './organizations';
import { RepositoryError } from './shared';

/**
 * The organisation half of WS-1: the lazy `workos_org_id` link and the lookup
 * the sign-in callback resolves WorkOS organisations through — against a real
 * database, because both are about which rows a predicate admits.
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

describe('sso_required', () => {
  it('defaults to false on a new organisation', async () => {
    const orgId = await seedOrg();
    const result = await t.pg.query<{ sso_required: boolean }>(
      `select sso_required from organizations where id = $1`,
      [orgId],
    );
    expect(result.rows[0]?.sso_required).toBe(false);
  });

  it('has no setter until the sign-in callback enforces it', () => {
    // A tripwire, not a formality. The flag without its check tells an
    // administrator a bypass is closed while it is open, so a setter must ship
    // in the same change as the enforcement (WS-2). If this fails, that change
    // is here — make sure the enforcement is too, then update this test.
    // The match is deliberately broad: it may fail loudly on an innocent name,
    // and that is the trade — it can never pass silently on a guilty one.
    expect(Object.keys(repositories).filter((name) => /sso/i.test(name))).toEqual([]);
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

    const orgId = await seedOrg();
    await updateOrganization(t.db, orgId, { name: 'Renamed', ssoRequired: true } as never);

    const result = await t.pg.query<{ name: string; sso_required: boolean }>(
      `select name, sso_required from organizations where id = $1`,
      [orgId],
    );
    expect(result.rows[0]).toEqual({ name: 'Renamed', sso_required: false });
  });
});
