import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashToken } from '@xecret/core/auth';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  consumeReauthProof,
  findFreshSignIn,
  issueReauthProof,
  recordFreshSignIn,
  recordReauthCodeFailure,
} from './reauth';

/**
 * The vault reset's re-authentication record (migration 0019), against a real
 * database — every guarantee here is a predicate meeting a row.
 *
 * The web layer's suite (`apps/web/src/server/reauth.test.ts`) drives these
 * through the routes. This one pins what the routes cannot reach on their own:
 * each binding in each predicate separately, even where another binding would
 * catch the same request today, and the table's own constraints.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

const MAX_FAILURES = 5;
const minutes = (n: number) => n * 60_000;

async function userWithSession(): Promise<{ userId: string; sessionId: string }> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  await t.pg.query(`insert into users (id, workos_user_id, email) values ($1, $2, $3)`, [
    userId,
    `user_01${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    `r-${userId.slice(0, 8)}@example.com`,
  ]);
  await t.pg.query(
    `insert into sessions (id, user_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '1 day')`,
    [sessionId, userId, await hashToken(randomUUID())],
  );
  return { userId, sessionId };
}

async function attemptWithProof(now = new Date()) {
  const who = await userWithSession();
  await recordFreshSignIn(t.db, { ...who, at: now });
  const proofHash = await hashToken(`xrp_live_${randomUUID()}`);
  const issued = await issueReauthProof(t.db, {
    ...who,
    signedInSince: new Date(now.getTime() - minutes(10)),
    maxCodeFailures: MAX_FAILURES,
    proofHash,
    expiresAt: new Date(now.getTime() + minutes(5)),
  });
  expect(issued).toBe(true);
  return { ...who, proofHash };
}

describe('spending a proof', () => {
  it('names the user as well as the session — the session alone is not trusted to imply it', async () => {
    const { sessionId, proofHash } = await attemptWithProof();

    expect(
      await consumeReauthProof(t.db, {
        userId: randomUUID(),
        sessionId,
        proofHash,
        now: new Date(),
      }),
    ).toBe(false);
  });

  it('names the session as well as the user', async () => {
    const { userId, proofHash } = await attemptWithProof();

    expect(
      await consumeReauthProof(t.db, {
        userId,
        sessionId: randomUUID(),
        proofHash,
        now: new Date(),
      }),
    ).toBe(false);
  });

  it('spends once, and not after expiry', async () => {
    const { userId, sessionId, proofHash } = await attemptWithProof();
    const later = new Date(Date.now() + minutes(6));

    expect(await consumeReauthProof(t.db, { userId, sessionId, proofHash, now: later })).toBe(
      false,
    );
    expect(await consumeReauthProof(t.db, { userId, sessionId, proofHash, now: new Date() })).toBe(
      true,
    );
    expect(await consumeReauthProof(t.db, { userId, sessionId, proofHash, now: new Date() })).toBe(
      false,
    );
  });
});

describe('finding the fresh sign-in', () => {
  it('names the user as well as the session', async () => {
    const who = await userWithSession();
    await recordFreshSignIn(t.db, { ...who, at: new Date() });
    const params = {
      signedInSince: new Date(Date.now() - minutes(10)),
      maxCodeFailures: MAX_FAILURES,
    };

    expect(await findFreshSignIn(t.db, { ...who, ...params })).not.toBeNull();
    expect(await findFreshSignIn(t.db, { ...who, userId: randomUUID(), ...params })).toBeNull();
    expect(await findFreshSignIn(t.db, { ...who, sessionId: randomUUID(), ...params })).toBeNull();
  });
});

describe('minting a proof', () => {
  it('names the user and the session it is minted for', async () => {
    const who = await userWithSession();
    await recordFreshSignIn(t.db, { ...who, at: new Date() });
    const mint = (over: { userId?: string; sessionId?: string }) =>
      issueReauthProof(t.db, {
        ...who,
        ...over,
        signedInSince: new Date(Date.now() - minutes(10)),
        maxCodeFailures: MAX_FAILURES,
        proofHash: new Uint8Array(32).fill(Math.floor(Math.random() * 255)),
        expiresAt: new Date(Date.now() + minutes(5)),
      });

    expect(await mint({ userId: randomUUID() })).toBe(false);
    expect(await mint({ sessionId: randomUUID() })).toBe(false);
    expect(await mint({})).toBe(true);
  });

  it('is refused once the sign-in has aged out', async () => {
    const who = await userWithSession();
    await recordFreshSignIn(t.db, { ...who, at: new Date(Date.now() - minutes(11)) });

    const issued = await issueReauthProof(t.db, {
      ...who,
      signedInSince: new Date(Date.now() - minutes(10)),
      maxCodeFailures: MAX_FAILURES,
      proofHash: await hashToken('xrp_live_x'),
      expiresAt: new Date(Date.now() + minutes(5)),
    });

    expect(issued).toBe(false);
  });

  it('is refused once the wrong-code allowance is spent, and so is the lookup', async () => {
    const who = await userWithSession();
    await recordFreshSignIn(t.db, { ...who, at: new Date() });
    const attempt = await findFreshSignIn(t.db, {
      ...who,
      signedInSince: new Date(Date.now() - minutes(10)),
      maxCodeFailures: MAX_FAILURES,
    });
    for (let i = 0; i < MAX_FAILURES; i += 1) await recordReauthCodeFailure(t.db, attempt!.id);

    const params = {
      ...who,
      signedInSince: new Date(Date.now() - minutes(10)),
      maxCodeFailures: MAX_FAILURES,
    };
    expect(await findFreshSignIn(t.db, params)).toBeNull();
    expect(
      await issueReauthProof(t.db, {
        ...params,
        proofHash: await hashToken('xrp_live_y'),
        expiresAt: new Date(Date.now() + minutes(5)),
      }),
    ).toBe(false);
  });

  it('is refused for an attempt already spent', async () => {
    const { userId, sessionId, proofHash } = await attemptWithProof();
    await consumeReauthProof(t.db, { userId, sessionId, proofHash, now: new Date() });

    const params = {
      userId,
      sessionId,
      signedInSince: new Date(Date.now() - minutes(10)),
      maxCodeFailures: MAX_FAILURES,
    };
    expect(await findFreshSignIn(t.db, params)).toBeNull();
    expect(
      await issueReauthProof(t.db, {
        ...params,
        proofHash: await hashToken('xrp_live_z'),
        expiresAt: new Date(Date.now() + minutes(5)),
      }),
    ).toBe(false);
  });
});

describe('the table', () => {
  it('holds a SHA-256 and nothing else in proof_hash', async () => {
    const who = await userWithSession();
    await expect(
      t.pg.query(
        `insert into reauthentications (id, user_id, session_id, signed_in_at, proof_hash, proof_expires_at)
         values ($1, $2, $3, now(), $4, now())`,
        [randomUUID(), who.userId, who.sessionId, new TextEncoder().encode('xrp_live_raw_proof')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('never holds a proof without an expiry, nor a spent attempt without a proof', async () => {
    const a = await userWithSession();
    await expect(
      t.pg.query(
        `insert into reauthentications (id, user_id, session_id, signed_in_at, proof_hash)
         values ($1, $2, $3, now(), $4)`,
        [randomUUID(), a.userId, a.sessionId, await hashToken('p')],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const b = await userWithSession();
    await expect(
      t.pg.query(
        `insert into reauthentications (id, user_id, session_id, signed_in_at, used_at)
         values ($1, $2, $3, now(), now())`,
        [randomUUID(), b.userId, b.sessionId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows one attempt per session', async () => {
    const who = await userWithSession();
    await recordFreshSignIn(t.db, { ...who, at: new Date() });

    await expect(recordFreshSignIn(t.db, { ...who, at: new Date() })).rejects.toThrow();
  });

  it('ends the attempt with its session', async () => {
    const { sessionId } = await attemptWithProof();

    await t.pg.query(`delete from sessions where id = $1`, [sessionId]);

    const left = await t.pg.query(`select 1 from reauthentications where session_id = $1`, [
      sessionId,
    ]);
    expect(left.rows).toHaveLength(0);
  });
});
