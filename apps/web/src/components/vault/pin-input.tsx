'use client';

import { useEffect, useRef, useState } from 'react';
import { DEVICE_PIN_LENGTH } from '@xecret/core/crypto/client';

import { cn } from '@/lib/cn';
import { INPUT_BASE, useFieldGroup } from '@/components/ui';
import { applyDigits, deleteBackward, deleteForward, entryIndex, typedDigits } from './pin-entry';

/**
 * Six digits, in six boxes, on both screens that ask for them.
 *
 * ── Why one component for the lock screen and the settings form ──
 * Because a PIN entry is mostly rules, and three copies of a rule is three
 * chances to disagree about what `Backspace` does. The lock screen and the two
 * enrolment fields differ in exactly one behaviour — the sixth digit submits on
 * one of them and does not on the other two — and that difference is a callback
 * ({@link PinInputProps.onComplete}), not a fork. Everything else, including the
 * masking and the paste handling, is the same code by construction.
 *
 * ── Why six real inputs rather than one input with six painted boxes ──
 * A single hidden field with decorative cells is simpler to write and lies to
 * anybody not looking at it: the caret is somewhere the boxes cannot show, and a
 * screen reader is handed one control called "PIN" whose contents it re-reads
 * from the top on every keystroke. Six inputs mean the thing that has focus is
 * the thing that is highlighted, each box can say which of the six it is, and
 * arrow keys are the browser's own. The cost is focus management, and it is paid
 * in one place — {@link move} — rather than at every call site.
 *
 * ── The masking, and the half-second ──
 * The typed digit is shown while it is being typed and hidden shortly after,
 * which is the pattern every phone lock screen uses: it is the only feedback
 * that distinguishes "I pressed 4" from "the keyboard missed that", and six
 * identical dots appearing under your fingers is how people give up on PIN
 * fields. The reveal is withdrawn the instant another digit lands as well as on
 * the timer, so at most one digit is ever legible over a shoulder, and the boxes
 * are `••••••` again half a second after the last keystroke — including on the
 * lock screen, where the sixth digit submits and the entry is cleared anyway.
 *
 * ── What is deliberately *not* here ──
 * `autoComplete="one-time-code"`. This is a PIN, not an OTP: the iOS and Android
 * heuristics behind that value offer to fill it from an SMS the user never
 * received, and a password manager that decided to remember six digits would put
 * the one credential this product cannot re-derive into a vault we do not
 * control. `off`, and nothing else.
 */

/** How long a digit stays legible. Long enough to read, short enough to miss. */
const REVEAL_MS = 500;

export interface PinInputProps {
  /** The digits typed so far. Always a prefix — see `pin-entry.ts`. */
  value: string;
  onChange: (value: string) => void;
  /**
   * Called when the last box is filled, with the complete value.
   *
   * The lock screen submits from here. The enrolment form does not pass it: a
   * PIN being *chosen* has a confirmation field after it, and auto-submitting
   * the first field is how somebody enrols a typo.
   */
  onComplete?: (value: string) => void;
  /** Six, everywhere. A parameter so the boxes and the rules cannot disagree. */
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

export function PinInput({
  value,
  onChange,
  onComplete,
  length = DEVICE_PIN_LENGTH,
  disabled = false,
  autoFocus = false,
  className,
}: PinInputProps) {
  const field = useFieldGroup();
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  /**
   * Which box is showing its digit rather than a dot, and the timer that ends
   * it.
   *
   * A ref beside the state because the timer has to be cancellable from the
   * next keystroke and from unmount — a `setTimeout` outliving this component
   * would call `setRevealed` on something that is gone, which React logs and
   * which on the lock screen happens every single time a PIN succeeds.
   */
  const [revealed, setRevealed] = useState<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );

  /**
   * The caret, handed back after the host empties a filled entry.
   *
   * A wrong PIN on the lock screen clears the value *and* passes `disabled`
   * while the attempt is in flight — and a browser blurs a control that becomes
   * disabled, so by the time the six boxes come back the keyboard types nowhere.
   * Somebody who has just been told they have four tries left should not have to
   * find the mouse. The flag is not cleared while disabled, because the clear
   * and the re-enable arrive as two separate renders.
   */
  const hadDigits = useRef(false);
  useEffect(() => {
    if (value.length > 0) {
      hadDigits.current = true;
      return;
    }
    if (!hadDigits.current || disabled) return;
    hadDigits.current = false;
    move(0);
    // `move` is re-created every render and carries no state of its own; listing
    // it would run this on every render instead of on the transition it is about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, disabled]);

  function reveal(index: number) {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    setRevealed(index);
    hideTimer.current = setTimeout(() => setRevealed(null), REVEAL_MS);
  }

  /** Moves the caret, selecting whatever is there so the next digit replaces it. */
  function move(index: number) {
    const box = boxes.current[Math.min(Math.max(index, 0), length - 1)];
    box?.focus();
    box?.select();
  }

  function commit(next: string, caret: number) {
    onChange(next);
    move(caret);
    if (next.length === length) onComplete?.(next);
  }

  function write(index: number, raw: string) {
    const at = entryIndex(value, index, length);
    const incoming = typedDigits(raw, value[at] ?? '');
    // Everything that is not a digit — a letter, a space, an Arabic-Indic
    // numeral — leaves the boxes exactly as they were. The controlled `value`
    // below then repaints the box, so nothing rejected is ever left on screen.
    if (incoming.length === 0) {
      setRevealed(null);
      return;
    }

    const next = applyDigits(value, at, incoming, length);
    reveal(Math.min(at + incoming.length - 1, length - 1));
    commit(next, at + incoming.length);
  }

  function keyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    const at = entryIndex(value, index, length);

    switch (event.key) {
      case 'Backspace': {
        event.preventDefault();
        setRevealed(null);
        commit(deleteBackward(value, at), at - 1);
        return;
      }
      case 'Delete': {
        event.preventDefault();
        setRevealed(null);
        commit(deleteForward(value, at), at);
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        move(at - 1);
        return;
      }
      case 'ArrowRight': {
        event.preventDefault();
        move(at + 1);
        return;
      }
      case 'Home': {
        event.preventDefault();
        move(0);
        return;
      }
      case 'End': {
        event.preventDefault();
        move(value.length);
        return;
      }
      default:
        return;
    }
  }

  /**
   * A paste, handled once for the whole group.
   *
   * Six digits arrive as one event on one box, and the default would put all of
   * them in that box for `maxLength` to truncate to the first. Reading the
   * clipboard here and distributing through the same {@link applyDigits} a
   * keystroke uses means "paste 123456" and "type 123456" produce the same six
   * boxes and the same auto-submit.
   */
  function paste(index: number, event: React.ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const digits = event.clipboardData.getData('text').replace(/[^0-9]/g, '');
    if (digits.length === 0) return;

    // A full-length paste replaces the entry rather than appending to whatever
    // the caret happened to be sitting in front of.
    const at = digits.length >= length ? 0 : entryIndex(value, index, length);
    const next = applyDigits(value, at, digits, length);
    setRevealed(null);
    commit(next, at + digits.length);
  }

  return (
    <div
      role="group"
      aria-labelledby={field.labelledBy}
      aria-describedby={field.describedBy}
      className={cn('flex items-center gap-2', className)}
    >
      {Array.from({ length }, (_, index) => {
        const digit = value[index] ?? '';
        const shown = digit === '' ? '' : index === revealed ? digit : '•';

        return (
          <input
            key={index}
            ref={(node) => {
              boxes.current[index] = node;
            }}
            // The field's `<label for>` points here, so clicking the label lands
            // the caret in the box typing starts in. Only the first: an id is
            // one element's.
            {...(index === 0 && field.controlId !== undefined ? { id: field.controlId } : {})}
            type="text"
            inputMode="numeric"
            // Not `type="password"`: a browser that decides a password field is
            // worth remembering would offer to save one sixth of a PIN.
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            // Two characters' room, because a controlled box already holding a
            // mask has to be able to receive the keystroke that replaces it.
            maxLength={2}
            aria-label={`digit ${index + 1} of ${length}`}
            {...(field.invalid ? { 'aria-invalid': true as const } : {})}
            value={shown}
            disabled={disabled}
            autoFocus={autoFocus && index === 0}
            onChange={(event) => write(index, event.target.value)}
            onKeyDown={(event) => keyDown(index, event)}
            onPaste={(event) => paste(index, event)}
            onFocus={(event) => {
              // Pulled back to the end of what has been typed, so there is never
              // a caret in a box the value cannot reach. Selecting is what makes
              // typing over a filled box replace it rather than append.
              const at = entryIndex(value, index, length);
              if (at !== index) move(at);
              else event.currentTarget.select();
            }}
            className={cn(
              INPUT_BASE,
              'h-12 min-w-0 flex-1 px-0 text-center font-mono text-lg',
              // `focus` as well as the `focus-visible` INPUT_BASE already
              // carries: a caret moved by this component's own key handling is
              // not always a "visible" focus to the browser, and six identical
              // wells side by side are unusable if the one being typed into is
              // not the one that looks different.
              'focus:border-fg-subtle',
              // The caret would sit beside a centred single character and read
              // as a seventh box. The border is what says where typing lands.
              'caret-transparent selection:bg-transparent',
            )}
          />
        );
      })}
    </div>
  );
}
