import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashToken } from '@xecret/core/auth';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import { consumeCliAuthCodeByValue, createCliAuthCode } from './cli-auth';
import {
  createSession,
  deleteSpentSignInConfirmations,
  findSessionByTokenHash,
  spendSignInConfirmation,
} from './sessions';
import { createCliToken, findCliTokenByHash } from './tokens';

/**
 * What migration 0022 records about how a credential came to exist — the
 * sign-in method and the single-sign-on organisation, on a session, on a CLI
 * approval and on the token it becomes — and the ledger that makes a sign-in
 * confirmation single-use.
 */

let t: TestDatabase;
let userId: string;
let orgId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  userId = randomUUID();
  orgId = randomUUID();
  await t.pg.query(`insert into users (id, firebase_uid, email) values ($1, $2, $3)`, [
    userId,
    `fb-${userId}`,
    `facts-${userId.slice(0, 8)}@example.com`,
  ]);
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, userId],
  );
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

const token = () => `xst_live_${randomUUID().replaceAll('-', '')}`;

/** The SQLSTATE a refused write carried, from the driver error Drizzle wraps. */
function sqlState(error: unknown): unknown {
  return (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
}

describe('a session’s sign-in facts', () => {
  it('are stored and come back on the hot-path lookup', async () => {
    const value = token();
    await createSession(t.db, {
      userId,
      token: value,
      ipAddress: null,
      userAgent: null,
      signInMethod: 'sso',
      ssoWorkosOrgId: 'org_01FACTS',
    });

    const session = await findSessionByTokenHash(t.db, await hashToken(value));

    expect(session).toMatchObject({ signInMethod: 'sso', ssoWorkosOrgId: 'org_01FACTS' });
  });

  it('default to "not known" — not single sign-on — when the caller says nothing', async () => {
    const value = token();
    await createSession(t.db, { userId, token: value, ipAddress: null, userAgent: null });

    const session = await findSessionByTokenHash(t.db, await hashToken(value));

    expect(session).toMatchObject({ signInMethod: null, ssoWorkosOrgId: null });
  });

  it('never name an SSO organisation beside a method that was not SSO, nor a method outside the set', async () => {
    const refused = await createSession(t.db, {
      userId,
      token: token(),
      ipAddress: null,
      userAgent: null,
      signInMethod: 'password',
      ssoWorkosOrgId: 'org_01FACTS',
    }).catch((error: unknown) => error);
    expect(sqlState(refused)).toBe('23514');
    await expect(
      t.pg.query(`update sessions set sign_in_method = 'magic' where user_id = $1`, [userId]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('a CLI token’s sign-in facts', () => {
  it('travel from the approval to the token', async () => {
    const issued = await createCliAuthCode(t.db, {
      userId,
      orgId,
      deviceName: 'laptop',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      ipAddress: null,
      signInMethod: 'sso',
      ssoWorkosOrgId: 'org_01FACTS',
    });

    const grant = await consumeCliAuthCodeByValue(t.db, issued.code);
    expect(grant).toMatchObject({ signInMethod: 'sso', ssoWorkosOrgId: 'org_01FACTS' });

    const minted = await createCliToken(t.db, {
      orgId,
      userId,
      name: 'laptop',
      signInMethod: grant!.signInMethod,
      ssoWorkosOrgId: grant!.ssoWorkosOrgId,
    });
    const principal = await findCliTokenByHash(t.db, await hashToken(minted.token));
    expect(principal).toMatchObject({ signInMethod: 'sso', ssoWorkosOrgId: 'org_01FACTS' });
  });

  it('are "not known" on a token minted without them', async () => {
    const minted = await createCliToken(t.db, { orgId, userId, name: 'old laptop' });
    const principal = await findCliTokenByHash(t.db, await hashToken(minted.token));
    expect(principal).toMatchObject({ signInMethod: null, ssoWorkosOrgId: null });
  });
});

describe('spendSignInConfirmation', () => {
  it('spends a nonce exactly once, however many requests present it', async () => {
    const nonceHash = await hashToken(randomUUID());
    const expiresAt = new Date(Date.now() + 5 * 60_000);

    const results = await Promise.all([
      spendSignInConfirmation(t.db, { nonceHash, userId, expiresAt }),
      spendSignInConfirmation(t.db, { nonceHash, userId, expiresAt }),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await spendSignInConfirmation(t.db, { nonceHash, userId, expiresAt })).toBe(false);
  });

  it('keeps only digests, and lets a scheduled job forget the expired ones', async () => {
    const refused = await spendSignInConfirmation(t.db, {
      nonceHash: new Uint8Array(8),
      userId,
      expiresAt: new Date(),
    }).catch((error: unknown) => error);
    expect(sqlState(refused)).toBe('23514');

    const old = await hashToken(randomUUID());
    await spendSignInConfirmation(t.db, {
      nonceHash: old,
      userId,
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await deleteSpentSignInConfirmations(t.db, new Date())).toBeGreaterThanOrEqual(1);
    expect(
      await spendSignInConfirmation(t.db, { nonceHash: old, userId, expiresAt: new Date() }),
    ).toBe(true);
  });
});
