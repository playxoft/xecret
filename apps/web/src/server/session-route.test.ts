import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { VerifiedIdentity } from '@xecret/core/auth';
import { createTestDatabase } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { createLogger } from './logging';
import type { RequestLog } from './logging';

/**
 * `POST /api/auth/session` — the live Firebase sign-in — invoked for real,
 * against a real database.
 *
 * ── Why this file exists ──
 * While the WorkOS linking pass was being built, this route was briefly wired
 * to it. The linker treats `subject` as a WorkOS id and adopts accounts by
 * email, so every Firebase login started writing its Firebase uid into
 * `workos_user_id`, new signups lost their `firebase_uid` (and with it the
 * vault-reset re-authentication, which looks accounts up by it), a changed
 * Firebase address split into a second account, a deleted account became a 500
 * instead of a 403, and a *different* Firebase account presenting the same
 * verified address was signed into an existing one. No test noticed, because
 * nothing ran this route.
 *
 * So these tests pin what the route writes, by reading the row back: a
 * Firebase login keys on and writes `firebase_uid`, never `workos_user_id`, and
 * a deleted account is a 403.
 *
 * ── What is real, and what is stubbed ──
 * The route, `publicRoute`, and the user upsert run for real, on PGlite with
 * every migration applied. Stubbed: the Firebase signature check (the
 * verifier's own tests cover it), rate limiting, organisation listing and
 * provisioning, session creation and the audit sink — the parts of a sign-in
 * that are not about *which identity column is written*, and that would
 * otherwise need key material and a Worker to run.
 */

const context = vi.hoisted(() => ({
  workerContext: vi.fn(),
  createServiceContext: vi.fn(),
}));

const firebase = vi.hoisted(() => ({ verify: vi.fn() }));
const rateLimit = vi.hoisted(() => ({ enforce: vi.fn() }));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));

const repositories = vi.hoisted(() => ({
  listOrganizationsForUser: vi.fn(),
  provisionOrganization: vi.fn(),
  createSession: vi.fn(),
  // Replaced so that a route that reached for it would be caught: the linker
  // must never see a Firebase identity.
  upsertUserFromWorkosIdentity: vi.fn(),
}));

vi.mock('./context', () => context);
vi.mock('./firebase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./firebase')>()),
  firebaseIdentityProvider: () => ({ verify: firebase.verify }),
}));
vi.mock('./rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rate-limit')>()),
  ...rateLimit,
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
vi.mock('@xecret/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xecret/db/repositories')>()),
  ...repositories,
}));

const { POST: signIn } = await import('@/app/api/auth/session/route');

const ORIGIN = 'https://xecret.playxoft.com';
const AUTH_TIME = Math.floor(Date.parse('2026-09-23T10:00:00.000Z') / 1000);

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

function silentLog(base: Record<string, unknown> = {}): RequestLog {
  return createLogger({
    sink: { write: () => {}, flush: () => Promise.resolve() },
    minimum: 'error',
    base,
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    silentLog(base),
  );
  context.workerContext.mockResolvedValue({ env: {}, ctx: { waitUntil: () => {} } });
  context.createServiceContext.mockImplementation(
    async (
      _request: Request,
      _worker: unknown,
      requestId: string,
      log: RequestLog,
      startedAt: number,
    ) => ({
      env: { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'production' },
      db: t.db,
      envelope: {},
      meta: {
        requestId,
        rayId: null,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: 'POST',
        path: '/api/auth/session',
        startedAt,
      },
      log: log.logger,
      bindLog: log.bind,
      waitUntil: () => {},
      settled: () => Promise.resolve([]),
      dispose: () => {},
    }),
  );

  rateLimit.enforce.mockResolvedValue({ allowed: true, enforced: true });
  auditSink.write.mockResolvedValue(undefined);
  repositories.listOrganizationsForUser.mockResolvedValue([
    {
      organization: { id: randomUUID(), name: 'Acme', slug: 'acme' },
      role: 'owner',
    },
  ]);
  repositories.createSession.mockImplementation(async ({ userId }: { userId: string }) => ({
    id: randomUUID(),
    userId,
  }));
});

