'use client';

import { useEffect, useRef } from 'react';

/**
 * Locks the session after a period of idleness.
 *
 * The timer lives in the client because idleness is a fact only the client can
 * observe at any resolution — the server sees requests, and reading a long
 * secret list makes no requests at all. What the timer *triggers* is the real,
 * server-side lock: the same `POST /api/auth/vault/lock` the menu uses, after
 * which every gated route refuses the session until the vault is unlocked
 * again. It also broadcasts, so every other tab of this account zeroizes too —
 * see `vault-channel.ts`.
 *
 * ── The server counts the same allowance, from a coarser clock ──
 * `minutes` is the account's own preference, and `isVaultUnlocked` measures
 * `sessions.vault_unlocked_at` against exactly the same number, anchored on the
 * session's `last_seen_at`. So a client that suppressed this hook no longer
 * buys itself the rest of the working day; it buys the same allowance measured
 * in requests rather than in keystrokes. This hook is what makes the lock land
 * on a forgotten laptop that is making no requests at all.
 *
 * `0` is not a user-selectable interval — there is no "never" — and arrives
 * only as the placeholder the shell passes before the session has loaded, or
 * for a principal with no screen to lock.
 *
 * ── Mechanics ──
 * Activity bumps a timestamp in a ref — a ref, because pointer movement at
 * 60Hz through `setState` would re-render the whole shell continuously — and
 * a coarse interval compares it against the allowance. The interval is the
 * lock's resolution (a few seconds late, never early), which is the right
 * trade: an exact timer would have to be re-armed on every mouse movement.
 *
 * Returning to a tab that idled past its allowance while hidden locks it on
 * the next tick; the `visibilitychange` listener makes that immediate.
 */
export function useAutoLock(minutes: number, enabled: boolean, onLock: () => void) {
  // The latest callback without making it a dependency: re-arming the timer
  // because a parent re-rendered would quietly reset nothing — the timestamp
  // survives — but tearing down listeners per render is churn for no gain.
  const lock = useRef(onLock);
  useEffect(() => {
    lock.current = onLock;
  }, [onLock]);

  useEffect(() => {
    if (!enabled || minutes <= 0) return;

    const allowance = minutes * 60_000;
    const lastActivity = { current: Date.now() };
    let fired = false;

    const bump = () => {
      lastActivity.current = Date.now();
    };

    const fire = () => {
      if (fired) return;
      fired = true;
      lock.current();
    };

    const check = () => {
      if (Date.now() - lastActivity.current >= allowance) fire();
    };

    // Passive, so a 120Hz trackpad never waits on the lock timer. `keydown`
    // and `pointerdown` are the acts; `pointermove` and `wheel` count too —
    // reading without clicking is not absence.
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, bump, { passive: true });
    document.addEventListener('visibilitychange', check);

    const timer = window.setInterval(check, 10_000);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      for (const name of events) window.removeEventListener(name, bump);
    };
  }, [enabled, minutes]);
}
