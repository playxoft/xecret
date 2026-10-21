import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SECRET_POLICY, DEFAULT_TOKEN_POLICY } from '@xecret/core/policy';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import { removeMember } from './membership';
import {
  deleteOverride,
  listOverrides,
  MAX_OVERRIDES_PER_ENVIRONMENT,
  upsertOverride,
} from './overrides';
import {
  claimReadAlertDigest,
  listAdministratorAddresses,
  listOrgsOwedReadAlerts,
  listReadSightings,
  loadOrgPolicies,
  pruneReadSightings,
  recordReadSighting,
  saveSecretPolicy,
  saveTokenPolicy,
  takeOwedSightings,
  updateEnvironmentPolicy,
} from './policies';
import { RepositoryError } from './shared';
import {
  abandonDelivery,
  claimDeliveries,
  claimDueDeliveries,
  countWebhooks,
  createWebhook,
  deleteWebhook,
  disableWebhookForFailures,
  ENQUEUE_CHUNK,
  enqueueDeliveries,
  findWebhook,
  findWebhookWithSecret,
  listDeliveries,
  listEnabledWebhooksForEvent,
  listEnabledWebhooksForEvents,
  listWebhooks,
  loadOrgKeyForSealing,
  loadOrgKeyVersion,
  pruneWebhookDeliveries,
  recordDeliveryAttempt,
  releaseDeliveries,
  updateWebhook,
} from './webhooks';

/**
 * Personal overrides, webhooks, policies and read sightings (P19, migrations
 * 0029–0032), against a real PostgreSQL with every migration applied.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

const ascii = (value: string) => new TextEncoder().encode(value);

async function attempt(sql: string, params: unknown[]): Promise<string | null> {
  try {
    await t.pg.query(sql, params);
    return null;
  } catch (cause) {
    return (cause as Error).message;
  }
}

async function user(): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_${id.slice(0, 8)}`, `p19-${id.slice(0, 8)}@example.com`],
  );
  return id;
}

interface Fixture {
  orgId: string;
  ownerId: string;
  projectId: string;
  environmentId: string;
}

async function fixture(): Promise<Fixture> {
  const ownerId = await user();
  const orgId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, ownerId],
  );
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, ownerId],
  );
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, 'API', 'api', $3)`,
    [projectId, orgId, ownerId],
  );
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode, is_production) values ($1, $2, 'Production', 'production', 'e2ee', true)`,
    [environmentId, projectId],
  );
  return { orgId, ownerId, projectId, environmentId };
}

async function member(orgId: string, role: string): Promise<{ userId: string; memberId: string }> {
  const userId = await user();
  const memberId = randomUUID();
  await t.pg.query(`insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`, [
    memberId,
    orgId,
    userId,
    role,
  ]);
  return { userId, memberId };
}

/* ── personal overrides ──────────────────────────────────────────────────── */

