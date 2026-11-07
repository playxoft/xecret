import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { beginLeavingPage, beginSignInRedirect, stayOnPage } from '@/lib/page-exit';
import { announceSessionLocked } from '@/lib/session-locked';
import { armLeaveGuard } from '@/components/ui/leave-guard';
import { holdVaultKeys, releaseVaultKeys } from '@/components/vault/key-store';
import { createLockCatchUp, KEYLESS_GRACE_MS } from './lock-catch-up';

/**
 * When the dashboard shell re-reads the session — which is what lands it on the
 * lock screen — and when it must not.
 *
 * Driven through the real signals: a refusal announced by the API client, the
 * real key store, the real leave guard, the real "leaving the page" flag. Only
 * the two things that would touch the network are fakes — the session re-read
 * and the lock request — and they are what every assertion counts.
 */

function material(fill = 7) {
  return {
    userId: 'user-1',
    userKey: new Uint8Array(32).fill(fill),
    encPrivateKey: new Uint8Array(32).fill(fill + 1),
    encPublicKey: new Uint8Array(32).fill(fill + 2),
    signPrivateKey: new Uint8Array(32).fill(fill + 3),
    signPublicKey: new Uint8Array(32).fill(fill + 4),
  };
}

function lockedRefusal(): ApiError {
  return new ApiError({
    code: 'session_locked',
    message: 'Unlock your vault to continue.',
    status: 403,
    requestId: 'r',
  });
}

/** Lets every queued microtask — signal delivery, a lock's `finally` — run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

// Coordinators are disarmed before guards, so a guard let go during cleanup
// cannot release work a coordinator was holding back into the next test.
const coordinators: (() => void)[] = [];
const guards: (() => void)[] = [];

/**
 * A coordinator armed as the shell arms it while the unlocked dashboard is drawn
 * — under a `VaultProvider`, unless `awaitKeys` says otherwise.
 */
function armed(options: { lockVault?: () => Promise<unknown>; awaitKeys?: boolean } = {}) {
  const reload = vi.fn(async () => {});
  const lockVault = vi.fn(options.lockVault ?? (async () => 1));
  const catchUp = createLockCatchUp({ reload, lockVault });
  const disarm = catchUp.arm({ awaitKeys: options.awaitKeys ?? true });
  coordinators.push(disarm);
  return { catchUp, reload, lockVault, disarm };
}

/** The leave guard armed, as a screen with staged edits arms it. */
function stagedWork(): () => void {
  const disarm = armLeaveGuard(() => {});
  guards.push(disarm);
  return disarm;
}

afterEach(() => {
  for (const disarm of coordinators.splice(0)) disarm();
  for (const disarm of guards.splice(0)) disarm();
  releaseVaultKeys();
  stayOnPage();
  vi.useRealTimers();
});

