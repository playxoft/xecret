import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EnvelopeService,
  generateKeyBytes,
  InMemoryKeyProvider,
  parseRootKeyMaterial,
  toBase64Url,
} from '@xecret/core/crypto';
import { createWebhook } from '@xecret/db/repositories';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import { AWAITING_PAID_PLAN_MESSAGE } from './entitlements';
import { errors } from './errors';
import { createLogger } from './logging';
import type { RequestLog } from './logging';
import { ORIGIN, routeFixtures } from './testing/route-fixtures';
import type { Org } from './testing/route-fixtures';
import type { EntitlementsPayload } from './schemas/entitlements';

/**
 * The closed control plane of an organisation awaiting a paid plan, end to end
 * against PGlite, and the read-only entitlements endpoint the dashboard's locks
 * are drawn from.
 *
 * An account's Free organisations work up to two; the one past them is
 * recorded waiting for a paid plan (`organizations.awaiting_paid_plan_since`).
 * Every write to it is refused by `resolveOrg` (`guardControlPlane`) with one
 * plan refusal, except what stays open: every read (the data plane included)
 * and every DELETE; paying; taking access away that is not a DELETE (a member
 * suspended or lowered, a webhook switched off, a key rotated); and reaching
 * what people may already read (an environment's key shared, the CLI's device
 * sign-in). Where this deployment takes no payments the rule does not apply.
 */

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const actor = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertCsrf: vi.fn(),
  isUnlocked: vi.fn(() => true),
}));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));

vi.mock('./context', () => context);
vi.mock('./actor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./actor')>()),
  ...actor,
}));
vi.mock('./audit-sink', () => ({
  DatabaseAuditSink: class {
    write = auditSink.write;
  },
}));
vi.mock('./logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logging')>()),
  createRequestLog: logging.createRequestLog,
}));
const meter = vi.hoisted(() => ({ countSecretFetch: vi.fn() }));
vi.mock('./billing/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing/usage')>()),
  countSecretFetch: meter.countSecretFetch,
}));

const orgRoute = await import('@/app/api/orgs/[orgSlug]/route');
const projectsRoute = await import('@/app/api/orgs/[orgSlug]/projects/route');
const membersRoute = await import('@/app/api/orgs/[orgSlug]/members/route');
const serviceTokensRoute = await import('@/app/api/orgs/[orgSlug]/tokens/service/route');
const tokenRoute = await import('@/app/api/orgs/[orgSlug]/tokens/[kind]/[tokenId]/route');
const memberRoute = await import('@/app/api/orgs/[orgSlug]/members/[memberId]/route');
const invitationRoute = await import('@/app/api/orgs/[orgSlug]/invitations/[invitationId]/route');
const webhooksRoute = await import('@/app/api/orgs/[orgSlug]/webhooks/route');
const promoCodeRoute = await import('@/app/api/orgs/[orgSlug]/billing/promo-code/route');
const projectRoute = await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/route');
const grantsRoute = await import('@/app/api/orgs/[orgSlug]/members/[memberId]/grants/route');
const webhookRoute = await import('@/app/api/orgs/[orgSlug]/webhooks/[webhookId]/route');
const roleRoute = await import('@/app/api/orgs/[orgSlug]/roles/[roleId]/route');
const rotateRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/keys/rotate/route');
const keyGrantsRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/keys/grants/route');
const keyGrantRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/keys/grants/[grantId]/route');
const entitlementsRoute = await import('@/app/api/orgs/[orgSlug]/entitlements/route');
const pullRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/pull/route');

let t: TestDatabase;
let envelope: EnvelopeService;
let deferred: Promise<unknown>[] = [];
let caller: Principal | null;
/** Whether this deployment takes payments: the free allowance applies only where it does. */
let payments = true;

const BILLING_ENV = {
  DODO_API_KEY: 'dodo-example-not-a-real-key',
  DODO_WEBHOOK_SECRET: `whsec_${btoa('example-not-a-real-key-32-bytes!')}`,
  DODO_ENVIRONMENT: 'test_mode',
  DODO_PRODUCT_PRO_MONTHLY: 'pdt_pro_m',
  DODO_PRODUCT_PRO_YEARLY: 'pdt_pro_y',
  DODO_PRODUCT_TEAM_MONTHLY: 'pdt_team_m',
  DODO_PRODUCT_TEAM_YEARLY: 'pdt_team_y',
  DODO_METER_SECRET_FETCH: 'secret_fetch_kilo',
};

