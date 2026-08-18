import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { cliAuthCodeExpiryFrom, generateToken, hashToken } from '@xecret/core/auth';
import type { Bytes } from '@xecret/core/crypto';
import { uuidv7 } from '@xecret/core/ids';
import { cliAuthCodes } from '../schema/tokens';
import type { Executor } from './shared';

/**
 * Pending CLI authorizations — the `xecret login` handshake's server half.
 *
 * The lifecycle is deliberately identical to a PIN reset link (`pins.ts`): a
 * short-lived, hashed-at-rest, single-use value whose consumption is one atomic
 * `UPDATE … RETURNING`. The similarity is the point — this repository has one
 * way of treating a one-time code, not two.
 *
 * What this module does **not** do is mint the CLI token. Consuming a code
 * proves possession; whether that possession earns a credential is decided by
 * the route, which must still verify the PKCE binding. Keeping the two steps
 * apart means a bug in one cannot silently stand in for the other.
 */

export interface CreateCliAuthCodeParams {
  userId: string;
  orgId: string;
  /** Shown on the consent screen; becomes the token's name at exchange. */
  deviceName: string;
  /** base64url SHA-256 of the CLI's PKCE verifier. Validated by the route. */
  codeChallenge: string;
  /** The approving browser's address, for the incident-review trail. */
  ipAddress: string | null;
  environment?: 'live' | 'test' | undefined;
}

export interface IssuedCliAuthCode {
  id: string;
  /** The raw code. Sent to the loopback listener once; only its hash is stored. */
  code: string;
  expiresAt: Date;
}

/** What the exchange route needs from a consumed code. */
export interface CliAuthCodeGrant {
  id: string;
  userId: string;
  orgId: string;
  deviceName: string;
  codeChallenge: string;
}

/**
 * Issues an authorization code, invalidating any the user already had.
 *
 * Superseding mirrors `createPinReset`, and for the same reason: two live codes
 * means an earlier approval — for a device the user may have abandoned or never
 * controlled — stays exchangeable. One approval, one code.
 */
export async function createCliAuthCode(
  exec: Executor,
  params: CreateCliAuthCodeParams,
): Promise<IssuedCliAuthCode> {
  const now = new Date();
  const generated = await generateToken('cliAuthCode', params.environment ?? 'live');
  const expiresAt = cliAuthCodeExpiryFrom(now);
  const id = uuidv7();

  await exec.transaction(async (tx) => {
    await tx
      .update(cliAuthCodes)
      .set({ consumedAt: now })
      .where(and(eq(cliAuthCodes.userId, params.userId), isNull(cliAuthCodes.consumedAt)));

    await tx.insert(cliAuthCodes).values({
      id,
      userId: params.userId,
      orgId: params.orgId,
      deviceName: params.deviceName,
      tokenHash: generated.hash,
      codeChallenge: params.codeChallenge,
      requestedIp: params.ipAddress,
      createdAt: now,
      expiresAt,
    });
  });

  return { id, code: generated.token, expiresAt };
}

/**
 * Consumes an authorization code, returning what it authorises.
 *
 * One statement, and the `WHERE` clause is the security boundary: it matches
 * only a row that is unconsumed and unexpired, and marks it consumed in the
 * same breath. Two exchanges racing on one code get exactly one winner.
 *
 * Returns `null` for unknown, expired and already-used alike — the route gives
 * one answer for all three, because distinguishing them tells a stranger
 * holding a stolen or guessed code which part was right.
 */
export async function consumeCliAuthCode(
  exec: Executor,
  codeHash: Bytes,
  now = new Date(),
): Promise<CliAuthCodeGrant | null> {
  const [row] = await exec
    .update(cliAuthCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(cliAuthCodes.tokenHash, codeHash),
        isNull(cliAuthCodes.consumedAt),
        sql`${cliAuthCodes.expiresAt} > ${now}`,
      ),
    )
    .returning({
      id: cliAuthCodes.id,
      userId: cliAuthCodes.userId,
      orgId: cliAuthCodes.orgId,
      deviceName: cliAuthCodes.deviceName,
      codeChallenge: cliAuthCodes.codeChallenge,
    });

  return row ?? null;
}

/** Convenience for the route: hash the presented code, then consume. */
export async function consumeCliAuthCodeByValue(
  exec: Executor,
  code: string,
  now = new Date(),
): Promise<CliAuthCodeGrant | null> {
  return consumeCliAuthCode(exec, await hashToken(code), now);
}

/**
 * Deletes codes that expired before `before`. For a scheduled worker, on the
 * same reasoning as `deleteExpiredPinResets`: consumed rows keep answering
 * "was this approval exchanged?" for the short window they survive.
 */
export async function deleteExpiredCliAuthCodes(exec: Executor, before: Date): Promise<number> {
  const result = await exec.delete(cliAuthCodes).where(lt(cliAuthCodes.expiresAt, before));
  return result.count;
}