function firebaseIdentity(over: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  return {
    // A Firebase uid: 28 bare alphanumerics, no `user_` prefix.
    subject: randomUUID().replaceAll('-', '').slice(0, 28),
    email: `person-${randomUUID().slice(0, 8)}@example.com`,
    emailVerified: true,
    displayName: 'Firebase Person',
    authTime: AUTH_TIME,
    ...over,
  };
}

async function post(identity: VerifiedIdentity) {
  firebase.verify.mockResolvedValue(identity);
  const response = await signIn(
    new Request(`${ORIGIN}/api/auth/session`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'a-firebase-id-token' }),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      user?: { id: string };
      error?: { code: string; message: string };
    },
  };
}

interface Row {
  id: string;
  firebase_uid: string | null;
  workos_user_id: string | null;
  email: string;
  deleted_at: Date | null;
}

async function rowsFor(column: 'id' | 'email' | 'firebase_uid', value: string): Promise<Row[]> {
  const result = await t.pg.query<Row>(
    `select id, firebase_uid, workos_user_id, email::text as email, deleted_at
       from users where ${column} = $1`,
    [value],
  );
  return result.rows;
}

async function seedFirebaseUser(over: { deleted?: boolean } = {}): Promise<Row> {
  const id = randomUUID();
  const uid = randomUUID().replaceAll('-', '').slice(0, 28);
  await t.pg.query(
    `insert into users (id, firebase_uid, email, email_verified, deleted_at)
     values ($1, $2, $3, true, $4)`,
    [id, uid, `seeded-${id.slice(0, 8)}@example.com`, over.deleted ? new Date() : null],
  );
  return (await rowsFor('id', id))[0]!;
}

describe('a Firebase sign-in writes firebase_uid and never workos_user_id', () => {
  it('records a new signup under its Firebase uid', async () => {
    const identity = firebaseIdentity();

    const { status, body } = await post(identity);

    expect(status).toBe(200);
    const [row] = await rowsFor('firebase_uid', identity.subject);
    expect(row?.id).toBe(body.user?.id);
    expect(row?.workos_user_id).toBeNull();
    expect(repositories.upsertUserFromWorkosIdentity).not.toHaveBeenCalled();
  });

  it('signs an existing Firebase account into itself and leaves it unlinked', async () => {
    const seeded = await seedFirebaseUser();

    const { status, body } = await post(
      firebaseIdentity({ subject: seeded.firebase_uid!, email: seeded.email }),
    );

    expect(status).toBe(200);
    expect(body.user?.id).toBe(seeded.id);
    expect((await rowsFor('id', seeded.id))[0]?.workos_user_id).toBeNull();
  });

  it('follows an address changed at Firebase on the same account, not a new one', async () => {
    const seeded = await seedFirebaseUser();
    const renamed = `renamed-${randomUUID().slice(0, 8)}@example.com`;

    const { status, body } = await post(
      firebaseIdentity({ subject: seeded.firebase_uid!, email: renamed }),
    );

    expect(status).toBe(200);
    expect(body.user?.id).toBe(seeded.id);
    expect(await rowsFor('firebase_uid', seeded.firebase_uid!)).toHaveLength(1);
  });

  it('never signs a different Firebase account into an existing one by email', async () => {
    const seeded = await seedFirebaseUser();

    const { status } = await post(firebaseIdentity({ email: seeded.email }));

    expect(status).not.toBe(200);
    expect(repositories.createSession).not.toHaveBeenCalled();
    expect((await rowsFor('id', seeded.id))[0]).toEqual(seeded);
  });
});

describe('a deleted account', () => {
  it('is refused with 403, and no session is issued', async () => {
    const seeded = await seedFirebaseUser({ deleted: true });

    const { status, body } = await post(
      firebaseIdentity({ subject: seeded.firebase_uid!, email: seeded.email }),
    );

    expect(status).toBe(403);
    expect(body.error?.message).toMatch(/deleted/);
    expect(repositories.createSession).not.toHaveBeenCalled();
    expect((await rowsFor('id', seeded.id))[0]).toEqual(seeded);
  });
});

describe('an unverified address', () => {
  it('is refused with 403 before any account is written', async () => {
    const identity = firebaseIdentity({ emailVerified: false });

    const { status } = await post(identity);

    expect(status).toBe(403);
    expect(await rowsFor('email', identity.email)).toHaveLength(0);
  });
});
