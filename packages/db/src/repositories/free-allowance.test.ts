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
import { writeSubscriptionState } from './billing';
import { freeOrganizationAllowance } from './free-allowance';
import { findOrganizationBySlugWithEntitlements, provisionOrganization } from './organizations';
import { applyPlanGrant, endPlanGrant } from './plan-grants';
import { QuotaExceededError } from './shared';
import { entitlementsFromRow } from './subscriptions';

/**
 * The free allowance, against real rows (migration 0037): an account's Free
 * organisations work up to two; the one past them waits for a paid plan, and
 * the state is *stored*, set and cleared only at the moments the rule is about.
 *
 *  - Created while its creator holds two open Free organisations: it waits.
 *  - Dropped back to Free while its creator holds two *other* open ones: that
 *    one waits, and no other organisation changes.
 *  - Bought a plan or given a grant: it stops waiting.
 *  - A membership change never moves it, so leaving cannot step round it.
 *
 * Read the way the request path reads it, through
 * `findOrganizationBySlugWithEntitlements` and `entitlementsFromRow`.
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

interface Made {
  slug: string;
  id: string;
  awaiting: boolean;
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

/** Creates an organisation the way the product does. */
async function create(account: Account, freeAllowance = true): Promise<Made> {
  const slug = `allow-${randomUUID().slice(0, 8)}`;
  const made = await provisionOrganization(t.db, {
    user: account,
    envelope,
    slug,
    name: slug,
    freeAllowance,
  });
  return { slug, id: made.organization.id, awaiting: made.awaitingPaidPlan };
}

/** Whether `org` is waiting for a paid plan, as `resolveOrg` reads it. */
async function awaiting(org: Made): Promise<boolean> {
  const found = await findOrganizationBySlugWithEntitlements(t.db, org.slug);
  if (found === null) throw new Error(`no organisation ${org.slug}`);
  const entitlements = entitlementsFromRow(found.entitlements);
  expect(entitlements.controlPlaneActive).toBe(!entitlements.awaitingPaidPlan);
  return entitlements.awaitingPaidPlan;
}

/** A subscription starting or ending, as the webhook and the billing jobs write it. */
async function subscribe(org: Made, plan: 'free' | 'pro' | 'team'): Promise<boolean> {
  const row = await t.db.transaction((tx) =>
    writeSubscriptionState(tx, org.id, {
      plan,
      billingInterval: plan === 'free' ? null : 'monthly',
    }),
  );
  return row?.becameAwaitingPaidPlan ?? false;
}

async function grant(org: Made): Promise<void> {
  const outcome = await t.db.transaction((tx) =>
    applyPlanGrant(tx, {
      orgId: org.id,
      plan: 'team',
      seats: null,
      endsAt: null,
      note: 'test',
      overDodo: false,
      onlyFromFree: false,
    }),
  );
  expect(outcome.ok).toBe(true);
}

async function endGrant(org: Made, freeAllowance = true): Promise<boolean> {
  const ended = await t.db.transaction((tx) => endPlanGrant(tx, org.id, { freeAllowance }));
  return ended?.becameAwaitingPaidPlan ?? false;
}

async function removeFrom(org: Made, account: Account): Promise<void> {
  await t.pg.query(`delete from org_members where org_id = $1 and user_id = $2`, [
    org.id,
    account.id,
  ]);
}