describe('personal overrides', () => {
  it('belong to one person: set, replaced, listed and removed by their owner alone', async () => {
    const f = await fixture();
    const teammate = await member(f.orgId, 'developer');
    const owner = { orgId: f.orgId, environmentId: f.environmentId, userId: f.ownerId };

    const first = await upsertOverride(t.db, {
      ...owner,
      name: 'DB_URL',
      ciphertext: ascii('xk2.x25519.a'),
    });
    expect(first.created).toBe(true);
    const second = await upsertOverride(t.db, {
      ...owner,
      name: 'DB_URL',
      ciphertext: ascii('xk2.x25519.b'),
    });
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);

    const listed = await listOverrides(t.db, owner);
    expect(listed.map((row) => [row.name, new TextDecoder().decode(row.ciphertext)])).toEqual([
      ['DB_URL', 'xk2.x25519.b'],
    ]);

    // Nothing in the file can return another person's override.
    expect(await listOverrides(t.db, { ...owner, userId: teammate.userId })).toEqual([]);
    expect(
      await deleteOverride(t.db, { ...owner, userId: teammate.userId, name: 'DB_URL' }),
    ).toBeNull();

    expect((await deleteOverride(t.db, { ...owner, name: 'DB_URL' }))?.id).toBe(first.record.id);
    expect(await listOverrides(t.db, owner)).toEqual([]);
  });

  it('refuses an environment outside the organisation, and a name outside the grammar', async () => {
    const f = await fixture();
    const stranger = await fixture();
    await expect(
      upsertOverride(t.db, {
        orgId: stranger.orgId,
        environmentId: f.environmentId,
        userId: stranger.ownerId,
        name: 'X',
        ciphertext: ascii('x'),
      }),
    ).rejects.toThrow(RepositoryError);

    expect(
      await attempt(
        `insert into personal_overrides (id, org_id, environment_id, user_id, name, ciphertext) values ($1, $2, $3, $4, 'bad-name', '\\x00')`,
        [randomUUID(), f.orgId, f.environmentId, f.ownerId],
      ),
    ).toMatch(/personal_overrides_name_check/);
  });

  it(`caps new names at ${MAX_OVERRIDES_PER_ENVIRONMENT}, but lets an existing one be replaced`, async () => {
    const f = await fixture();
    const owner = { orgId: f.orgId, environmentId: f.environmentId, userId: f.ownerId };
    const values = Array.from({ length: MAX_OVERRIDES_PER_ENVIRONMENT }, (_, index) => [
      randomUUID(),
      f.orgId,
      f.environmentId,
      f.ownerId,
      `K${index}`,
      ascii('xk2.x25519.x'),
    ]);
    for (const row of values) {
      await t.pg.query(
        `insert into personal_overrides (id, org_id, environment_id, user_id, name, ciphertext) values ($1, $2, $3, $4, $5, $6)`,
        row,
      );
    }

    await expect(
      upsertOverride(t.db, { ...owner, name: 'ONE_MORE', ciphertext: ascii('x') }),
    ).rejects.toMatchObject({ code: 'quotaExceeded' });
    await expect(
      upsertOverride(t.db, { ...owner, name: 'K0', ciphertext: ascii('replaced') }),
    ).resolves.toMatchObject({ created: false });
  });

  it('go with the member when they are removed from the organisation', async () => {
    const f = await fixture();
    const leaver = await member(f.orgId, 'developer');
    await upsertOverride(t.db, {
      orgId: f.orgId,
      environmentId: f.environmentId,
      userId: leaver.userId,
      name: 'MINE',
      ciphertext: ascii('x'),
    });

    await removeMember(t.db, { orgId: f.orgId, memberId: leaver.memberId }, () => undefined);

    const left = await t.pg.query<{ n: number }>(
      `select count(*)::int as n from personal_overrides where user_id = $1`,
      [leaver.userId],
    );
    expect(left.rows[0]!.n).toBe(0);
  });
});

/* ── webhooks ────────────────────────────────────────────────────────────── */

const sealed = { ciphertext: ascii('sealed'), iv: new Uint8Array(12), keyVersion: 1 };

async function webhook(f: Fixture, eventTypes = ['secret.updated']) {
  return createWebhook(t.db, {
    id: randomUUID(),
    orgId: f.orgId,
    url: 'https://hooks.example.com/x',
    description: null,
    eventTypes,
    secret: sealed,
    createdBy: f.ownerId,
  });
}