describe('one re-read at a time', () => {
  it('re-reads once for a burst of refusals', async () => {
    holdVaultKeys(material());
    const { reload } = armed();

    announceSessionLocked();
    announceSessionLocked();
    announceSessionLocked();
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('re-reads once for a refusal and the key release that comes with the same lock', async () => {
    holdVaultKeys(material());
    const { reload } = armed();

    announceSessionLocked();
    releaseVaultKeys();
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('lowers the guard only when a new answer is committed', async () => {
    holdVaultKeys(material());
    const { catchUp, reload } = armed();

    announceSessionLocked();
    await flush();
    announceSessionLocked();
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);

    catchUp.answered();
    announceSessionLocked();
    await flush();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('raises the guard for a re-read the shell asked for itself', async () => {
    // A screen's refresh landing on the lock screen: the lock screen's provider
    // releases the keys as it mounts, and that release must not start a second
    // re-read — and a skeleton — underneath it.
    holdVaultKeys(material());
    const { catchUp, reload } = armed();

    void catchUp.reload();
    releaseVaultKeys();
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never skips a re-read the shell asked for, which a caller may be waiting on', async () => {
    // Deleting an organisation refreshes and then navigates on the answer; a
    // refresh swallowed by a re-read already under way would hand it the old one.
    holdVaultKeys(material());
    const { catchUp, reload } = armed();

    announceSessionLocked();
    await flush();
    await catchUp.reload();

    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('locking', () => {
  it('counts the lock being refused as already locked as success, and re-reads', async () => {
    holdVaultKeys(material());
    const { catchUp, reload } = armed({
      lockVault: async () => {
        releaseVaultKeys();
        throw lockedRefusal();
      },
    });

    await expect(catchUp.lock()).resolves.toBeUndefined();
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rethrows any other failure — after the re-read has started', async () => {
    holdVaultKeys(material());
    const offline = new ApiError({
      code: 'network_error',
      message: 'Could not reach xecret.',
      status: 0,
      requestId: null,
    });
    const { catchUp, reload } = armed({
      lockVault: async () => {
        releaseVaultKeys();
        throw offline;
      },
    });

    await expect(catchUp.lock()).rejects.toBe(offline);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('re-reads once for a lock and the key release it causes', async () => {
    holdVaultKeys(material());
    const { catchUp, reload } = armed({
      lockVault: async () => {
        await Promise.resolve();
        releaseVaultKeys();
        return 1;
      },
    });

    await catchUp.lock();
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not count a re-read that began before the lock', async () => {
    // Its answer may be from before the lock: "unlocked", over a store that has
    // just been emptied.
    holdVaultKeys(material());
    const { catchUp, reload } = armed();

    void catchUp.reload();
    await catchUp.lock();

    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('staged work on screen', () => {
  it('holds a refusal back while the leave guard is armed, and catches up once it disarms', async () => {
    holdVaultKeys(material());
    const { reload } = armed();
    const disarmGuard = stagedWork();

    announceSessionLocked();
    await flush();
    expect(reload).not.toHaveBeenCalled();

    disarmGuard();
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps holding it back for every refusal while the work is still there', async () => {
    holdVaultKeys(material());
    const { reload } = armed();
    stagedWork();

    announceSessionLocked();
    announceSessionLocked();
    await flush();

    expect(reload).not.toHaveBeenCalled();
  });

  it('holds it back in a tab with no keys too — server-encrypted work needs none', async () => {
    const { reload } = armed();
    stagedWork();

    announceSessionLocked();
    await flush();

    expect(reload).not.toHaveBeenCalled();
  });

  it('does not hold back a key release: that is a lock, and the keys are already gone', async () => {
    holdVaultKeys(material());
    const { reload } = armed();
    stagedWork();

    releaseVaultKeys();
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('re-reads nothing when the guard disarms with nothing held back', async () => {
    holdVaultKeys(material());
    const { reload } = armed();
    const disarmGuard = stagedWork();

    disarmGuard();
    await flush();

    expect(reload).not.toHaveBeenCalled();
  });

  it('forgets what it held back once the unlocked dashboard is gone', async () => {
    holdVaultKeys(material());
    const { reload, disarm } = armed();
    const disarmGuard = stagedWork();

    announceSessionLocked();
    await flush();
    disarm();
    disarmGuard();
    await flush();

    expect(reload).not.toHaveBeenCalled();
  });
});

describe('a tab with an unlocked session and no keys', () => {
  it('locks once the grace period passes without keys, which lands on the lock screen', async () => {
    vi.useFakeTimers();
    const { reload, lockVault } = armed();

    vi.advanceTimersByTime(KEYLESS_GRACE_MS - 1);
    expect(lockVault).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await flush();
    expect(lockVault).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stands down when keys arrive — a handoff from another tab', async () => {
    vi.useFakeTimers();
    const { lockVault } = armed();

    vi.advanceTimersByTime(KEYLESS_GRACE_MS / 2);
    holdVaultKeys(material());
    vi.advanceTimersByTime(KEYLESS_GRACE_MS * 2);
    await flush();

    expect(lockVault).not.toHaveBeenCalled();
  });

  it('never starts for a tab that already holds keys', async () => {
    vi.useFakeTimers();
    holdVaultKeys(material());
    const { lockVault } = armed();

    vi.advanceTimersByTime(KEYLESS_GRACE_MS * 4);
    await flush();

    expect(lockVault).not.toHaveBeenCalled();
  });

  it('never runs where nothing could obtain keys — the screen with no organisations', async () => {
    // No provider is mounted there, so no mirror is restored and no other tab is
    // asked: the tab is keyless by construction, and locking the session for it
    // would lock every other tab of the account as well.
    vi.useFakeTimers();
    const { lockVault } = armed({ awaitKeys: false });

    vi.advanceTimersByTime(KEYLESS_GRACE_MS * 4);
    await flush();

    expect(lockVault).not.toHaveBeenCalled();
  });

  it('does not start there after a release either, though it still catches up', async () => {
    vi.useFakeTimers();
    holdVaultKeys(material());
    const { catchUp, reload, lockVault } = armed({ awaitKeys: false });

    releaseVaultKeys();
    await flush();
    catchUp.answered();
    vi.advanceTimersByTime(KEYLESS_GRACE_MS * 4);
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(lockVault).not.toHaveBeenCalled();
  });

  it('never runs once the lock screen is drawn', async () => {
    vi.useFakeTimers();
    const { lockVault, disarm } = armed();

    disarm();
    vi.advanceTimersByTime(KEYLESS_GRACE_MS * 4);
    await flush();

    expect(lockVault).not.toHaveBeenCalled();
  });

  it('waits for staged work like a refusal does, then locks', async () => {
    vi.useFakeTimers();
    const disarmGuard = stagedWork();
    const { lockVault } = armed();

    vi.advanceTimersByTime(KEYLESS_GRACE_MS * 2);
    await flush();
    expect(lockVault).not.toHaveBeenCalled();

    disarmGuard();
    await flush();
    expect(lockVault).toHaveBeenCalledTimes(1);
  });

  it('drops a lock that was waiting on staged work if keys arrive meanwhile', async () => {
    vi.useFakeTimers();
    const disarmGuard = stagedWork();
    const { lockVault } = armed();

    vi.advanceTimersByTime(KEYLESS_GRACE_MS * 2);
    holdVaultKeys(material());
    disarmGuard();
    await flush();

    expect(lockVault).not.toHaveBeenCalled();
  });

  it('swallows a failed lock rather than leaving it floating, and still re-reads', async () => {
    vi.useFakeTimers();
    const { reload, lockVault } = armed({
      lockVault: async () => {
        throw new ApiError({ code: 'internal_error', message: 'x', status: 500, requestId: null });
      },
    });

    vi.advanceTimersByTime(KEYLESS_GRACE_MS);
    await flush();

    // An unhandled rejection here would fail the run.
    expect(lockVault).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('starts over after a release whose re-read still says unlocked', async () => {
    vi.useFakeTimers();
    holdVaultKeys(material());
    const { catchUp, reload, lockVault } = armed();

    releaseVaultKeys();
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    // The answer comes back unlocked, so the shell stays armed — and keyless.
    catchUp.answered();

    vi.advanceTimersByTime(KEYLESS_GRACE_MS);
    await flush();
    expect(lockVault).toHaveBeenCalledTimes(1);
  });
});

describe('a page that is leaving on purpose', () => {
  // Signing out releases the keys on its way to WorkOS's logout. A re-read then
  // is a 401, and its sign-in redirect would replace that navigation.
  it('re-reads nothing when signing out releases the keys', async () => {
    holdVaultKeys(material());
    const { reload } = armed();

    beginLeavingPage();
    releaseVaultKeys();
    await flush();

    expect(reload).not.toHaveBeenCalled();
  });

  it('re-reads nothing for a refusal', async () => {
    holdVaultKeys(material());
    const { reload } = armed();

    beginLeavingPage();
    announceSessionLocked();
    await flush();

    expect(reload).not.toHaveBeenCalled();
  });

  it('re-reads nothing once a 401 has started the redirect to sign in', async () => {
    // That redirect releases the keys on its way out; a re-read of a session
    // that has ended would only be one more 401.
    holdVaultKeys(material());
    const { reload } = armed();

    beginSignInRedirect();
    releaseVaultKeys();
    await flush();

    expect(reload).not.toHaveBeenCalled();
  });

  it('re-reads nothing after a lock that was already under way', async () => {
    holdVaultKeys(material());
    const { catchUp, reload } = armed({
      lockVault: async () => {
        beginLeavingPage();
        releaseVaultKeys();
        return 1;
      },
    });

    await catchUp.lock();
    await flush();

    expect(reload).not.toHaveBeenCalled();
  });

  it('locks nothing when the grace period runs out', async () => {
    vi.useFakeTimers();
    const { lockVault } = armed();

    beginLeavingPage();
    vi.advanceTimersByTime(KEYLESS_GRACE_MS * 2);
    await flush();

    expect(lockVault).not.toHaveBeenCalled();
  });
});
