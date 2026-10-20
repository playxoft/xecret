import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Bindings } from '../bindings';
import { createLogger } from '../logging';
import type { MailMessage } from '../mail';

/**
 * Sending a billing reminder: once per occasion, throttled where it repeats,
 * to live owners only — against a real database, with the mail provider
 * stubbed.
 */

const sent = vi.hoisted(() => ({ messages: [] as MailMessage[], fail: false }));
vi.mock('../mail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mail')>()),
  mailerFrom: (env: Bindings) =>
    env.ZEPTOMAIL_TOKEN
      ? {
          send: async (message: MailMessage) => {
            if (sent.fail) throw new Error('provider down');
            sent.messages.push(message);
          },
        }
      : null,
}));

const { sendBillingReminder, PAYMENT_FAILED_THROTTLE_MS } = await import('./reminders');

let t: TestDatabase;
const log = createLogger({
  sink: { write: () => {}, flush: () => Promise.resolve() },
  minimum: 'error',
}).logger;
const env = {
  XECRET_ENV: 'production',
  XECRET_PUBLIC_URL: 'https://xecret.playxoft.com',
  ZEPTOMAIL_TOKEN: 'token',
  ZEPTOMAIL_FROM_ADDRESS: 'no-reply@example.com',
} as unknown as Bindings;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  sent.messages = [];
  sent.fail = false;
  vi.useRealTimers();
});

async function seedUser(email: string, over: { deleted?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified, deleted_at) values ($1, $2, $3, true, $4)`,
    [id, `user_01${id.replaceAll('-', '').slice(0, 20)}`, email, over.deleted ? new Date() : null],
  );
  return id;
}

async function seedOrg(): Promise<{ orgId: string; slug: string }> {
  const tag = randomUUID().slice(0, 8);
  const ownerId = await seedUser(`owner-${tag}@example.com`);
  const orgId = randomUUID();
  const slug = `acme-${tag}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, slug, ownerId],
  );
  await t.pg.query(`insert into org_subscriptions (org_id) values ($1)`, [orgId]);
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, ownerId],
  );
  return { orgId, slug };
}

const services = () => ({ env, db: t.db, log });

describe('sendBillingReminder', () => {
  it('sends to every live, active owner, once per occasion', async () => {
    const { orgId, slug } = await seedOrg();
    const second = await seedUser(`second-${randomUUID().slice(0, 8)}@example.com`);
    const suspended = await seedUser(`suspended-${randomUUID().slice(0, 8)}@example.com`);
    const developer = await seedUser(`dev-${randomUUID().slice(0, 8)}@example.com`);
    for (const [userId, role, status] of [
      [second, 'owner', 'active'],
      [suspended, 'owner', 'suspended'],
      [developer, 'developer', 'active'],
    ] as const) {
      await t.pg.query(
        `insert into org_members (id, org_id, user_id, role, status) values ($1, $2, $3, $4, $5)`,
        [randomUUID(), orgId, userId, role, status],
      );
    }

    const reminder = { kind: 'invoice_available' as const };
    expect(await sendBillingReminder(services(), { orgId, occasion: 'pay_1', reminder })).toBe(
      'sent',
    );
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0]!.text).toContain(
      `https://xecret.playxoft.com/app/${slug}/settings/billing`,
    );

    // The same payment, delivered again by a retried webhook: nothing more.
    expect(await sendBillingReminder(services(), { orgId, occasion: 'pay_1', reminder })).toBe(
      'duplicate',
    );
    expect(sent.messages).toHaveLength(2);
  });

  it('throttles payment failures to one email a day, whatever the occasion', async () => {
    const { orgId } = await seedOrg();
    const reminder = { kind: 'payment_failed' as const, plan: 'team' };

    expect(await sendBillingReminder(services(), { orgId, occasion: 'pay_a', reminder })).toBe(
      'sent',
    );
    // Dodo's next retry is a new payment, a new occasion — and still throttled.
    expect(await sendBillingReminder(services(), { orgId, occasion: 'pay_b', reminder })).toBe(
      'throttled',
    );
    expect(sent.messages).toHaveLength(1);

    // A day later the throttle has passed.
    await t.pg.query(
      `update billing_reminders set sent_at = now() - make_interval(secs => $2)
        where org_id = $1 and kind = 'payment_failed'`,
      [orgId, PAYMENT_FAILED_THROTTLE_MS / 1000 + 60],
    );
    expect(await sendBillingReminder(services(), { orgId, occasion: 'pay_c', reminder })).toBe(
      'sent',
    );
  });

  it('claims the reminder before sending, so a provider outage costs one email, never repeats it', async () => {
    const { orgId } = await seedOrg();
    sent.fail = true;
    const reminder = { kind: 'invoice_available' as const };
    expect(await sendBillingReminder(services(), { orgId, occasion: 'pay_x', reminder })).toBe(
      'sent',
    );
    sent.fail = false;
    expect(await sendBillingReminder(services(), { orgId, occasion: 'pay_x', reminder })).toBe(
      'duplicate',
    );
    expect(sent.messages).toHaveLength(0);
  });

  it('sends nothing, and claims nothing, on a deployment with no mail provider', async () => {
    const { orgId } = await seedOrg();
    const reminder = { kind: 'invoice_available' as const };
    const noMail = { ...services(), env: { ...env, ZEPTOMAIL_TOKEN: undefined } as Bindings };
    expect(await sendBillingReminder(noMail, { orgId, occasion: 'pay_y', reminder })).toBe(
      'no-mailer',
    );
    // Mail configured later: the reminder was never spent.
    expect(await sendBillingReminder(services(), { orgId, occasion: 'pay_y', reminder })).toBe(
      'sent',
    );
  });

  it('tells nobody when there is no live owner to tell', async () => {
    expect(
      await sendBillingReminder(services(), {
        orgId: randomUUID(),
        occasion: 'x',
        reminder: { kind: 'invoice_available' },
      }),
    ).toBe('no-recipients');
  });
});
