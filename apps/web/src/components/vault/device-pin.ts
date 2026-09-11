'use client';

import { useSyncExternalStore } from 'react';
import { DEVICE_PIN_LENGTH, isDevicePin } from '@xecret/core/crypto/client';

/**
 * The one thing a device PIN leaves on disk, and the rules for reading it back.
 *
 * ── Why this is the only key material allowed in `localStorage` ──
 * It is not key material. `wrap` is a ciphertext of the User Key under
 * `HKDF(pinKey ‖ pepper)`, and `pepper` is 32 bytes this browser has never held
 * for longer than one unlock — so the blob below cannot be opened by anything on
 * this machine, including by whoever copies the whole profile directory. That is
 * the property that distinguishes it from the `sessionStorage` mirror in
 * `session-mirror.ts`, which holds the *decrypted* keys and therefore dies with
 * the tab: this one is meant to survive the browser being closed, because
 * surviving is the entire point of it.
 *
 * The salt and the device id beside it are not secrets either — an Argon2id salt
 * never is, and the device id is a uuid the server already knows.
 *
 * ── Why it is versioned ──
 * For the reason the `xk2.` blob format is: a record written by a later shape
 * must fail to be read rather than be misread as this one. An unreadable record
 * here costs one passphrase entry and is cleared; a *mis*read one would derive
 * the wrong key and spend an attempt from a five-attempt budget.
 */

/**
 * Where the record lives, in this browser's `localStorage`.
 *
 * Declared by the module that writes it, reads it and erases it. `unlock-nudge.ts`
 * imports it for one question — "does this browser already have a faster way
 * in?" — and having the constant live at that call site made the nudge the
 * apparent owner of a key it only ever peeks at.
 *
 * Versioned in the name for the same reason the `xk2.` blob format is: a record
 * written by a later shape must fail to be read rather than be misread as this
 * one.
 */
export const DEVICE_PIN_WRAP_KEY = 'xecret.pin.v1';

/** The shape below. Bumped when the record's fields change, never silently. */
export const DEVICE_PIN_WRAP_VERSION = 1;

export interface DevicePinWrap {
  version: number;
  /** This browser's uuid, minted at first enrolment. Names the server's pepper row. */
  deviceId: string;
  /** base64url of the 16-byte Argon2id salt. Public by construction. */
  salt: string;
  /** The `xk2.gcm.` blob holding the User Key. Openable only with the pepper. */
  wrap: string;
}

/**
 * The subset of `Storage` this module uses.
 *
 * A seam for the same two reasons `session-mirror.ts` and `unlock-nudge.ts` have
 * one: the tests run without a DOM, and a browser in private mode or with site
 * data blocked throws on access rather than failing quietly. `removeItem` is
 * what makes this interface its own rather than a reuse of `NudgeStorage` — a
 * dismissal is never retracted, whereas a PIN is turned off, revoked elsewhere
 * and burned, and each of those has to be able to erase the record.
 */
export interface DevicePinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** This browser's `localStorage`, or `null` where there is none. */
export function devicePinStorage(): DevicePinStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads a stored record, or `null` for anything that is not exactly one.
 *
 * Pure, so every way a record can be wrong is assertable without a browser. A
 * missing field, a wrong version, a truncated write, another product's key
 * collision: all of them answer `null`, which puts the browser back on the
 * passphrase rather than into an attempt it cannot win.
 */
export function parseDevicePinWrap(raw: string | null): DevicePinWrap | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (candidate['version'] !== DEVICE_PIN_WRAP_VERSION) return null;

  const { deviceId, salt, wrap } = candidate;
  if (typeof deviceId !== 'string' || deviceId.length === 0) return null;
  if (typeof salt !== 'string' || salt.length === 0) return null;
  // The prefix, not a parse. Reaching for `parseBlob` here would decode a
  // ciphertext to decide whether to keep it, which is work the unwrap is about
  // to do properly and under the right key.
  if (typeof wrap !== 'string' || !wrap.startsWith('xk2.gcm.')) return null;

  return { version: DEVICE_PIN_WRAP_VERSION, deviceId, salt, wrap };
}