describe('creating', () => {
  it('opens the first two Free organisations and creates the third waiting', async () => {
    const account = await seedAccount();
    const first = await create(account);
    const second = await create(account);
    const third = await create(account);

    expect([first.awaiting, second.awaiting, third.awaiting]).toEqual([false, false, true]);
    expect(await awaiting(first)).toBe(false);
    expect(await awaiting(second)).toBe(false);
    expect(await awaiting(third)).toBe(true);
    expect(await freeOrganizationAllowance(t.db, account.id)).toEqual({ free: 2, awaiting: 1 });
  });

  it('allows one waiting at a time, and refuses a second', async () => {
    const account = await seedAccount();
    await create(account);
    await create(account);
    await create(account);

    await expect(create(account)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('allows the next once the waiting one is bought a plan, and it waits in its turn', async () => {
    const account = await seedAccount();
    await create(account);
    await create(account);
    const third = await create(account);
    await subscribe(third, 'pro');

    expect(await awaiting(third)).toBe(false);
    const fourth = await create(account);
    expect(fourth.awaiting).toBe(true);
  });

  it('allows the next once the waiting one is deleted', async () => {
    const account = await seedAccount();
    await create(account);
    await create(account);
    const third = await create(account);
    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [third.id]);

    await expect(create(account)).resolves.toMatchObject({ awaiting: true });
  });

  it('opens a place again when an open Free organisation is deleted', async () => {
    const account = await seedAccount();
    const first = await create(account);
    await create(account);
    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [first.id]);

    expect((await create(account)).awaiting).toBe(false);
  });

  it('leaves paid organisations unlimited', async () => {
    const account = await seedAccount();
    for (let index = 0; index < 4; index += 1) {
      const paid = await create(account);
      expect(paid.awaiting).toBe(false);
      await subscribe(paid, 'pro');
    }
    expect(await freeOrganizationAllowance(t.db, account.id)).toEqual({ free: 0, awaiting: 0 });
  });

  it('counts a complimentary grant as paid', async () => {
    const account = await seedAccount();
    const granted = await create(account);
    await grant(granted);
    const second = await create(account);
    const third = await create(account);

    expect(await awaiting(second)).toBe(false);
    expect(await awaiting(third)).toBe(false);
  });

  it('never counts somebody else’s Free organisation the account joined', async () => {
    const account = await seedAccount();
    const stranger = await seedAccount();
    for (let index = 0; index < 2; index += 1) {
      const theirs = await create(stranger);
      await t.pg.query(
        `insert into org_members (id, org_id, user_id, role, status) values ($1, $2, $3, 'developer', 'active')`,
        [randomUUID(), theirs.id, account.id],
      );
    }
    expect((await create(account)).awaiting).toBe(false);
    expect((await create(account)).awaiting).toBe(false);
  });

  it('creates nothing waiting where the deployment takes no payments', async () => {
    const account = await seedAccount();
    for (let index = 0; index < 4; index += 1) {
      expect((await create(account, false)).awaiting).toBe(false);
    }
  });
});

describe('dropping back to Free', () => {
  it('makes the one that lapsed wait, and no other', async () => {
    const account = await seedAccount();
    // The oldest is the paid one: under a rule worked out from creation order,
    // its lapse would have made the youngest Free organisation wait instead.
    const paid = await create(account);
    await subscribe(paid, 'pro');
    const second = await create(account);
    const third = await create(account);

    expect(await subscribe(paid, 'free')).toBe(true);
    expect(await awaiting(paid)).toBe(true);
    expect(await awaiting(second)).toBe(false);
    expect(await awaiting(third)).toBe(false);
  });

  it('leaves it open while its creator has fewer than two other open Free organisations', async () => {
    const account = await seedAccount();
    const paid = await create(account);
    await subscribe(paid, 'team');
    await create(account);

    expect(await subscribe(paid, 'free')).toBe(false);
    expect(await awaiting(paid)).toBe(false);
  });

  it('does the same when a grant ends, where the deployment takes payments', async () => {
    const account = await seedAccount();
    const granted = await create(account);
    await grant(granted);
    await create(account);
    await create(account);

    expect(await endGrant(granted)).toBe(true);
    expect(await awaiting(granted)).toBe(true);
  });

  it('never makes an organisation wait when a grant ends where no payment can be taken', async () => {
    const account = await seedAccount();
    const granted = await create(account);
    await grant(granted);
    await create(account);
    await create(account);

    expect(await endGrant(granted, false)).toBe(false);
    expect(await awaiting(granted)).toBe(false);
  });

  it('stops it waiting when it is bought a plan again, or given a grant', async () => {
    const account = await seedAccount();
    const paid = await create(account);
    await subscribe(paid, 'pro');
    await create(account);
    await create(account);
    await subscribe(paid, 'free');

    await subscribe(paid, 'pro');
    expect(await awaiting(paid)).toBe(false);

    await subscribe(paid, 'free');
    expect(await awaiting(paid)).toBe(true);
    await grant(paid);
    expect(await awaiting(paid)).toBe(false);
  });
});

describe('a membership change', () => {
  it('never unlocks a waiting organisation, the creator removed or not', async () => {
    const account = await seedAccount();
    await create(account);
    await create(account);
    const third = await create(account);

    await removeFrom(third, account);
    expect(await awaiting(third)).toBe(true);
  });

  it('never frees a place: an organisation the creator left still counts', async () => {
    const account = await seedAccount();
    const first = await create(account);
    await create(account);

    await removeFrom(first, account);
    expect((await create(account)).awaiting).toBe(true);
  });

  it('never makes an organisation wait: suspending and reinstating the creator moves nothing', async () => {
    const account = await seedAccount();
    const first = await create(account);
    const second = await create(account);
    await t.pg.query(`update org_members set status = 'suspended' where org_id = $1`, [first.id]);
    await t.pg.query(`update org_members set status = 'active' where org_id = $1`, [first.id]);

    expect(await awaiting(first)).toBe(false);
    expect(await awaiting(second)).toBe(false);
  });
});