const f = routeFixtures({ t: () => t, envelope: () => envelope, deferred: () => deferred });

beforeAll(async () => {
  t = await createTestDatabase();
  const rootKeys = JSON.stringify({ '1': toBase64Url(generateKeyBytes()) });
  envelope = new EnvelopeService(new InMemoryKeyProvider(parseRootKeyMaterial(rootKeys, 1)));
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  deferred = [];
  // Read per request, so a test can switch payments off after this has run.
  const env = () => ({
    XECRET_PUBLIC_URL: ORIGIN,
    XECRET_ENV: 'test',
    ...(payments ? BILLING_ENV : {}),
  });
  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    createLogger({
      sink: { write: () => {}, flush: () => Promise.resolve() },
      minimum: 'error',
      base,
    }),
  );
  context.workerContext.mockImplementation(async () => ({
    env: env(),
    ctx: { waitUntil: () => {} },
  }));
  context.createServiceContext.mockImplementation(
    async (
      request: Request,
      _w: unknown,
      requestId: string,
      log: RequestLog,
      startedAt: number,
    ) => ({
      env: env(),
      db: t.db,
      envelope,
      meta: {
        requestId,
        rayId: null,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: request.method,
        path: new URL(request.url).pathname,
        startedAt,
      },
      log: log.logger,
      bindLog: log.bind,
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    }),
  );
  actor.authenticate.mockImplementation(async () => {
    if (caller === null) throw errors.unauthenticated('no credential');
    return { principal: caller, source: caller.kind === 'user' ? 'cookie' : 'bearer' };
  });
  auditSink.write.mockImplementation(async () => {});
});

interface Body {
  error?: {
    code?: string;
    message?: string;
    plan?: { resource?: string; upgradeTo?: string | null };
  };
  entitlements?: EntitlementsPayload;
}

/**
 * One account with three Free organisations: the first two work and the third
 * is recorded waiting for a paid plan, as `provisionOrganization` writes it
 * (which `free-allowance.test.ts` in the database package pins).
 */
async function threeFree(): Promise<{ open: Org; waiting: Org }> {
  const open = await f.seedOrg('free');
  await another(open, false);
  const waiting = await another(open, true);
  return { open, waiting };
}

/** Another organisation the same account created. */
async function another(first: Org, awaiting: boolean): Promise<Org> {
  const orgId = crypto.randomUUID();
  const slug = `org-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, awaiting_paid_plan_since)
     values ($1, 'Acme', $2, $3, $4)`,
    [orgId, slug, first.owner.id, awaiting ? new Date() : null],
  );
  await f.addMember(orgId, first.owner.id, 'owner');
  return { orgId, slug, owner: first.owner, orgKeyId: null };
}

/** The `org_members` row id of `user` in `org`. */
async function memberIdOf(org: Org, userId: string): Promise<string> {
  const rows = (await t.pg.query(`select id from org_members where org_id = $1 and user_id = $2`, [
    org.orgId,
    userId,
  ])) as { rows: { id: string }[] };
  return rows.rows[0]?.id ?? '';
}

/** Not refused by the closed control plane, whatever else the route said. */
function expectNotAwaiting(answer: { body: Body }): void {
  expect(answer.body.error?.plan?.resource).not.toBe('awaitingPaidPlan');
}

const path = (org: Org, rest = '') => `/api/orgs/${org.slug}${rest}`;

function expectAwaiting(answer: { status: number; body: Body }): void {
  expect(answer.status).toBe(403);
  expect(answer.body.error?.code).toBe('plan_limit');
  expect(answer.body.error?.message).toBe(AWAITING_PAID_PLAN_MESSAGE);
  expect(answer.body.error?.plan?.resource).toBe('awaitingPaidPlan');
  expect(answer.body.error?.plan?.upgradeTo).toBe('pro');
}

