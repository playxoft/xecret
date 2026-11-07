import {
  deriveKnownDeviceKey,
  deriveSignInThrottleKey,
  foldAddress,
  generateDeviceId,
  KNOWN_DEVICE_COOKIE_NAME,
  knownDeviceCookie,
  openKnownDevice,
  sealKnownDevice,
} from '@xecret/core/auth';
import { toBase64Url, utf8Encode } from '@xecret/core/crypto';
import {
  clearSignInFailures,
  findSignInFailures,
  refundSignInAttempt,
  spendSignInAttempt,
} from '@xecret/db/repositories';
import type { SignInThrottlePolicy } from '@xecret/db/repositories';
import type { Bindings } from './bindings';
import { MissingBindingError } from './bindings';
import type { ServiceContext } from './context';
import { parseCookies } from './http';
import { describeError } from './logging';
import { SignInRefusal } from './sign-in';

/**
 * The durable brake on guessing a password or an emailed code on the in-app
 * sign-in page: attempts counted in the database (`sign_in_failures`,
 * migration 0034), in two kinds of pool, **before** WorkOS is asked.
 *
 * ── Why, beside `RL_LOGIN` ──
 * The rate-limit binding is per data centre, keyed on what the request
 * carries, and fails open: somebody rotating addresses across colos meets a
 * fresh allowance at every hop. WorkOS's own per-address limit is WorkOS's to
 * change. This counter is global and ours.
 *
 * ── Two pools (OWASP's device cookie) ──
 *  - **A known device's pool.** Every successful sign-in hands its browser a
 *    sealed `__Host-xecret_known_device` cookie naming a random device id and
 *    the account's address (`@xecret/core/auth`, `known-device.ts`). A request
 *    that carries one for the address it is trying is counted against *that
 *    device* alone (`device:<id>`).
 *  - **The address's shared pool** (`address:<address>`), for every other
 *    request — a new browser, a cleared one, and every attacker.
 * Somebody guessing at an address without the owner's cookie can only exhaust
 * the shared pool; the owner's own browser keeps its own five free attempts
 * and its own backoff, and never notices.
 *
 * ── Counted first ──
 * One statement counts the attempt, refuses it if the pool's lockout is
 * running, and opens the next lockout from the new count
 * (`spendSignInAttempt`). Concurrent guesses queue on the row, so the free
 * budget is exact: at its end, exactly one of any burst is admitted, and it
 * locks the pool for the rest. An admitted attempt costs its failure up front
 * — a guess not yet answered is still a guess. Then:
 *  - **WorkOS accepts the credential** → the pool is cleared (the row deleted:
 *    every free attempt back). An attempt refused *after* that — an address
 *    conflict, an organisation's single-sign-on rule — was not a wrong guess,
 *    and the pool stays clear.
 *  - **WorkOS refuses it** (or answers in a way folded into a refusal, see
 *    `in-app-sign-in.ts`) → the up-front count stands.
 *  - **WorkOS never judges it** — a timeout, an outage, its rate limit, a step
 *    it asks for instead → the count is refunded. A lockout that attempt
 *    opened (only possible past the free ones) runs out on its own.
 * If the counter itself cannot be written, the attempt is refused (it fails
 * closed): a brake that could be bypassed by breaking it is no brake.
 *
 * ── The policy, and the budget, worked ──
 * {@link SIGN_IN_FREE_FAILURES} attempts free; each admitted attempt after
 * that locks the pool for {@link SIGN_IN_LOCKOUT_BASE_MS}, doubling, at most
 * {@link SIGN_IN_LOCKOUT_MAX_MS}; the count restarts after
 * {@link SIGN_IN_FAILURE_WINDOW_MS} quiet, or at a success. Per pool:
 *  - first hour **13** guesses (5 free, the 6th, five more over 15.5 minutes,
 *    two at 15-minute steps); every hour after **4**; a day about **100**;
 *  - inside one emailed code's ten minutes, **10** — about one in 100,000 per
 *    code issued;
 *  - the owner mistyping: five free, a 30-second pause on the sixth;
 *  - an attacker without the owner's cookie: the shared pool's numbers, from
 *    any number of IPs and colos — and the owner's browser is not in it.
 * It does nothing against credential stuffing — one leaked password tried once
 * per account across many accounts — which is WorkOS Radar's job (a follow-up,
 * and a precondition for general availability).
 *
 * ── What it still costs ──
 * A person on a **new** browser (no cookie yet) while somebody is attacking
 * their address waits out the shared pool's backoff — at most 15 minutes after
 * the attacker's latest admitted attempt, for as long as the attacker keeps
 * paying for one every 15 minutes. "Continue with Google" and single sign-on
 * are never counted. And a success clears the pool it was counted in, so
 * somebody watching the shared pool for an address could see it reopen when
 * its owner signs in from a new browser — a weak activity signal, accepted.
 *
 * ── Keys ──
 * A pool's row key is an HMAC of its name under a key derived from
 * `WORKOS_COOKIE_PASSWORD` (`deriveSignInThrottleKey`), never a plain hash: a
 * row, or the 72-bit prefix the log quotes, cannot be checked against a list of
 * candidate addresses without the deployment's secret.
 */

