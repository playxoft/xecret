import { isApiError } from '@/lib/api';
import { isLeavingPage } from '@/lib/page-exit';
import { subscribeSessionLocked } from '@/lib/session-locked';
import { isLeaveGuardArmed, subscribeLeaveGuard } from '@/components/ui/leave-guard';
import { subscribeVaultKeys, vaultKeysHeld } from '@/components/vault/key-store';

/**
 * How the dashboard shell catches up with a lock it did not perform.
 *
 * ── The one thing it does ──
 * Re-reads the session. `/api/auth/me` is exempt from the lock gate, so it
 * answers a locked session with `unlocked: false` rather than a refusal, and
 * that answer is what makes `DashboardChrome` draw the lock screen. Everything
 * here decides *when* to re-read, and when not to.
 *
 * ── What tells it ──
 * - **A refusal.** Any request answered `session_locked` (`lib/session-locked.ts`):
 *   the server's idle window closing before the browser's, typically.
 * - **A key release.** This tab's vault keys going away without `lock` having
 *   done it: a lock in another tab, or the provider reconciling with a server
 *   that stopped honouring the unlock.
 * - **No keys at all.** A tab whose session is unlocked on the server but which
 *   never obtained keys — a fresh tab with no mirror to restore and no other tab
 *   to hand them over — draws a dashboard of "your vault is locked" placeholders
 *   with no way to unlock. After {@link KEYLESS_GRACE_MS} it is locked for real,
 *   which lands on the lock screen. Fail-safe in direction: the worst case is a
 *   lock nobody needed, in a tab that missed a handoff.
 *
 * ── What it never does ──
 * - **Re-read twice at once.** A screen whose parallel requests are all refused
 *   announces the lock once per request, and a key release is one more notice of
 *   the same lock. The guard is raised by every re-read of the session, the
 *   shell's own included, and lowered by {@link LockCatchUp.answered} — when the
 *   new answer is *committed*, not when the reload's promise settles. The
 *   promise settles a render earlier, and that render is where the lock screen's
 *   provider releases any keys still held; with the guard already down, that
 *   release read as a fresh lock and re-read the session underneath the lock
 *   screen.
 * - **Throw away staged work on its own initiative.** A refusal and a keyless
 *   tab are new reasons to leave the dashboard, so while the leave guard is armed
 *   — staged edits on screen — they wait, and act the moment it disarms. The
 *   person keeps their work in view, and the action that was refused says the
 *   vault is locked. Not keyed on holding keys: an end-to-end encrypted
 *   environment cannot be opened without them, so nothing in one can be staged,
 *   but a server-encrypted environment can be edited by a tab holding none, and
 *   its staged values are as much somebody's work. A key release does not wait:
 *   that is a lock, and a lock has always discarded staged edits — the keys that
 *   would have saved them are already gone.
 * - **Start a navigation while the page is leaving.** Signing out releases the
 *   keys on its way to WorkOS's logout, and a re-read then would be a 401 whose
 *   sign-in redirect replaces that navigation (`lib/page-exit.ts`).
 */

/**
 * How long a tab with an unlocked session may hold no keys before it locks.
 *
 * Restoring the tab's own mirror is synchronous, in the provider's first render;
 * a handoff from another tab is one `BroadcastChannel` round trip. Both are
 * over long before this.
 */
export const KEYLESS_GRACE_MS = 1_500;

export interface LockCatchUpOptions {
  /** Re-reads `/api/auth/me`. Resolves once the new answer is in state. */
  reload: () => Promise<void>;
  /** Locks the server session and releases this tab's keys: `lockVault`. */
  lockVault: () => Promise<unknown>;
  /** Overridable for tests. */
  graceMs?: number;
}

export interface LockCatchUp {
  /**
   * Re-reads the session, unconditionally, and raises the guard until the answer
   * is committed. For every re-read the shell asks for itself — a screen's
   * refresh, an organisation created, an unlock — so the guard is up whichever
   * one lands on the lock screen.
   */
  reload: () => Promise<void>;
  /**
   * Locks this session and re-reads it, whatever the lock request answered. A
   * `session_locked` refusal of the lock itself is the outcome asked for; any
   * other failure is rethrown, after the re-read has started.
   */
  lock: () => Promise<void>;
  /** The shell has committed a new session answer. Lowers the guard. */
  answered: () => void;
  /**
   * Listens while the shell is drawing an unlocked dashboard, and starts the
   * keyless grace period if there is nothing to decrypt with. Returns the
   * disarm, which forgets anything deferred.
   */
  arm: () => () => void;
}