describe('an organisation awaiting a paid plan refuses every write', () => {
  it('refuses creating a project, before the body is even read', async () => {
    const { open, waiting } = await threeFree();
    caller = f.sessionOf(waiting.owner);

    // An empty body: the open organisation answers it as invalid input, the
    // waiting one never reaches the parse.
    const refused = await f.call<Body>(projectsRoute.POST, 'POST', path(waiting, '/projects'), {
      orgSlug: waiting.slug,
    });
    expectAwaiting(refused);

    const allowed = await f.call<Body>(projectsRoute.POST, 'POST', path(open, '/projects'), {
      orgSlug: open.slug,
    });
    expect(allowed.body.error?.code).not.toBe('plan_limit');
  });

  it.each([
    ['renaming it', orgRoute.PATCH, 'PATCH', '', { name: 'Renamed' }],
    ['inviting a member', membersRoute.POST, 'POST', '/members', { email: 'x@example.com' }],
    ['minting a service token', serviceTokensRoute.POST, 'POST', '/tokens/service', {}],
    ['adding a webhook', webhooksRoute.POST, 'POST', '/webhooks', {}],
  ] as const)('refuses %s', async (_label, handler, method, rest, body) => {
    const { waiting } = await threeFree();
    caller = f.sessionOf(waiting.owner);

    expectAwaiting(
      await f.call<Body>(handler, method, path(waiting, rest), { orgSlug: waiting.slug }, body),
    );
  });

  it('opens the moment it is bought a plan', async () => {
    const { waiting } = await threeFree();
    caller = f.sessionOf(waiting.owner);
    await f.setPlan(waiting.orgId, 'pro');

    const answer = await f.call<Body>(projectsRoute.POST, 'POST', path(waiting, '/projects'), {
      orgSlug: waiting.slug,
    });
    expect(answer.body.error?.code).not.toBe('plan_limit');
  });
});

describe('an organisation awaiting a paid plan keeps what stays open', () => {
  it('answers every read', async () => {
    const { waiting } = await threeFree();
    caller = f.sessionOf(waiting.owner);

    expect(
      (await f.call<Body>(orgRoute.GET, 'GET', path(waiting), { orgSlug: waiting.slug })).status,
    ).toBe(200);
    expect(
      (
        await f.call<Body>(projectsRoute.GET, 'GET', path(waiting, '/projects'), {
          orgSlug: waiting.slug,
        })
      ).status,
    ).toBe(200);
  });

  it('serves its secrets to a service token: the data plane never closes', async () => {
    const { waiting } = await threeFree();
    const project = await f.seedProject(waiting);
    const env = await f.seedEnv(waiting, project, 'development');
    await f.seedSecret(waiting, env, 'DATABASE_URL');
    caller = await f.seedServiceToken(waiting, project, env);

    const { path: pull, params } = f.envPath(waiting, 'development', '/pull?format=json&bundle=2');
    const answer = await f.call<Body>(pullRoute.GET, 'GET', pull, params);
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('DATABASE_URL');
  });

  it('revokes a token, because taking a credential away never waits on a payment', async () => {
    const { waiting } = await threeFree();
    const project = await f.seedProject(waiting);
    const env = await f.seedEnv(waiting, project, 'development');
    const token = await f.seedServiceToken(waiting, project, env);
    if (token.kind !== 'serviceToken') throw new Error('expected a service token');
    caller = f.sessionOf(waiting.owner);

    const answer = await f.call<Body>(
      tokenRoute.DELETE,
      'DELETE',
      path(waiting, `/tokens/service/${token.tokenId}`),
      { orgSlug: waiting.slug, kind: 'service', tokenId: token.tokenId },
    );
    expect(answer.status).toBe(204);
  });

  it('removes a member and withdraws an invitation: access is never held for a payment', async () => {
    const { waiting } = await threeFree();
    const colleague = await f.seedMember(waiting, 'developer');
    const memberId = await memberIdOf(waiting, colleague.id);
    caller = f.sessionOf(waiting.owner);

    const removed = await f.call<Body>(
      memberRoute.DELETE,
      'DELETE',
      path(waiting, `/members/${memberId}`),
      { orgSlug: waiting.slug, memberId },
    );
    expect(removed.status).toBe(204);

    // An invitation that does not exist answers as one, not as the closed plane.
    const invitationId = crypto.randomUUID();
    const withdrawn = await f.call<Body>(
      invitationRoute.DELETE,
      'DELETE',
      path(waiting, `/invitations/${invitationId}`),
      { orgSlug: waiting.slug, invitationId },
    );
    expect(withdrawn.body.error?.plan?.resource).not.toBe('awaitingPaidPlan');
  });

  it('lets the billing routes through, because paying is the way out', async () => {
    const { waiting } = await threeFree();
    caller = f.sessionOf(waiting.owner);

    const answer = await f.call<Body>(
      promoCodeRoute.POST,
      'POST',
      path(waiting, '/billing/promo-code'),
      { orgSlug: waiting.slug },
      { code: 'NOT-A-REAL-CODE' },
    );
    // Whatever the code says of itself, it is not the closed control plane.
    expect(answer.body.error?.plan?.resource).not.toBe('awaitingPaidPlan');
  });

  it('deletes it, the other way out', async () => {
    const { waiting } = await threeFree();
    caller = f.sessionOf(waiting.owner);

    const answer = await f.call<Body>(
      orgRoute.DELETE,
      'DELETE',
      path(waiting),
      { orgSlug: waiting.slug },
      { confirm: waiting.slug },
    );
    expect(answer.status).toBe(204);
  });
});