/** Attempts that cost nothing. */
export const SIGN_IN_FREE_FAILURES = 5;

/** The first lockout, doubling with each admitted attempt after it. */
export const SIGN_IN_LOCKOUT_BASE_MS = 30 * 1000;

/** The ceiling on that doubling. */
export const SIGN_IN_LOCKOUT_MAX_MS = 15 * 60 * 1000;

/** An attempt older than this no longer adds to the count: the next one starts it again. */
export const SIGN_IN_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The numbers the counting statement applies. */
export const SIGN_IN_THROTTLE_POLICY: SignInThrottlePolicy = {
  freeAttempts: SIGN_IN_FREE_FAILURES,
  baseMs: SIGN_IN_LOCKOUT_BASE_MS,
  maxMs: SIGN_IN_LOCKOUT_MAX_MS,
  windowMs: SIGN_IN_FAILURE_WINDOW_MS,
};

/**
 * How long the `attempts`-th admitted attempt locks its pool for, or `null` —
 * the schedule `spendSignInAttempt` applies in SQL, restated for the tests and
 * the budget arithmetic above.
 */
export function signInLockoutFor(attempts: number, now: Date): Date | null {
  if (attempts <= SIGN_IN_FREE_FAILURES) return null;
  const step = Math.min(attempts - SIGN_IN_FREE_FAILURES - 1, 30);
  const delay = Math.min(SIGN_IN_LOCKOUT_BASE_MS * 2 ** step, SIGN_IN_LOCKOUT_MAX_MS);
  return new Date(now.getTime() + delay);
}

/** One throttle pool: its row key, and which kind it is, for the log. */
export interface ThrottlePool {
  subject: Uint8Array<ArrayBuffer>;
  kind: 'device' | 'address';
}

let cachedThrottleKey: { secret: string; key: Promise<CryptoKey> } | undefined;
let cachedDeviceKey: { secret: string; key: Promise<CryptoKey> } | undefined;

async function keyFrom(env: Bindings, cache: 'throttle' | 'device'): Promise<CryptoKey> {
  const secret = env.WORKOS_COOKIE_PASSWORD;
  if (!secret) throw new MissingBindingError('WORKOS_COOKIE_PASSWORD');
  const current = cache === 'throttle' ? cachedThrottleKey : cachedDeviceKey;
  let entry = current;
  if (entry?.secret !== secret) {
    entry = {
      secret,
      key: cache === 'throttle' ? deriveSignInThrottleKey(secret) : deriveKnownDeviceKey(secret),
    };
    if (cache === 'throttle') cachedThrottleKey = entry;
    else cachedDeviceKey = entry;
  }
  try {
    return await entry.key;
  } catch {
    if (cache === 'throttle') cachedThrottleKey = undefined;
    else cachedDeviceKey = undefined;
    throw new MissingBindingError('WORKOS_COOKIE_PASSWORD (at least 32 characters)');
  }
}

/** Exists for tests. */
export function resetSignInThrottleKeysForTesting(): void {
  cachedThrottleKey = undefined;
  cachedDeviceKey = undefined;
}

async function poolSubject(env: Bindings, name: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await keyFrom(env, 'throttle');
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8Encode(name)));
}

/** The shared pool of an address. */
export function addressPool(env: Bindings, email: string): Promise<Uint8Array<ArrayBuffer>> {
  return poolSubject(env, `address:${foldAddress(email)}`);
}

/** The pool of one known device. */
export function devicePool(env: Bindings, deviceId: string): Promise<Uint8Array<ArrayBuffer>> {
  return poolSubject(env, `device:${deviceId}`);
}