describe('webhooks', () => {
  it('lists without the secret, and finds with it only when asked', async () => {
    const f = await fixture();
    const hook = await webhook(f);

    const [listed] = await listWebhooks(t.db, f.orgId);
    expect(listed).toMatchObject({ id: hook.id, enabled: true, disabledReason: null });
    expect(Object.keys(listed!)).not.toContain('secretCiphertext');
    expect(Object.keys(listed!)).not.toContain('secret');

    expect((await findWebhookWithSecret(t.db, f.orgId, hook.id))?.secret.keyVersion).toBe(1);
    expect(await countWebhooks(t.db, f.orgId)).toBe(1);

    const stranger = await fixture();
    expect(await findWebhook(t.db, stranger.orgId, hook.id)).toBeNull();
    expect(await findWebhookWithSecret(t.db, stranger.orgId, hook.id)).toBeNull();
    expect(await deleteWebhook(t.db, stranger.orgId, hook.id)).toBeNull();
  });

  it('selects only enabled endpoints subscribed to the event', async () => {
    const f = await fixture();
    const subscribed = await webhook(f, ['secret.updated', 'secret.created']);
    await webhook(f, ['environment.promoted']);
    const off = await webhook(f, ['secret.updated']);
    await updateWebhook(t.db, f.orgId, off.id, { enabled: false });

    const hooks = await listEnabledWebhooksForEvent(t.db, f.orgId, 'secret.updated');
    expect(hooks.map((hook) => hook.id)).toEqual([subscribed.id]);
    expect(hooks[0]!.secret.ciphertext).toEqual(ascii('sealed'));
  });

  it('keeps "off" and "why it is off" together', async () => {
    const f = await fixture();
    const hook = await webhook(f);
    expect(await attempt(`update webhooks set enabled = false where id = $1`, [hook.id])).toMatch(
      /webhooks_enabled_reason_check/,
    );

    const off = await updateWebhook(t.db, f.orgId, hook.id, { enabled: false });
    expect(off).toMatchObject({ enabled: false, disabledReason: 'manual' });
    const on = await updateWebhook(t.db, f.orgId, hook.id, { enabled: true });
    expect(on).toMatchObject({ enabled: true, disabledReason: null, consecutiveFailures: 0 });
  });

  it('claims a delivery once, retries it, and counts the failures on its endpoint', async () => {
    const f = await fixture();
    const hook = await webhook(f);
    const [id] = await enqueueDeliveries(t.db, [
      { webhookId: hook.id, orgId: f.orgId, eventType: 'secret.updated', body: '{"a":1}' },
    ]);

    const claimed = await claimDeliveries(t.db, [id!]);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.webhook.secret.ciphertext).toEqual(ascii('sealed'));
    // A second sender gets nothing.
    expect(await claimDeliveries(t.db, [id!])).toEqual([]);

    const afterFailure = await recordDeliveryAttempt(t.db, {
      deliveryId: id!,
      webhookId: hook.id,
      outcome: {
        kind: 'failed',
        statusCode: 500,
        error: 'HTTP 500',
        retryAt: new Date(Date.now() - 1000),
      },
    });
    expect(afterFailure).toMatchObject({ consecutiveFailures: 1 });
    expect(afterFailure!.failingSince).not.toBeNull();

    // Due again, so the sweep takes it.
    const swept = await claimDueDeliveries(t.db, 10);
    expect(swept.map((entry) => entry.delivery.id)).toContain(id);

    const afterSuccess = await recordDeliveryAttempt(t.db, {
      deliveryId: id!,
      webhookId: hook.id,
      outcome: { kind: 'succeeded', statusCode: 204 },
    });
    expect(afterSuccess).toMatchObject({ consecutiveFailures: 0, failingSince: null });

    const [logged] = await listDeliveries(t.db, f.orgId, hook.id, 10);
    expect(logged).toMatchObject({ status: 'succeeded', attempts: 2, lastStatusCode: 204 });
    expect(await listDeliveries(t.db, (await fixture()).orgId, hook.id, 10)).toEqual([]);
  });

  it('takes back a delivery whose sender died mid-claim', async () => {
    const f = await fixture();
    const hook = await webhook(f);
    const [id] = await enqueueDeliveries(t.db, [
      { webhookId: hook.id, orgId: f.orgId, eventType: 'secret.updated', body: '{}' },
    ]);
    await t.pg.query(
      `update webhook_deliveries set status = 'delivering', claimed_at = now() - interval '10 minutes' where id = $1`,
      [id],
    );
    expect((await claimDueDeliveries(t.db, 50)).map((entry) => entry.delivery.id)).toContain(id);
  });

  it('takes organisations in turns, so one backlog cannot starve another (review round 1, M4)', async () => {
    // Nothing else owed, so the claim is about these two organisations alone.
    const settle = () =>
      t.pg.query(
        `update webhook_deliveries set status = 'abandoned', next_attempt_at = null, claimed_at = null
         where status in ('pending', 'delivering')`,
      );
    await settle();

    const busy = await fixture();
    const busyHook = await webhook(busy);
    const backlog = await enqueueDeliveries(
      t.db,
      Array.from({ length: 3000 }, () => ({
        webhookId: busyHook.id,
        orgId: busy.orgId,
        eventType: 'secret.updated',
        body: '{}',
      })),
    );
    // Every one of them older than anything the quiet organisation owes.
    await t.pg.query(
      `update webhook_deliveries set next_attempt_at = now() - interval '1 hour' where webhook_id = $1`,
      [busyHook.id],
    );
    const quiet = await fixture();
    const quietHook = await webhook(quiet);
    const [single] = await enqueueDeliveries(t.db, [
      { webhookId: quietHook.id, orgId: quiet.orgId, eventType: 'secret.updated', body: '{}' },
    ]);

    const first = await claimDueDeliveries(t.db, 25);
    expect(first).toHaveLength(25);
    expect(first.filter((entry) => entry.delivery.orgId === busy.orgId)).toHaveLength(24);
    // In turns: the backlog's oldest, then the quiet organisation's one, then
    // the rest of the backlog — the order a sweep attempts them in.
    expect(first.map((entry) => entry.delivery.id).indexOf(single!)).toBe(1);

    // And with nobody else waiting, the backlog gets every claim, oldest first.
    const second = await claimDueDeliveries(t.db, 25);
    expect(second).toHaveLength(25);
    expect(second.every((entry) => entry.delivery.orgId === busy.orgId)).toBe(true);
    const claimedIds = new Set([...first, ...second].map((entry) => entry.delivery.id));
    expect(claimedIds.size).toBe(50);
    expect(backlog.filter((id) => claimedIds.has(id))).toHaveLength(49);

    await settle();
  });

  it(
    'prefers organisations never claimed from, so more than 25 backlogged ones ' +
      'cannot starve a newcomer (review round 2, F4)',
    async () => {
      // Picking organisations by whose oldest delivery had waited longest let
      // more than `limit` simultaneously backlogged organisations shut out
      // everybody else forever: a newcomer's delivery is, by definition,
      // younger than ones that have already been waiting, so it never made
      // the cut while that many older backlogs kept re-qualifying every
      // sweep. The fix orders candidate organisations by when they were last
      // served instead — oldest claim first, never-claimed-from first of
      // all — so a newcomer the first sweep skipped is first in line for the
      // next one.
      const settle = () =>
        t.pg.query(
          `update webhook_deliveries set status = 'abandoned', next_attempt_at = null, claimed_at = null
           where status in ('pending', 'delivering')`,
        );
      await settle();

      const BACKLOGGED = 25;
      for (let i = 0; i < BACKLOGGED; i += 1) {
        const org = await fixture();
        const hook = await webhook(org);
        // Two apiece, so each organisation still has one left after the
        // first sweep claims the other — still backlogged, still competing,
        // for the second sweep to actually test anything.
        await enqueueDeliveries(t.db, [
          { webhookId: hook.id, orgId: org.orgId, eventType: 'secret.updated', body: '{}' },
          { webhookId: hook.id, orgId: org.orgId, eventType: 'secret.updated', body: '{}' },
        ]);
        await t.pg.query(
          `update webhook_deliveries set next_attempt_at = now() - interval '2 hours' where webhook_id = $1`,
          [hook.id],
        );
      }

      const newcomer = await fixture();
      const newcomerHook = await webhook(newcomer);
      const [newcomerDeliveryId] = await enqueueDeliveries(t.db, [
        {
          webhookId: newcomerHook.id,
          orgId: newcomer.orgId,
          eventType: 'secret.updated',
          body: '{}',
        },
      ]);
      // Due, but younger than every one of the 25 backlogs.
      await t.pg.query(
        `update webhook_deliveries set next_attempt_at = now() - interval '1 minute' where webhook_id = $1`,
        [newcomerHook.id],
      );

      // First sweep: 26 organisations are due and only 25 fit. Nobody has
      // been served yet, so the tie is broken by age, same as the old rule
      // — the newcomer's single, younger delivery loses out.
      const first = await claimDueDeliveries(t.db, BACKLOGGED);
      expect(first).toHaveLength(BACKLOGGED);
      expect(first.some((entry) => entry.delivery.id === newcomerDeliveryId)).toBe(false);

      // Second sweep: the 25 backlogged organisations were just served, so
      // they are no longer "never claimed from" — the newcomer, still never
      // served, now sorts first and is no longer shut out by organisations
      // that simply have an older backlog.
      const second = await claimDueDeliveries(t.db, BACKLOGGED);
      expect(second.some((entry) => entry.delivery.id === newcomerDeliveryId)).toBe(true);

      await settle();
    },
  );

  it('hands back claims a sweep did not get to, due as they were', async () => {
    const f = await fixture();
    const hook = await webhook(f);
    const [id] = await enqueueDeliveries(t.db, [
      { webhookId: hook.id, orgId: f.orgId, eventType: 'secret.updated', body: '{}' },
    ]);
    await claimDeliveries(t.db, [id!]);
    await releaseDeliveries(t.db, [id!]);
    const [row] = (
      await t.pg.query<{ status: string; claimed_at: Date | null; attempts: number }>(
        `select status, claimed_at, attempts from webhook_deliveries where id = $1`,
        [id],
      )
    ).rows;
    expect(row).toEqual({ status: 'pending', claimed_at: null, attempts: 0 });
    expect((await claimDeliveries(t.db, [id!])).map((entry) => entry.delivery.id)).toEqual([id]);
  });

  it('abandons a delivery with no retries left, and disables an endpoint once', async () => {
    const f = await fixture();
    const hook = await webhook(f);
    const [first, second] = await enqueueDeliveries(t.db, [
      { webhookId: hook.id, orgId: f.orgId, eventType: 'secret.updated', body: '{}' },
      { webhookId: hook.id, orgId: f.orgId, eventType: 'secret.updated', body: '{}' },
    ]);
    await claimDeliveries(t.db, [first!]);
    await recordDeliveryAttempt(t.db, {
      deliveryId: first!,
      webhookId: hook.id,
      outcome: { kind: 'failed', statusCode: null, error: 'timeout', retryAt: null },
    });

    const disabled = await disableWebhookForFailures(t.db, hook.id);
    expect(disabled).toMatchObject({ enabled: false, disabledReason: 'failures' });
    expect(await disableWebhookForFailures(t.db, hook.id)).toBeNull();

    const statuses = await t.pg.query<{ id: string; status: string }>(
      `select id, status from webhook_deliveries where webhook_id = $1`,
      [hook.id],
    );
    expect(Object.fromEntries(statuses.rows.map((row) => [row.id, row.status]))).toEqual({
      [first!]: 'abandoned',
      [second!]: 'abandoned',
    });
  });

  it('prunes finished deliveries past their age and leaves owed ones', async () => {
    const f = await fixture();
    const hook = await webhook(f);
    const [done, owed] = await enqueueDeliveries(t.db, [
      { webhookId: hook.id, orgId: f.orgId, eventType: 'secret.updated', body: '{}' },
      { webhookId: hook.id, orgId: f.orgId, eventType: 'secret.updated', body: '{}' },
    ]);
    await t.pg.query(
      `update webhook_deliveries set status = 'succeeded', created_at = now() - interval '40 days' where id = $1`,
      [done],
    );
    await t.pg.query(
      `update webhook_deliveries set created_at = now() - interval '40 days' where id = $1`,
      [owed],
    );
    expect(
      await pruneWebhookDeliveries(t.db, new Date(Date.now() - 30 * 86_400_000)),
    ).toBeGreaterThanOrEqual(1);
    const left = await t.pg.query<{ id: string }>(
      `select id from webhook_deliveries where webhook_id = $1`,
      [hook.id],
    );
    expect(left.rows.map((row) => row.id)).toEqual([owed]);
  });

  it('lists, in one query, the enabled endpoints subscribed to any of a batch of events', async () => {
    const f = await fixture();
    const created = await webhook(f, ['secret.created']);
    const both = await webhook(f, ['secret.created', 'secret.deleted']);
    await webhook(f, ['environment.promoted']);
    const off = await webhook(f, ['secret.deleted']);
    await updateWebhook(t.db, f.orgId, off.id, { enabled: false });
    await webhook(await fixture(), ['secret.created']);

    const hooks = await listEnabledWebhooksForEvents(t.db, f.orgId, [
      'secret.created',
      'secret.deleted',
      'secret.created',
    ]);
    expect(hooks.map((hook) => hook.id).sort()).toEqual([created.id, both.id].sort());
    expect(hooks[0]!.secret.ciphertext).toEqual(ascii('sealed'));
    expect(await listEnabledWebhooksForEvents(t.db, f.orgId, [])).toEqual([]);
  });

  it('abandons a claimed delivery without counting it against the endpoint', async () => {
    const f = await fixture();
    const hook = await webhook(f);
    const [id] = await enqueueDeliveries(t.db, [
      { webhookId: hook.id, orgId: f.orgId, eventType: 'secret.updated', body: '{}' },
    ]);
    // Only a claimed one: a pending delivery is the sweep's to take.
    await abandonDelivery(t.db, id!, 'endpoint switched off before delivery');
    expect((await listDeliveries(t.db, f.orgId, hook.id, 1))[0]!.status).toBe('pending');

    await claimDeliveries(t.db, [id!]);
    await abandonDelivery(t.db, id!, 'endpoint switched off before delivery');
    expect((await listDeliveries(t.db, f.orgId, hook.id, 1))[0]).toMatchObject({
      status: 'abandoned',
      attempts: 0,
      lastError: 'endpoint switched off before delivery',
      nextAttemptAt: null,
    });
    expect(await findWebhook(t.db, f.orgId, hook.id)).toMatchObject({ consecutiveFailures: 0 });
  });

  it('splits a very large batch across statements, and answers every id in order', async () => {
    const f = await fixture();
    const hook = await webhook(f);
    t.reset();
    const ids = await enqueueDeliveries(
      t.db,
      Array.from({ length: ENQUEUE_CHUNK + 3 }, () => ({
        webhookId: hook.id,
        orgId: f.orgId,
        eventType: 'secret.updated',
        body: '{}',
      })),
    );
    expect(ids).toHaveLength(ENQUEUE_CHUNK + 3);
    expect(
      t.statements.filter((statement) => /insert into "webhook_deliveries"/.test(statement.sql)),
    ).toHaveLength(2);
    const stored = await t.pg.query<{ n: number }>(
      `select count(*)::int as n from webhook_deliveries where webhook_id = $1`,
      [hook.id],
    );
    expect(stored.rows[0]!.n).toBe(ENQUEUE_CHUNK + 3);
    await t.pg.query(`delete from webhook_deliveries where webhook_id = $1`, [hook.id]);
  });

  it('loads the org key to seal under, and the version a secret was sealed with', async () => {
    const f = await fixture();
    const insertKey = (version: number, status: 'active' | 'retired') =>
      t.pg.query(
        `insert into org_keys (id, org_id, version, wrapped_key, wrap_iv, root_key_version, status)
         values ($1, $2, $3, $4, $5, 1, $6)`,
        [randomUUID(), f.orgId, version, ascii(`key-${version}`), new Uint8Array(12), status],
      );
    expect(await loadOrgKeyForSealing(t.db, f.orgId)).toBeNull();
    await insertKey(1, 'retired');
    await insertKey(2, 'active');

    const current = await loadOrgKeyForSealing(t.db, f.orgId);
    expect(current).toMatchObject({ version: 2, rootKeyVersion: 1, algorithm: 'AES-256-GCM' });
    expect(current!.ciphertext).toEqual(ascii('key-2'));
    // A retired version still opens what it sealed.
    expect((await loadOrgKeyVersion(t.db, f.orgId, 1))!.ciphertext).toEqual(ascii('key-1'));
    expect(await loadOrgKeyVersion(t.db, f.orgId, 3)).toBeNull();
    expect(await loadOrgKeyVersion(t.db, (await fixture()).orgId, 1)).toBeNull();
  });
});

