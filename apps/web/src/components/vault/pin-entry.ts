import { DEVICE_PIN_LENGTH } from '@xecret/core/crypto/client';

/**
 * What six boxes do with a keystroke, as arithmetic on a string.
 *
 * ── Why this is not inside the component ──
 * Because none of it is about React, and all of it is about being right. A PIN
 * field that mis-handles a paste, a keystroke landing in a box the caret should
 * never have been in, or a `Backspace` at the end of a full entry does not look
 * broken — it produces a *different six digits* than the person typed, which
 * arrives as "my PIN stopped working" one attempt at a time, from a budget of
 * five. The web app's tests run without a DOM (see `vitest.config.mts`), so the
 * only way these rules get assertions is if they are ordinary functions over
 * strings. `pin-input.tsx` renders them; this file decides them.
 *
 * ── The invariant every function here keeps ──
 * The value is a *prefix*: some number of digits from the left, and nothing
 * after it. Six boxes suggest six independent cells, and a model that allowed
 * holes would have to answer what `1__4_6` submits. It cannot arise instead —
 * a keystroke aimed past the filled length is pulled back to the end, which is
 * also where the caret is sent, so the box somebody types into is always the
 * box they are looking at.
 */

/** ASCII digits only, for the reason `isDevicePin` gives: a PIN is not Unicode. */
const NOT_A_DIGIT = /[^0-9]/g;

/**
 * What a box's raw value means, given the digit it was already showing.
 *
 * A controlled box holding `•` or a revealed digit is not empty, so a browser
 * hands back *both* characters on the next keystroke — `•5`, or `37` when the
 * digit was momentarily visible. The mask is not a digit and falls out with
 * everything else that is not one; a visible digit has to be removed by
 * identity, once, or typing `7` over a `7` would answer an empty string.
 *
 * More than one digit surviving that is a paste or an autofill rather than a
 * keystroke, and is returned whole for {@link applyDigits} to distribute. The
 * alternative — taking the last character — is what makes a pasted PIN land as
 * its sixth digit in the first box, which is the bug this returns a string for.
 */
export function typedDigits(raw: string, previous: string): string {
  const digits = raw.replace(NOT_A_DIGIT, '');
  if (previous === '' || digits.length <= 1) return digits;

  // `replace` with a string argument removes the first occurrence, which is the
  // one the box was already displaying.
  const without = digits.replace(previous, '');
  return without === '' ? digits.slice(-1) : without;
}

/** Where a keystroke aimed at `index` actually lands. Never past the end. */
export function entryIndex(value: string, index: number, length = DEVICE_PIN_LENGTH): number {
  if (index < 0) return 0;
  return Math.min(index, value.length, length - 1);
}

/**
 * The value after `incoming` is written at `index`.
 *
 * One digit overwrites one box. Several overwrite forwards from that box, which
 * is what makes a paste into the middle of a half-typed PIN do the obvious
 * thing, and what keeps the result a prefix in both cases.
 */
export function applyDigits(
  value: string,
  index: number,
  incoming: string,
  length = DEVICE_PIN_LENGTH,
): string {
  const digits = incoming.replace(NOT_A_DIGIT, '');
  if (digits.length === 0) return value;

  const at = entryIndex(value, index, length);
  return (value.slice(0, at) + digits + value.slice(at + digits.length)).slice(0, length);
}

/**
 * The value after `Backspace` at `index`.
 *
 * A box holding a digit gives it up; a box that is empty — which is where the
 * caret sits after the sixth digit, and after every digit before it — takes the
 * one before it instead. Either way something is deleted, because a `Backspace`
 * that only moved the caret would read as a keyboard that had stopped working.
 */
export function deleteBackward(value: string, index: number): string {
  const at = Math.max(0, index);
  if (at < value.length) return value.slice(0, at) + value.slice(at + 1);
  return value.slice(0, Math.max(0, value.length - 1));
}

/** The value after `Delete` at `index`: this box's digit, and nothing else. */
export function deleteForward(value: string, index: number): string {
  const at = Math.max(0, index);
  if (at >= value.length) return value;
  return value.slice(0, at) + value.slice(at + 1);
}