/**
 * The pool a request trying `email` is counted against: its own device's, when
 * it carries a valid known-device cookie earned for that address; otherwise the
 * address's shared pool.
 */
export async function throttlePoolFor(
  services: ServiceContext,
  request: Request,
  email: string,
): Promise<ThrottlePool> {
  const cookie = parseCookies(request.headers.get('cookie')).get(KNOWN_DEVICE_COOKIE_NAME);
  if (cookie !== undefined) {
    const device = await openKnownDevice(await keyFrom(services.env, 'device'), cookie, new Date());
    if (device !== null && foldAddress(device.email) === foldAddress(email)) {
      return { subject: await devicePool(services.env, device.deviceId), kind: 'device' };
    }
  }
  return { subject: await addressPool(services.env, email), kind: 'address' };
}

/**
 * Counts one attempt against its pool before it is tried, or refuses it as
 * rate-limited while the pool's lockout runs. Fails closed: a counter that
 * cannot be written refuses the attempt.
 */
export async function spendSignInAttemptFor(
  services: ServiceContext,
  pool: ThrottlePool,
  now: Date = new Date(),
): Promise<void> {
  const attempt = await spendSignInAttempt(services.db, {
    subjectHash: pool.subject,
    attemptId: crypto.randomUUID(),
    now,
    policy: SIGN_IN_THROTTLE_POLICY,
  });
  if (!attempt.admitted) {
    services.log.at('signIn').warn('Refused a sign-in attempt: its throttle pool is locked', {
      pool: pool.kind,
      failedAttempts: attempt.failedAttempts,
      lockedForSeconds:
        attempt.lockedUntil === null
          ? 0
          : Math.ceil((attempt.lockedUntil.getTime() - now.getTime()) / 1000),
      // A 72-bit prefix of the HMAC, to tie a burst together in the log
      // without writing down anything that names the address.
      subject: toBase64Url(pool.subject).slice(0, 12),
    });
    throw new SignInRefusal(
      'rate-limited',
      429,
      `${pool.kind} pool locked after ${attempt.failedAttempts} attempts`,
    );
  }
}

/**
 * Refuses, as rate-limited, a request whose pool is locked — without counting
 * anything. For asking for a code: mailing a code nobody can redeem until the
 * lockout ends would only fill the inbox.
 */
export async function assertPoolOpen(
  services: ServiceContext,
  pool: ThrottlePool,
  now: Date = new Date(),
): Promise<void> {
  const state = await findSignInFailures(services.db, pool.subject);
  if (state?.lockedUntil != null && state.lockedUntil > now) {
    throw new SignInRefusal('rate-limited', 429, `${pool.kind} pool locked: no code sent`);
  }
}

/** A credential WorkOS accepted: the pool starts again with every free attempt. Best effort. */
export async function clearSignInPool(services: ServiceContext, pool: ThrottlePool): Promise<void> {
  try {
    await clearSignInFailures(services.db, pool.subject);
  } catch (cause) {
    services.log.at('signIn').error('Could not clear a sign-in throttle pool after a success', {
      error: describeError(cause),
    });
  }
}

/** An attempt WorkOS never judged: its up-front count is given back. Best effort. */
export async function refundSignInAttemptFor(
  services: ServiceContext,
  pool: ThrottlePool,
): Promise<void> {
  try {
    await refundSignInAttempt(services.db, pool.subject);
  } catch (cause) {
    services.log.at('signIn').error('Could not refund a sign-in attempt WorkOS never judged', {
      error: describeError(cause),
    });
  }
}

/**
 * The known-device cookie for a browser that just signed in as `email` — a
 * fresh device id each time. A convenience: a failure to make it is logged and
 * never fails the sign-in; the browser is then simply not known.
 */
export async function knownDeviceCookies(
  services: ServiceContext,
  email: string,
): Promise<string[]> {
  try {
    const key = await keyFrom(services.env, 'device');
    const sealed = await sealKnownDevice(key, {
      deviceId: generateDeviceId(),
      email,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    return [knownDeviceCookie(sealed)];
  } catch (cause) {
    services.log.at('issueSignIn').warn('Could not write the known-device cookie', {
      error: describeError(cause),
    });
    return [];
  }
}

/** The cookie's name, for tests and for the routes that read it. */
export { KNOWN_DEVICE_COOKIE_NAME };
