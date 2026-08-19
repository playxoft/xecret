'use client';

import { useEffect, useRef } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';

import { cn } from '@/lib/cn';
import { PIN_LENGTH } from '@xecret/core/auth';

/**
 * Six boxes for a six-digit PIN.
 *
 * ── One value, six boxes ──
 * The state is a single string; the boxes are a rendering of it. The obvious
 * alternative — an array of six independent characters — makes paste, backspace
 * across a boundary, and "clear and start again" three separate problems, and
 * every implementation of it gets at least one of them wrong.
 *
 * ── What is handled, because a lock screen that fights you is worse than a
 * password field ──
 *  - **Paste.** Somebody with a PIN in a password manager pastes six digits into
 *    the first box. Non-digits are stripped rather than rejected, so pasting
 *    `123 456` works.
 *  - **Backspace on an empty box** moves to the previous one and clears it,
 *    which is what every OS PIN screen does and what fingers expect.
 *  - **Arrow keys** move between boxes without changing anything.
 *  - **Autofill from an SMS/OTP manager**, via `autoComplete="one-time-code"`.
 *    Not literally a one-time code, but it is the token every platform's
 *    autofill recognises for "short numeric field", and the alternative is
 *    browsers offering to fill it with a saved password.
 *
 * ── Security notes that are not styling ──
 * `type="password"` on every box, so the digits are masked in screenshots and to
 * anybody standing behind. `inputMode="numeric"` gets the numeric keypad on a
 * phone without making the field a spinner. Nothing is stored anywhere but React
 * state — no `localStorage`, no URL, and never a `console`.
 */

export interface PinInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Fired when the last digit lands, so the caller can submit without a click. */
  onComplete?: (value: string) => void;
  disabled?: boolean;
  /** Renders the boxes in the danger tone and marks them invalid. */
  invalid?: boolean;
  /** Labels the group for a screen reader — "PIN", "New PIN", "Current PIN". */
  label: string;
  autoFocus?: boolean;
}

export function PinInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  label,
  autoFocus = false,
}: PinInputProps) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  // Focus follows the caret: the box after the last digit entered, or the last
  // box once it is full. Derived rather than tracked, so it cannot disagree with
  // the value after a paste or a programmatic clear.
  const active = Math.min(value.length, PIN_LENGTH - 1);

  useEffect(() => {
    if (autoFocus) boxes.current[0]?.focus();
  }, [autoFocus]);

  function commit(next: string) {
    const digits = next.replace(/\D/g, '').slice(0, PIN_LENGTH);
    onChange(digits);
    if (digits.length === PIN_LENGTH) onComplete?.(digits);
  }

  function handleInput(index: number, raw: string) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 0) return;

    // Typing into a box that is not the end replaces from there, so correcting
    // the third digit does not require deleting the fourth, fifth and sixth.
    commit(value.slice(0, index) + digits);
    boxes.current[Math.min(index + digits.length, PIN_LENGTH - 1)]?.focus();
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (value.length === 0) return;

      // On an empty box, backspace deletes the previous digit and moves there.
      const at = value[index] === undefined ? Math.max(index - 1, 0) : index;
      commit(value.slice(0, at) + value.slice(at + 1));
      boxes.current[at]?.focus();
      return;
    }

    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      boxes.current[index - 1]?.focus();
      return;
    }

    if (event.key === 'ArrowRight' && index < PIN_LENGTH - 1) {
      event.preventDefault();
      boxes.current[index + 1]?.focus();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    commit(event.clipboardData.getData('text'));
    boxes.current[PIN_LENGTH - 1]?.focus();
  }

  return (
    // A group rather than six unrelated fields, so a screen reader announces
    // "PIN, 6 digits" once instead of naming each box in turn.
    // `aria-invalid` belongs on each input, not on the group — `group` does not
    // support it, and a screen reader would ignore it there.
    <div
      role="group"
      aria-label={`${label}, ${PIN_LENGTH} digits`}
      className="flex justify-center gap-2"
    >
      {Array.from({ length: PIN_LENGTH }, (_, index) => (
        <input
          key={index}
          ref={(element) => {
            boxes.current[index] = element;
          }}
          type="password"
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          // Not `maxLength={1}`: a paste into one box has to be readable in
          // full before it can be distributed across the others.
          value={value[index] ?? ''}
          onChange={(event) => handleInput(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          onPaste={handlePaste}
          onFocus={(event) => event.target.select()}
          disabled={disabled}
          aria-label={`Digit ${index + 1}`}
          aria-invalid={invalid || undefined}
          className={cn(
            // `--line-control`, not the container hairline these used to take:
            // a PIN box is empty until typed into and its fill is the surface
            // it sits on, so the border is the only thing that says there is a
            // box at all — six of them, and you have to count along the row.
            'border-line-control bg-surface text-fg h-12 w-11 rounded-lg border text-center font-mono text-lg',
            // No `outline-none` and no ring of its own. This used to carry
            // `outline-none focus:ring-accent/30`, which deleted the
            // application's focus treatment — globals.css says in terms that a
            // component must not do that — and replaced it with roughly 1.96:1
            // on `--surface`, under SC 1.4.11's 3:1. `focus-visible`, not
            // `focus`, for the same reason the base rule pairs them: pointer
            // users get no ring, keyboard users always do.
            'focus-visible:border-accent',
            'disabled:cursor-not-allowed disabled:opacity-60',
            invalid && 'border-danger focus:border-danger focus:ring-danger/30',
            // The box the caret is in gets a resting highlight, so it is obvious
            // where a keystroke will land before you press one. It has to be a
            // step *above* the resting border, which `--line-strong` no longer
            // is now that the resting one clears 3:1; `--fg-subtle` is the same
            // emphasis `Input` uses for hover and focus.
            !invalid && index === active && 'border-fg-subtle',
          )}
        />
      ))}
    </div>
  );
}