/** This browser's PIN wrap, or `null` when it has none. */
export function readDevicePinWrap(storage: DevicePinStorage | null): DevicePinWrap | null {
  if (storage === null) return null;
  try {
    return parseDevicePinWrap(storage.getItem(DEVICE_PIN_WRAP_KEY));
  } catch {
    return null;
  }
}

/**
 * Stores the record. A failure is reported, not swallowed.
 *
 * Unlike the nudge's dismissal, where a quota error costs one repeated toast,
 * an enrolment that silently failed to persist would tell somebody their PIN was
 * set up and then meet them with the passphrase form forever — while a live
 * pepper row on the server said otherwise.
 */
export function writeDevicePinWrap(storage: DevicePinStorage | null, record: DevicePinWrap): void {
  if (storage === null) {
    throw new Error('This browser will not store site data, so a PIN cannot be set up here.');
  }
  storage.setItem(DEVICE_PIN_WRAP_KEY, JSON.stringify(record));
  announce();
}

/**
 * Forgets the record.
 *
 * Silent on failure, and deliberately the opposite of the write: this runs on
 * the paths where the wrap is already dead — turned off, revoked elsewhere,
 * burned — and throwing would turn "your PIN has been switched off" into an
 * error message about storage.
 */
export function clearDevicePinWrap(storage: DevicePinStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(DEVICE_PIN_WRAP_KEY);
  } catch {
    // Nothing to do and nothing worth saying. The server's pepper is already
    // gone, so the record left behind opens nothing.
  }
  announce();
}

/* ─────────────────────── the React-facing subscription ─────────────────────── */

/**
 * Who is watching the record, and the cached answer they last saw.
 *
 * ── Why a subscription rather than a `useState` and an effect ──
 * Because the record lives in `localStorage`, which is neither React state nor
 * available during server rendering. Reading it in an initialiser produces
 * `false` on the server and `true` in the browser — a hydration mismatch on the
 * two screens that must not flicker between credential forms — and reading it in
 * an effect is a `setState` in an effect, which is the cascading render the lint
 * rule exists to stop. `useSyncExternalStore` is the shape React provides for
 * exactly this: a server snapshot, a client snapshot, and a subscription.
 *
 * The snapshot is cached because `getSnapshot` runs on every render and must
 * return a stable value; a fresh `JSON.parse` per render would be both wasteful
 * and, if it ever returned an object, an infinite loop.
 */
const listeners = new Set<() => void>();

let snapshot: { deviceId: string | null } | null = null;

function announce(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

function currentDeviceId(): string | null {
  snapshot ??= { deviceId: readDevicePinWrap(devicePinStorage())?.deviceId ?? null };
  return snapshot.deviceId;
}

/** Nothing is ever enrolled during server rendering, and nothing may pretend it is. */
function serverSnapshot(): null {
  return null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // `storage` fires only in *other* tabs, which is precisely the case this
  // cannot otherwise see: a PIN revoked from the settings page in one tab must
  // stop being offered on the lock screen in another.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DEVICE_PIN_WRAP_KEY) announce();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/**
 * This browser's enrolled device id, or `null` when it holds no PIN.
 *
 * Re-renders on enrolment, on revocation, and on a burn — including one that
 * happened in another tab.
 */
export function useDevicePinId(): string | null {
  return useSyncExternalStore(subscribe, currentDeviceId, serverSnapshot);
}

/**
 * Why a PIN cannot be submitted yet, or `null` when it can.
 *
 * Pure and exported so the entry rules are asserted directly rather than by
 * driving a form. `confirm` is optional because the same rules govern both
 * screens the PIN is typed on: the lock screen asks once, the settings flow asks
 * twice.
 */
export function pinProblem(pin: string, confirm?: string): string | null {
  if (!isDevicePin(pin)) return `Your PIN is ${DEVICE_PIN_LENGTH} digits.`;
  if (confirm !== undefined && pin !== confirm) return 'Those two PINs do not match.';
  return null;
}