describe('taking access away is never refused', () => {
  it('suspends a member and lowers a role, but raises none and reinstates nobody', async () => {
    const { waiting } = await threeFree();
    const admin = await f.seedMember(waiting, 'admin');
    const memberId = await memberIdOf(waiting, admin.id);
    caller = f.sessionOf(waiting.owner);
    const patch = (body: unknown) =>
      f.call<Body>(
        memberRoute.PATCH,
        'PATCH',
        path(waiting, `/members/${memberId}`),
        { orgSlug: waiting.slug, memberId },
        body,
      );

    const lowered = await patch({ role: 'developer' });
    expect(lowered.status).toBe(200);
    const suspended = await patch({ status: 'suspended' });
    expect(suspended.status).toBe(200);

    expectAwaiting(await patch({ status: 'active' }));
    expectAwaiting(await patch({ role: 'admin' }));
  });

  it('removes a grant, but writes none', async () => {
    const { waiting } = await threeFree();
    await f.seedProject(waiting);
    const developer = await f.seedMember(waiting, 'developer');
    const memberId = await memberIdOf(waiting, developer.id);
    caller = f.sessionOf(waiting.owner);
    const params = { orgSlug: waiting.slug, memberId };
    const at = path(waiting, `/members/${memberId}/grants`);

    expectNotAwaiting(
      await f.call<Body>(grantsRoute.DELETE, 'DELETE', at, params, { projectSlug: 'api' }),
    );
    expectAwaiting(
      await f.call<Body>(grantsRoute.PUT, 'PUT', at, params, {
        projectSlug: 'api',
        accessLevel: 'read',
      }),
    );
  });

  it('deletes a project, a role and a key grant: every DELETE stays open', async () => {
    const { waiting } = await threeFree();
    await f.seedProject(waiting);
    caller = f.sessionOf(waiting.owner);

    const project = await f.call<Body>(
      projectRoute.DELETE,
      'DELETE',
      path(waiting, '/projects/api'),
      { orgSlug: waiting.slug, projectSlug: 'api' },
    );
    expect(project.status).toBe(204);

    const roleId = crypto.randomUUID();
    expectNotAwaiting(
      await f.call<Body>(roleRoute.DELETE, 'DELETE', path(waiting, `/roles/${roleId}`), {
        orgSlug: waiting.slug,
        roleId,
      }),
    );

    const grantId = crypto.randomUUID();
    const { path: keyGrant, params } = f.envPath(waiting, 'development', `/keys/grants/${grantId}`);
    expectNotAwaiting(
      await f.call<Body>(keyGrantRoute.DELETE, 'DELETE', keyGrant, { ...params, grantId }),
    );
  });

  it('rotates an environment’s key, which is how one is secured after a leaver', async () => {
    const { waiting } = await threeFree();
    const project = await f.seedProject(waiting);
    await f.seedEnv(waiting, project, 'development');
    caller = f.sessionOf(waiting.owner);

    const { path: rotate, params } = f.envPath(waiting, 'development', '/keys/rotate');
    expectNotAwaiting(await f.call<Body>(rotateRoute.POST, 'POST', rotate, params, {}));
  });

  it('switches a webhook off, but edits none', async () => {
    const { waiting } = await threeFree();
    const webhookId = crypto.randomUUID();
    await createWebhook(t.db, {
      id: webhookId,
      orgId: waiting.orgId,
      url: 'https://hooks.example.com/xecret',
      description: null,
      eventTypes: ['secret.created'],
      secret: { ciphertext: new Uint8Array(48), iv: new Uint8Array(12), keyVersion: 1 },
      createdBy: waiting.owner.id,
    });
    caller = f.sessionOf(waiting.owner);
    const patch = (body: unknown) =>
      f.call<Body>(
        webhookRoute.PATCH,
        'PATCH',
        path(waiting, `/webhooks/${webhookId}`),
        { orgSlug: waiting.slug, webhookId },
        body,
      );

    expect((await patch({ enabled: false })).status).toBe(200);
    expectAwaiting(await patch({ description: 'Deploys' }));
    expectAwaiting(await patch({ enabled: true }));
  });
});

