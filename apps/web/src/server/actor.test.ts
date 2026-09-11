import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@xecret/core/ids';
import type { Principal } from './actor';
import type { ServiceContext } from './context';

/**
 * The vault lock gate, on the principal side of it.
 *
 * `route.test.ts` proves the wrapper calls the gate and refuses what it refuses.
 * What is under test here is the half that has to happen *as well as* the
 * refusal: clearing the unlock the refusal was judged against, so that the lock
 * outlives the request that enforced it.
 *
 * ── The bug these pin ──
 * The window slides on `sessions.last_seen_at`, and `authenticate` schedules a
 * touch of that column on every request, before the gate runs. So the gate used
 * to refuse an idled-out session exactly once: the refused request's own touch
 * moved the anchor to now, and the next request was inside the window again. The
 * lock re-armed itself every five minutes until the eight-hour ceiling, which is
 * the opposite of what a fifteen-minute preference asks for.
 */

const repositories = vi.hoisted(() => ({ lockSessions: vi.fn(async () => 1) }));

vi.mock('@xecret/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xecret/db/repositories')>()),
  lockSessions: repositories.lockSessions,
}));

const { isUnlocked, latchVaultLock } = await import('./actor');

const MINUTE = 60_000;
const SESSION_ID = uuidv7();
const DB = { db: true };

function sessionPrincipal(
  overrides: Partial<Extract<Principal, { kind: 'user' }>> = {},
): Principal {
  return {
    kind: 'user',
    sessionId: SESSION_ID,
    user: {
      id: uuidv7(),
      email: 'nitheesh@playxoft.com',
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
    },
    vaultUnlockedAt: null,
    lastSeenAt: new Date(),
    vaultAutoLockMinutes: 15,
    ...overrides,
  };
}

/** A context that records deferred work rather than running it past a response. */
function fakeServices(): { services: ServiceContext; deferred: Promise<unknown>[] } {
  const deferred: Promise<unknown>[] = [];
  return {
    services: {
      db: DB,
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
    } as unknown as ServiceContext,
    deferred,
  };
}

describe('latching a refused lock', () => {
  it('clears the unlock, so the next request inside the window stays locked', async () => {
    const now = new Date();
    const idled = new Date(now.getTime() - 20 * MINUTE);

    // Twenty minutes of silence against a fifteen-minute preference.
    const refused = sessionPrincipal({ vaultUnlockedAt: idled, lastSeenAt: idled });
    expect(isUnlocked(refused, now)).toBe(false);

    // This is what used to happen next, and it is the whole bug: the refused
    // request's own `touchSession` moves `last_seen_at` to now, and the anchor
    // is `max(vault_unlocked_at, last_seen_at)`.
    expect(isUnlocked(sessionPrincipal({ vaultUnlockedAt: idled, lastSeenAt: now }), now)).toBe(
      true,
    );

    const { services, deferred } = fakeServices();
    latchVaultLock(refused, services);
    await Promise.all(deferred);

    expect(repositories.lockSessions).toHaveBeenCalledWith(DB, { sessionId: SESSION_ID });

    // With the timestamp cleared, the slid anchor no longer matters: a null
    // `vault_unlocked_at` is refused whatever `last_seen_at` says.
    expect(isUnlocked(sessionPrincipal({ vaultUnlockedAt: null, lastSeenAt: now }), now)).toBe(
      false,
    );
  });

  it('writes nothing for a session that was never unlocked', () => {
    // A fresh sign-in on its way to the unlock screen. Every gated request it
    // makes is refused, and an UPDATE per refusal would be a write on the one
    // path that has nothing to undo.
    repositories.lockSessions.mockClear();
    const { services, deferred } = fakeServices();

    latchVaultLock(sessionPrincipal({ vaultUnlockedAt: null }), services);

    expect(deferred).toHaveLength(0);
    expect(repositories.lockSessions).not.toHaveBeenCalled();
  });

  it('leaves CLI and service tokens alone', () => {
    // Neither can be locked — there is nobody present to type a passphrase, so
    // `isUnlocked` answers true for both and there is no unlock to clear.
    repositories.lockSessions.mockClear();
    const { services, deferred } = fakeServices();

    latchVaultLock(
      { kind: 'cliToken', tokenId: uuidv7(), tokenName: 'ci', userId: uuidv7(), orgId: uuidv7() },
      services,
    );
    latchVaultLock(
      {
        kind: 'serviceToken',
        tokenId: uuidv7(),
        tokenName: 'deploy',
        orgId: uuidv7(),
        projectId: uuidv7(),
        environmentId: uuidv7(),
        accessLevel: 'read',
      },
      services,
    );

    expect(deferred).toHaveLength(0);
    expect(repositories.lockSessions).not.toHaveBeenCalled();
  });
});
