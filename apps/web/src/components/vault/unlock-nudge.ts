'use client';

import { DEVICE_PIN_WRAP_KEY } from './device-pin';

/**
 * The one-line offer of a faster unlock, and the rules that stop it becoming
 * nagging.
 *
 * ── What it is for ──
 * A passkey is the difference between typing a master passphrase every morning
 * and touching a sensor, and almost nobody enrols one from a settings page they
 * never open. The moment somebody *has* just typed the passphrase is the only
 * moment the offer is about something they can feel, so that is where it is
 * made — once, quietly, and never again for a month.
 *
 * ── Why the rule is a function and not four `&&`s at a call site ──
 * Because every one of the four is a way to get this wrong in a direction the
 * user experiences as being pestered: offering a passkey to somebody who has
 * one, offering it to somebody who already unlocks this browser another way,
 * offering it again the day after it was waved off, or offering it after an
 * unlock that was not a passphrase at all. Written here it can be asserted
 * directly; written inline it can only be asserted by driving a browser, which
 * this repository's test suite does not do — the same reasoning `ceremony.ts`
 * records about the setup gates.
 */

/**
 * How long a dismissal lasts.
 *
 * Thirty days rather than forever: the answer to "not now" changes when the
 * laptop does, and a nudge nobody can ever see again is a feature nobody
 * discovers. Long enough that seeing it twice in a month is impossible.
 */
export const UNLOCK_NUDGE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Where the last dismissal is remembered.
 *
 * `localStorage`, not `sessionStorage`: the thing being remembered is a
 * *decision about this browser*, and one that expired with the tab would mean
 * the nudge returning on the next reload, which is precisely the behaviour a
 * dismissal is a request to stop. Nothing secret is written — a millisecond
 * timestamp — which is why this may live where key material never can (see
 * `session-mirror.ts` for that boundary).
 */
export const UNLOCK_NUDGE_KEY = 'xecret.nudge.unlock.v1';

/**
 * What just opened the vault in this browser.
 *
 * The distinction the caller must make, and the reason it is a parameter rather
 * than an assumption: `restored` is a tab that found its own keys after a reload
 * and asked nobody for anything, so treating it as an unlock would turn one
 * passphrase into a nudge on every refresh for as long as the tab lived.
 */
export type UnlockCause = 'passphrase' | 'passkey' | 'restored';

export interface UnlockNudgeInput {
  cause: UnlockCause;
  /** Whether this account has any enrolled passkey at all. */
  hasPasskey: boolean;
  /** Whether this browser holds a PIN wrap of its own. */
  hasPinWrap: boolean;
  /** When the nudge was last waved away here, or `null` if it never has been. */
  dismissedAt: number | null;
  now: number;
}

/** Whether to make the offer. Every "no" below is a way of not being a pest. */
export function shouldNudge({
  cause,
  hasPasskey,
  hasPinWrap,
  dismissedAt,
  now,
}: UnlockNudgeInput): boolean {
  // A passkey unlock is the thing being advertised, and a restore asked for
  // nothing — neither is a moment at which somebody has just paid for not
  // having set this up.
  if (cause !== 'passphrase') return false;

  if (hasPasskey || hasPinWrap) return false;
  if (dismissedAt === null) return true;

  // A negative interval means the clock moved backwards — a timezone fix, a
  // corrected system time, a restored image. Falling to "not yet" costs at most
  // one deferred nudge, where trusting it would show the nudge to somebody who
  // dismissed it this morning.
  return now - dismissedAt >= UNLOCK_NUDGE_INTERVAL_MS;
}

/**
 * The subset of `Storage` this module uses.
 *
 * A seam for the same two reasons `session-mirror.ts` has one: the tests run
 * without a DOM, and a browser in private mode or with site data blocked throws
 * on access rather than failing quietly.
 */
export interface NudgeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** This browser's `localStorage`, or `null` where there is none. */
export function nudgeStorage(): NudgeStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * When the nudge was last dismissed here.
 *
 * Anything that is not a finite number reads as "never dismissed", which errs
 * towards showing the offer once more rather than suppressing it forever on the
 * strength of a corrupted value.
 */
export function readNudgeDismissedAt(storage: NudgeStorage | null): number | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(UNLOCK_NUDGE_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Remembers that the offer has been made.
 *
 * Written when the nudge is *shown* rather than when its close button is
 * pressed. A one-line toast is dismissed as often by ignoring it as by clicking
 * it away, and recording only the explicit close would put the offer back on
 * screen at every unlock for everybody who reads it and moves on.
 */
export function rememberNudge(storage: NudgeStorage | null, now: number): void {
  if (storage === null) return;
  try {
    storage.setItem(UNLOCK_NUDGE_KEY, String(now));
  } catch {
    // A quota error or a blocked origin. The cost is one repeated nudge, which
    // is not worth failing an unlock over.
  }
}

/**
 * Whether this browser holds a PIN wrap.
 *
 * Deliberately looser than `device-pin.ts`'s own `readDevicePinWrap`: all this
 * needs to know is whether there is something under the key, because offering a
 * faster unlock to somebody who already has one is nagging about a problem they
 * have solved. The lock screen is stricter — it needs a record *this* version
 * can parse — so a wrap written by a later shape suppresses the nudge and still
 * routes to the passphrase, which is the correct direction for both.
 */
export function hasDevicePinWrap(storage: NudgeStorage | null): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(DEVICE_PIN_WRAP_KEY) !== null;
  } catch {
    return false;
  }
}
