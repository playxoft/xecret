import { DEVICE_PIN_LENGTH } from '@xecret/core/crypto/client';

/**
 * What six boxes show, as arithmetic on a string.
 *
 * ── Why this is not inside the component ──
 * Because none of it is about React, and all of it is about being right. A PIN
 * field that drops a digit does not look broken — it produces a *different six
 * digits* than the person typed, which arrives as "my PIN stopped working" one
 * attempt at a time, from a budget of five. The web app's tests run without a
 * DOM (see `vitest.config.mts`), so the only way these rules get assertions is
 * if they are ordinary functions over strings. `pin-input.tsx` renders them;
 * this file decides them.
 *
 * ── Why they are this small ──
 * They used to be bigger. The first version of this component was six real
 * inputs, and these functions had to decide which box a keystroke belonged to,
 * how a paste distributed across them and what `Backspace` did at each end —
 * because none of that came for free once the caret had to be moved by hand
 * between six elements. It also *did not work*: typing at speed dropped digits,
 * because each keystroke re-rendered and moved focus while the next one was
 * already in flight.
 *
 * There is now one real input holding the whole value, and the boxes are paint.
 * Insertion, deletion, selection, `Backspace`, arrow keys, paste and the IME are
 * the browser's, on one element that never loses focus mid-word. What is left
 * here is the part that is genuinely ours: which characters are allowed, which
 * box the caret is in front of, and which of the six is legible right now.
 */

/** ASCII digits only, for the reason `isDevicePin` gives: a PIN is not Unicode. */
const NOT_A_DIGIT = /[^0-9]/g;

/**
 * The digits in a field's raw value, in order, up to the PIN's length.
 *
 * The whole of the input filter, and deliberately order-preserving rather than
 * "take the character that changed". A browser can deliver several characters in
 * one `change` — a paste, an autofill, a phone's keyboard committing a word, or
 * simply typing faster than React re-renders — and a filter that picked one
 * would silently drop the rest. That is the bug this function exists to not
 * have.
 */
export function pinDigits(raw: string, length = DEVICE_PIN_LENGTH): string {
  return raw.replace(NOT_A_DIGIT, '').slice(0, length);
}

/**
 * The box the next digit will land in.
 *
 * The caret is pinned to the end of the value — a PIN is typed left to right and
 * there is no such thing as a hole in the middle of one — so this is the length,
 * except at the end, where the sixth box stays lit rather than the highlight
 * vanishing off the edge of the group.
 */
export function caretBox(value: string, length = DEVICE_PIN_LENGTH): number {
  return Math.min(value.length, length - 1);
}

/**
 * Which box should become legible for a moment, or `null` for none.
 *
 * A digit is revealed when a digit is *added*, and never on a deletion: showing
 * the character somebody just backspaced over is the one moment they have said
 * they do not want it. The last one added is the one shown, so a paste reveals
 * its final digit rather than flashing all six.
 */
export function revealedBox(previous: string, next: string): number | null {
  return next.length > previous.length ? next.length - 1 : null;
}

/**
 * What each of the six boxes reads, given the value and which box is legible.
 *
 * Empty for a box with no digit yet, the digit itself for the one moment it is
 * revealed, and a dot for everything already entered.
 */
export function maskedBoxes(
  value: string,
  revealed: number | null,
  length = DEVICE_PIN_LENGTH,
): string[] {
  return Array.from({ length }, (_unused, index) => {
    const digit = value[index];
    if (digit === undefined) return '';
    return index === revealed ? digit : '•';
  });
}
