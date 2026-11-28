import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  EnvelopeService,
  generateKeyBytes,
  InMemoryKeyProvider,
  parseRootKeyMaterial,
  toBase64Url,
} from '@xecret/core/crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  findOrganizationBySlugWithEntitlements,
  freeOrganizationAllowance,
  provisionOrganization,
} from './organizations';
import { QuotaExceededError } from './shared';
import { entitlementsFromRow } from './subscriptions';

/**
 * The free allowance, against real rows: of the Free organisations an account
 * created and is still a member of, the two oldest work and any later one waits
 * for a paid plan; and an account may hold one that waits at a time.
 *
 * Read the way the request path reads it, through
 * `findOrganizationBySlugWithEntitlements` and `entitlementsFromRow`, so what is
 * pinned here is what `resolveOrg` closes the control plane on.
 */

let t: TestDatabase;
let envelope: EnvelopeService;

beforeAll(async () => {
  t = await createTestDatabase();
  const rootKeys = JSON.stringify({ '1': toBase64Url(generateKeyBytes()) });
  envelope = new EnvelopeService(new InMemoryKeyProvider(parseRootKeyMaterial(rootKeys, 1)));
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

interface Account {
  id: string;
  email: string;
  displayName: string | null;
}

async function seedAccount(): Promise<Account> {
  const id = randomUUID();
  const email = `allowance-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_${id.slice(0, 8)}`, email],
  );
  return { id, email, displayName: null };
}

/** Creates an organisation the way the product does, and answers its slug. */
async function create(account: Account): Promise<{ slug: string; id: string; awaiting: boolean }> {
  const slug = `allow-${randomUUID().slice(0, 8)}`;
  const made = await provisionOrganization(t.db, { user: account, envelope, slug, name: slug });
  return { slug, id: made.organization.id, awaiting: made.awaitingPaidPlan };
}

/** Whether `slug` is waiting for a paid plan, as `resolveOrg` would read it. */
async function awaiting(slug: string): Promise<boolean> {
  const found = await findOrganizationBySlugWithEntitlements(t.db, slug);
  if (found === null) throw new Error(`no organisation ${slug}`);
  const entitlements = entitlementsFromRow(found.entitlements);
  expect(entitlements.controlPlaneActive).toBe(!entitlements.awaitingPaidPlan);
  return entitlements.awaitingPaidPlan;
}

/** A plan as a grant writes it: paid plans carry an interval, Free carries none. */
async function setPlan(orgId: string, plan: 'free' | 'pro' | 'team'): Promise<void> {
  await t.pg.query(
    `update org_subscriptions set plan = $2, billing_interval = $3 where org_id = $1`,
    [orgId, plan, plan === 'free' ? null : 'monthly'],
  );
}

async function join(orgId: string, account: Account): Promise<void> {
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role, status) values ($1, $2, $3, 'developer', 'active')`,
    [randomUUID(), orgId, account.id],
  );
}

describe('the free allowance', () => {
  it('keeps the two oldest Free organisations open and holds the third', async () => {
    const account = await seedAccount();
    const first = await create(account);
    const second = await create(account);
    const third = await create(account);

    expect([first.awaiting, second.awaiting, third.awaiting]).toEqual([false, false, true]);
    expect(await awaiting(first.slug)).toBe(false);
    expect(await awaiting(second.slug)).toBe(false);
    expect(await awaiting(third.slug)).toBe(true);
    expect(await freeOrganizationAllowance(t.db, account.id)).toEqual({ free: 3, awaiting: 1 });
  });

  it('opens a waiting organisation the moment it is bought a plan', async () => {
    const account = await seedAccount();
    await create(account);
    await create(account);
    const third = await create(account);

    await setPlan(third.id, 'pro');
    expect(await awaiting(third.slug)).toBe(false);
  });

  it('opens the next one when an older Free organisation is deleted', async () => {
    const account = await seedAccount();
    const first = await create(account);
    await create(account);
    const third = await create(account);

    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [first.id]);
    expect(await awaiting(third.slug)).toBe(false);
  });

  it('holds a paid organisation that returns to Free while two older Free ones exist', async () => {
    const account = await seedAccount();
    await create(account);
    await create(account);
    // Bought a plan while it was the one waiting, then let it lapse to Free.
    const third = await create(account);
    await setPlan(third.id, 'team');
    expect(await awaiting(third.slug)).toBe(false);

    await setPlan(third.id, 'free');
    expect(await awaiting(third.slug)).toBe(true);
  });

  it('counts a complimentary grant as paid', async () => {
    const account = await seedAccount();
    const granted = await create(account);
    // A grant is a plan on the row, as `npm run plan:set` and the admin
    // screen write it, with no subscription behind it.
    await setPlan(granted.id, 'team');
    const second = await create(account);
    const third = await create(account);

    expect(await awaiting(second.slug)).toBe(false);
    expect(await awaiting(third.slug)).toBe(false);
    expect(await freeOrganizationAllowance(t.db, account.id)).toEqual({ free: 2, awaiting: 0 });
  });

  it('never counts somebody else’s Free organisation the account joined', async () => {
    const account = await seedAccount();
    const stranger = await seedAccount();
    for (let index = 0; index < 2; index += 1) {
      const theirs = await create(stranger);
      await join(theirs.id, account);
    }
    const mine = await create(account);
    const alsoMine = await create(account);

    expect(await awaiting(mine.slug)).toBe(false);
    expect(await awaiting(alsoMine.slug)).toBe(false);
    expect(await freeOrganizationAllowance(t.db, account.id)).toEqual({ free: 2, awaiting: 0 });
  });

  it('counts against nobody an organisation its creator is no longer in', async () => {
    const account = await seedAccount();
    await create(account);
    await create(account);
    const third = await create(account);
    expect(await awaiting(third.slug)).toBe(true);

    // The creator removed from it: the organisation is no longer held, so it is
    // waiting on nobody's allowance.
    await t.pg.query(`delete from org_members where org_id = $1 and user_id = $2`, [
      third.id,
      account.id,
    ]);
    expect(await awaiting(third.slug)).toBe(false);
  });
});

describe('creating past the allowance', () => {
  it('allows one organisation waiting at a time, and refuses a second', async () => {
    const account = await seedAccount();
    await create(account);
    await create(account);
    const third = await create(account);
    expect(third.awaiting).toBe(true);

    await expect(create(account)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('allows the next one once the waiting organisation is paid for', async () => {
    const account = await seedAccount();
    await create(account);
    await create(account);
    const third = await create(account);
    await setPlan(third.id, 'pro');

    const fourth = await create(account);
    // Two older Free ones still work, so this one waits in its turn.
    expect(fourth.awaiting).toBe(true);
  });

  it('allows the next one once the waiting organisation is deleted', async () => {
    const account = await seedAccount();
    await create(account);
    await create(account);
    const third = await create(account);
    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [third.id]);

    await expect(create(account)).resolves.toMatchObject({ awaiting: true });
  });

  it('leaves paid organisations unlimited', async () => {
    const account = await seedAccount();
    for (let index = 0; index < 4; index += 1) {
      const paid = await create(account);
      expect(paid.awaiting).toBe(false);
      await setPlan(paid.id, 'pro');
    }
    expect(await freeOrganizationAllowance(t.db, account.id)).toEqual({ free: 0, awaiting: 0 });
  });
});
