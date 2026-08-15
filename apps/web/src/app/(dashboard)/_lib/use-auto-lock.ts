'use client';

import { useEffect, useRef } from 'react';

/**
 * Locks the session after a period of idleness.
 *
 * The timer lives in the client because idleness is a fact only the client can
 * observe — the server sees requests, and reading a long secret list makes no
 * requests at all. What the timer *triggers* is the real, server-side lock:
 * the same `POST /api/auth/pin/lock` the menu uses, after which every gated
 * route refuses the session until the PIN is entered again. A client that
 * suppressed this hook would gain only a screen that fails at the 8-hour
 * server ceiling; the hook is the courtesy that locks a forgotten laptop in
 * minutes instead.
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