/** Whether a lock request's failure is the server saying it is already locked. */
function alreadyLocked(cause: unknown): boolean {
  return isApiError(cause) && cause.code === 'session_locked';
}

export function createLockCatchUp(options: LockCatchUpOptions): LockCatchUp {
  const graceMs = options.graceMs ?? KEYLESS_GRACE_MS;

  let armed = false;
  /** Whether a re-read is under way whose answer has not been committed. */
  let reloading = false;
  /** Counts re-reads, so a lock can tell one that predates it from its own. */
  let generation = 0;
  /** What is waiting for the leave guard to disarm. */
  let deferredCatchUp = false;
  let deferredLock = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const reload = (): Promise<void> => {
    reloading = true;
    generation += 1;
    return options.reload();
  };

  const catchUp = (): void => {
    if (isLeavingPage()) return;
    deferredCatchUp = false;
    if (reloading) return;
    void reload();
  };

  const lock = async (): Promise<void> => {
    const before = generation;
    try {
      await options.lockVault();
    } catch (cause) {
      if (!alreadyLocked(cause)) throw cause;
    } finally {
      // A re-read that began before this lock can bring back the answer from
      // before it, so it does not count as catching up; one started since —
      // by the release this lock caused — does.
      if (reloading && generation === before && !isLeavingPage()) void reload();
      else catchUp();
    }
  };

  /** The grace period's lock, and the deferred one: nobody is waiting on it. */
  const lockUnattended = (): void => {
    void lock().catch(() => undefined);
  };

  const cancelGrace = (): void => {
    if (graceTimer === null) return;
    clearTimeout(graceTimer);
    graceTimer = null;
  };

  const graceExpired = (): void => {
    graceTimer = null;
    if (!armed || vaultKeysHeld() || isLeavingPage()) return;
    if (isLeaveGuardArmed()) {
      deferredLock = true;
      return;
    }
    lockUnattended();
  };

  const startGrace = (): void => {
    if (!armed || graceTimer !== null || vaultKeysHeld()) return;
    graceTimer = setTimeout(graceExpired, graceMs);
  };

  const refused = (): void => {
    if (!armed || isLeavingPage()) return;
    if (isLeaveGuardArmed()) {
      deferredCatchUp = true;
      return;
    }
    catchUp();
  };

  const keysChanged = (): void => {
    if (vaultKeysHeld()) {
      // Arrived: a restore, a handoff or an unlock. The grace period is over,
      // and a lock waiting on the leave guard for want of keys is moot.
      cancelGrace();
      deferredLock = false;
      return;
    }
    // Deferred, because a release can happen while another component renders —
    // the lock screen's provider releases whatever is still held as it mounts —
    // and a re-read started from there would be a state update mid-render.
    queueMicrotask(() => {
      if (!armed) return;
      catchUp();
      // If the answer is still "unlocked", this tab is now keyless.
      startGrace();
    });
  };

  const guardChanged = (): void => {
    if (!armed || isLeaveGuardArmed()) return;
    if (deferredLock && !vaultKeysHeld()) {
      deferredLock = false;
      deferredCatchUp = false;
      lockUnattended();
      return;
    }
    deferredLock = false;
    if (deferredCatchUp) catchUp();
  };

  return {
    reload,
    lock,
    answered: () => {
      reloading = false;
    },
    arm: () => {
      armed = true;
      const stops = [
        subscribeSessionLocked(refused),
        subscribeVaultKeys(keysChanged),
        subscribeLeaveGuard(guardChanged),
      ];
      startGrace();

      return () => {
        armed = false;
        for (const stop of stops) stop();
        cancelGrace();
        deferredCatchUp = false;
        deferredLock = false;
      };
    },
  };
}