describe('the data plane of an end-to-end encrypted organisation', () => {
  it('still shares an environment’s key with a member allowed to read it', async () => {
    const { waiting } = await threeFree();
    const project = await f.seedProject(waiting);
    await f.seedEnv(waiting, project, 'development');
    caller = f.sessionOf(waiting.owner);

    // An empty body is refused as invalid input, not as the closed plane: the
    // route is reached, and decides on what it is sent.
    const { path: share, params } = f.envPath(waiting, 'development', '/keys/grants');
    const answer = await f.call<Body>(keyGrantsRoute.POST, 'POST', share, params, {});
    expectNotAwaiting(answer);
    expect(answer.status).not.toBe(403);
  });
});

describe('a deployment that takes no payments', () => {
  it('reads an organisation recorded as waiting as open, since nobody could buy the way out', async () => {
    payments = false;
    try {
      const { waiting } = await threeFree();
      caller = f.sessionOf(waiting.owner);

      const answer = await f.call<Body>(projectsRoute.POST, 'POST', path(waiting, '/projects'), {
        orgSlug: waiting.slug,
      });
      expect(answer.body.error?.code).not.toBe('plan_limit');

      const read = await f.call<Body>(
        entitlementsRoute.GET,
        'GET',
        path(waiting, '/entitlements'),
        { orgSlug: waiting.slug },
      );
      expect(read.body.entitlements?.awaitingPaidPlan).toBe(false);
      expect(read.body.entitlements?.controlPlaneActive).toBe(true);
      expect(read.body.entitlements?.upgrades).toBe(false);
    } finally {
      payments = true;
    }
  });
});

describe('GET /api/orgs/{orgSlug}/entitlements', () => {
  function read(org: Org) {
    return f.call<Body>(entitlementsRoute.GET, 'GET', path(org, '/entitlements'), {
      orgSlug: org.slug,
    });
  }

  it('answers any member, with the plan, its limits and what is used', async () => {
    const org = await f.seedOrg('free');
    await f.seedProject(org);
    const viewer = await f.seedMember(org, 'viewer');
    caller = f.sessionOf(viewer);

    const answer = await read(org);
    expect(answer.status).toBe(200);
    const entitlements = answer.body.entitlements;
    expect(entitlements?.plan).toBe('free');
    expect(entitlements?.controlPlaneActive).toBe(true);
    expect(entitlements?.awaitingPaidPlan).toBe(false);
    expect(entitlements?.limits.projects).toBe(5);
    // The ceiling invitations are refused at: the seat column, Free's three.
    expect(entitlements?.limits.seats).toBe(3);
    expect(entitlements?.features.secretReferencing).toBe(false);
    expect(entitlements?.usage).toEqual({ projects: 1, serviceTokens: 0, webhooks: 0, seats: 2 });
    // The viewer's own allowance: they created nothing, so none is spent.
    expect(entitlements?.account).toEqual({ freeOrganizations: 0, awaitingOrganizations: 0 });
    expect(entitlements?.upgrades).toBe(true);
  });

  it('carries no name, slug, address or secret', async () => {
    const org = await f.seedOrg('free');
    caller = f.sessionOf(org.owner);

    const answer = await read(org);
    expect(answer.status).toBe(200);
    expect(answer.text).not.toContain(org.slug);
    expect(answer.text).not.toContain(org.owner.email);
    expect(answer.text).not.toContain(org.orgId);
    expect(answer.text).not.toContain('Acme');
  });

  it('says when the organisation is waiting for a plan, and spends the asker’s allowance', async () => {
    const { waiting } = await threeFree();
    caller = f.sessionOf(waiting.owner);

    const entitlements = (await read(waiting)).body.entitlements;
    expect(entitlements?.awaitingPaidPlan).toBe(true);
    expect(entitlements?.controlPlaneActive).toBe(false);
    expect(entitlements?.account).toEqual({ freeOrganizations: 2, awaitingOrganizations: 1 });
  });

  it('refuses a service token, which has no account to describe', async () => {
    const org = await f.seedOrg('pro');
    const project = await f.seedProject(org);
    const env = await f.seedEnv(org, project, 'development');
    caller = await f.seedServiceToken(org, project, env);

    expect((await read(org)).status).toBe(403);
  });

  it('answers a stranger as it answers a slug that does not exist', async () => {
    const org = await f.seedOrg('free');
    caller = f.sessionOf(await f.seedUser());

    expect((await read(org)).status).toBe(404);
  });
});