/* ── policies ────────────────────────────────────────────────────────────── */

describe('organisation policies', () => {
  it('answers every default for an organisation that never set one', async () => {
    const f = await fixture();
    expect(await loadOrgPolicies(t.db, f.orgId)).toEqual({
      tokens: DEFAULT_TOKEN_POLICY,
      secrets: DEFAULT_SECRET_POLICY,
      updatedAt: null,
    });
  });

  it('stores each policy without disturbing the other', async () => {
    const f = await fixture();
    await saveTokenPolicy(t.db, {
      orgId: f.orgId,
      policy: { requireIpAllowlist: true, maxLifetimeDays: 30 },
      updatedBy: f.ownerId,
    });
    await saveSecretPolicy(t.db, {
      orgId: f.orgId,
      policy: { ...DEFAULT_SECRET_POLICY, enabled: true },
      updatedBy: f.ownerId,
    });

    const loaded = await loadOrgPolicies(t.db, f.orgId);
    expect(loaded.tokens).toEqual({ requireIpAllowlist: true, maxLifetimeDays: 30 });
    expect(loaded.secrets.enabled).toBe(true);
    expect(loaded.updatedAt).toBeInstanceOf(Date);

    expect(
      await attempt(`update org_policies set token_max_lifetime_days = 0 where org_id = $1`, [
        f.orgId,
      ]),
    ).toMatch(/org_policies_token_lifetime_check/);
  });

  it('fills a field an older stored policy lacks from the default', async () => {
    const f = await fixture();
    await t.pg.query(
      `insert into org_policies (org_id, secret_policy) values ($1, '{"enabled": true}')`,
      [f.orgId],
    );
    const loaded = await loadOrgPolicies(t.db, f.orgId);
    expect(loaded.secrets).toEqual({ ...DEFAULT_SECRET_POLICY, enabled: true });
  });

  it('sets an environment’s switches within the organisation', async () => {
    const f = await fixture();
    const updated = await updateEnvironmentPolicy(t.db, f.orgId, f.environmentId, {
      plaintextExportDisabled: true,
      readAlerts: false,
    });
    expect(updated).toMatchObject({ plaintextExportDisabled: true, readAlerts: false });

    const reset = await updateEnvironmentPolicy(t.db, f.orgId, f.environmentId, {
      readAlerts: null,
    });
    expect(reset.readAlerts).toBeNull();
    expect(reset.plaintextExportDisabled).toBe(true);

    const stranger = await fixture();
    await expect(
      updateEnvironmentPolicy(t.db, stranger.orgId, f.environmentId, { readAlerts: true }),
    ).rejects.toThrow(RepositoryError);
  });

  it('addresses owners and admins, never developers or the suspended', async () => {
    const f = await fixture();
    await member(f.orgId, 'admin');
    await member(f.orgId, 'developer');
    const suspended = await member(f.orgId, 'admin');
    await t.pg.query(`update org_members set status = 'suspended' where id = $1`, [
      suspended.memberId,
    ]);
    expect(await listAdministratorAddresses(t.db, f.orgId, 10)).toHaveLength(2);
  });
});

