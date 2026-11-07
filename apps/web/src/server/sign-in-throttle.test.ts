import { describe, expect, it } from 'vitest';
import type { Bindings } from './bindings';
import { MissingBindingError } from './bindings';
import {
  addressPool,
  devicePool,
  SIGN_IN_FAILURE_WINDOW_MS,
  SIGN_IN_FREE_FAILURES,
  SIGN_IN_LOCKOUT_BASE_MS,
  SIGN_IN_LOCKOUT_MAX_MS,
  signInLockoutFor,
} from './sign-in-throttle';

/**
 * The durable sign-in lockout's policy, without a database: what each failure
 * costs, and the budget its header promises. The counting itself is
 * `in-app-sign-in-route.test.ts`'s and the repository's.
 */

const NOW = new Date('2026-11-08T10:00:00Z');

function delayAfter(failedAttempts: number): number | null {
  const until = signInLockoutFor(failedAttempts, NOW);
  return until === null ? null : until.getTime() - NOW.getTime();
}

describe('the sign-in lockout', () => {
  it('lets the first five failures through without a delay', () => {
    expect(SIGN_IN_FREE_FAILURES).toBe(5);
    for (let n = 1; n <= SIGN_IN_FREE_FAILURES; n += 1) expect(delayAfter(n)).toBeNull();
  });

  it('then waits 30 s, doubling, and never more than 15 minutes', () => {
    expect([6, 7, 8, 9, 10, 11, 12, 100, 10_000].map(delayAfter)).toEqual([
      30_000,
      60_000,
      120_000,
      240_000,
      480_000,
      SIGN_IN_LOCKOUT_MAX_MS,
      SIGN_IN_LOCKOUT_MAX_MS,
      SIGN_IN_LOCKOUT_MAX_MS,
      SIGN_IN_LOCKOUT_MAX_MS,
    ]);
    expect(SIGN_IN_LOCKOUT_BASE_MS).toBe(30_000);
    expect(SIGN_IN_LOCKOUT_MAX_MS).toBe(15 * 60_000);
    expect(SIGN_IN_FAILURE_WINDOW_MS).toBe(24 * 60 * 60_000);
  });

  it('holds the budget the header promises: ~13 guesses in the first hour, 4 an hour after, ~10 inside one code', () => {
    // A guesser who retries the instant each lockout ends.
    const times: number[] = [];
    let at = 0;
    for (let n = 1; at <= 25 * 60 * 60_000; n += 1) {
      times.push(at);
      at += delayAfter(n) ?? 0;
    }
    const within = (ms: number) => times.filter((t) => t < ms).length;

    expect(within(60 * 60_000)).toBe(13);
    expect(within(2 * 60 * 60_000) - within(60 * 60_000)).toBe(4);
    expect(within(24 * 60 * 60_000)).toBeLessThanOrEqual(110);
    // An emailed code lives ten minutes.
    expect(within(10 * 60_000)).toBe(10);
  });
});

describe('the pools’ keys', () => {
  const env = {
    WORKOS_COOKIE_PASSWORD: 'a-cookie-password-that-is-comfortably-over-32-characters',
  } as unknown as Bindings;

  it('are an HMAC of the pool’s name, folding only ASCII capitals and surrounding spaces of an address', async () => {
    const a = await addressPool(env, ' Pat@Example.COM ');
    const b = await addressPool(env, 'pat@example.com');
    const other = await addressPool(env, 'pat@example.org');
    const plain = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pat@example.com')),
    );

    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(other))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(plain))).toBe(false);
  });

  it('never let a device and an address share a row', async () => {
    const address = await addressPool(env, 'pat@example.com');
    const device = await devicePool(env, 'pat@example.com');
    expect(Buffer.from(address).equals(Buffer.from(device))).toBe(false);
  });

  it('depend on the deployment’s secret', async () => {
    const other = {
      WORKOS_COOKIE_PASSWORD: 'another-cookie-password-also-over-thirty-two-chars',
    } as unknown as Bindings;
    expect(
      Buffer.from(await addressPool(env, 'pat@example.com')).equals(
        Buffer.from(await addressPool(other, 'pat@example.com')),
      ),
    ).toBe(false);
  });

  it('refuse to key anything without the secret', async () => {
    await expect(addressPool({} as Bindings, 'pat@example.com')).rejects.toBeInstanceOf(
      MissingBindingError,
    );
  });
});