/* ── read sightings ──────────────────────────────────────────────────────── */

describe('read sightings', () => {
  const sighting = (f: Fixture, ip: string, principalId = f.ownerId) => ({
    orgId: f.orgId,
    environmentId: f.environmentId,
    principalKind: 'cli_token' as const,
    principalId,
    principalLabel: 'laptop',
    ipAddress: ip,
  });

  it('is new once per principal and address', async () => {
    const f = await fixture();
    expect(await recordReadSighting(t.db, sighting(f, '198.51.100.7'))).toEqual({ isNew: true });
    expect(await recordReadSighting(t.db, sighting(f, '198.51.100.7'))).toEqual({ isNew: false });
    expect(await recordReadSighting(t.db, sighting(f, '198.51.100.8'))).toEqual({ isNew: true });
    expect(await recordReadSighting(t.db, sighting(f, '198.51.100.7', randomUUID()))).toEqual({
      isNew: true,
    });
    expect(await listReadSightings(t.db, f.orgId, f.environmentId, 10)).toHaveLength(3);
  });

  it('throttles the digest to one claim per window', async () => {
    const f = await fixture();
    const hourAgo = new Date(Date.now() - 3_600_000);
    expect(await claimReadAlertDigest(t.db, f.orgId, hourAgo)).toBe(true);
    expect(await claimReadAlertDigest(t.db, f.orgId, hourAgo)).toBe(false);
    // Once the last send is older than the window, the next claim succeeds.
    await t.pg.query(
      `update read_alert_digests set last_sent_at = now() - interval '2 hours' where org_id = $1`,
      [f.orgId],
    );
    expect(await claimReadAlertDigest(t.db, f.orgId, hourAgo)).toBe(true);
  });

  it('hands each owed sighting out once, with what an alert names', async () => {
    const f = await fixture();
    await recordReadSighting(t.db, sighting(f, '198.51.100.20'));
    await recordReadSighting(t.db, sighting(f, '198.51.100.21'));

    expect(await listOrgsOwedReadAlerts(t.db, new Date(), 100)).toContain(f.orgId);

    const owed = await takeOwedSightings(t.db, f.orgId, 50);
    expect(owed).toHaveLength(2);
    expect(owed[0]).toMatchObject({
      environmentSlug: 'production',
      projectSlug: 'api',
      isProduction: true,
      principalLabel: 'laptop',
    });
    expect(await takeOwedSightings(t.db, f.orgId, 50)).toEqual([]);
    expect(await listOrgsOwedReadAlerts(t.db, new Date(), 100)).not.toContain(f.orgId);
  });

  it('prunes what has not been seen in a long while', async () => {
    const f = await fixture();
    await recordReadSighting(t.db, sighting(f, '198.51.100.30'));
    await t.pg.query(
      `update environment_read_sightings set last_seen_at = now() - interval '200 days' where org_id = $1`,
      [f.orgId],
    );
    expect(await pruneReadSightings(t.db, new Date(Date.now() - 180 * 86_400_000))).toBeGreaterThan(
      0,
    );
    expect(await recordReadSighting(t.db, sighting(f, '198.51.100.30'))).toEqual({ isNew: true });
  });
});
