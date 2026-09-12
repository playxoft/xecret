'use client';

import { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { DEVICE_PIN_LENGTH } from '@xecret/core/crypto/client';

import { cn } from '@/lib/cn';
import { INPUT_BASE, useFieldControl } from '@/components/ui';
import { caretBox, maskedBoxes, pinDigits, revealedBox } from './pin-entry';

/**
 * Six digits, in six boxes, on both screens that ask for them.
 *
 * ── Why one component for the lock screen and the settings form ──
 * Because a PIN entry is mostly rules, and three copies of a rule is three
 * chances to disagree about what a paste or a `Backspace` does. The lock screen
 * and the two enrolment fields differ in exactly one behaviour — the sixth digit
 * submits on one of them and does not on the other two — and that difference is
 * a callback ({@link PinInputProps.onComplete}), not a fork.
 *
 * ── One input, six painted boxes ──
 * This was six real `<input>`s once, one per digit, and it dropped keystrokes.
 * Typing `274` at a normal speed reliably landed two digits: each keystroke set
 * state, and the re-render and the `.focus()` that moved the caret to the next
 * box raced the next `keydown`, which was delivered to whichever element the
 * browser thought was focused at that instant. Every fix for that is a bigger
 * pile of focus bookkeeping around the same design fault — a text field that
 * only holds one character has to hand the caret on, and handing the caret on
 * cannot be made atomic with respect to the user's fingers.
 *
 * So there is one real input. It holds the whole value, it never loses focus
 * while somebody is typing into it, and insertion, deletion, selection,
 * `Backspace`, the arrow keys, paste, autofill and the IME are all the browser's
 * own behaviour on one ordinary text field. The six boxes below it are
 * `aria-hidden` paint: they read characters out of the value and light the one
 * the caret is in front of. Nothing in the render path can eat a keystroke,
 * because nothing in the render path touches focus.
 *
 * The input is laid over the boxes at zero opacity rather than hidden off
 * screen, so a click anywhere in the group lands on the control itself — no
 * `onClick` forwarding, and no case where the visible thing and the focused
 * thing are different elements.
 *
 * ── The masking, and the half-second ──
 * The typed digit is shown while it is being typed and hidden shortly after,
 * which is the pattern every phone lock screen uses: it is the only feedback
 * that distinguishes "I pressed 4" from "the keyboard missed that", and six
 * identical dots appearing under your fingers is how people give up on PIN
 * fields. The reveal is withdrawn the instant another digit lands as well as on
 * the timer, so at most one digit is ever legible over a shoulder. It is now
 * purely display state — a late timer repaints a dot and can no longer interfere
 * with what is being typed.
 *
 * ── Why the real input is a password field ──
 * Because it is the only thing in this component a screen reader can see, and a
 * `type="text"` field holding six digits is a field whose contents assistive
 * technology reads out — a PIN spoken aloud by the machine it unlocks, and six
 * digits of plaintext sitting in the accessibility tree for anything with a
 * handle on it. `password` is what stops both, and it costs nothing: the field
 * is invisible anyway, and the boxes above it do the masking a sighted person
 * sees. `autoComplete="off"` is what keeps the browser from offering to remember
 * it — the risk that argued for `text` before the accessibility one was weighed
 * against it.
 *
 * ── What is deliberately *not* here ──
 * `autoComplete="one-time-code"`. This is a PIN, not an OTP: the iOS and Android
 * heuristics behind that value offer to fill it from an SMS the user never
 * received, and a password manager that decided to remember six digits would put
 * the one credential this product cannot re-derive into a vault we do not
 * control. `off`, and nothing else.
 *
 * ── Why nothing here reads `event.key` ──
 * Because on Android it is a lie. GBoard reports most keys as `Unidentified`
 * with `keyCode` 229, backspace included, so a component that implemented
 * deletion by watching for `'Backspace'` is a component with no working delete
 * key on a phone. Every state change below is derived from the input's *value*,
 * which is the one thing every keyboard, IME, autofill and paste path agrees
 * on.
 */

/** How long a digit stays legible. Long enough to read, short enough to miss. */
const REVEAL_MS = 500;

export interface PinInputProps {
  /** The digits typed so far. Always a prefix of the six. */
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
  /**
   * The real input, for a host that has to hand the caret back.
   *
   * The lock screen needs it: its two credential screens swap without
   * unmounting, so returning to the PIN is not a mount and `autoFocus` never
   * fires again.
   */
  ref?: Ref<HTMLInputElement> | undefined;
}

/**
 * Keeps the caret at the end of the value.
 *
 * The boxes can only render a prefix, so a caret parked in the middle would
 * insert a digit somewhere the group cannot show. At module scope because it
 * touches nothing but the node it is given, which keeps it out of every effect's
 * dependency list.
 */
function pinCaret(node: HTMLInputElement | null): void {
  if (node === null) return;
  const end = node.value.length;
  if (node.selectionStart !== end || node.selectionEnd !== end) node.setSelectionRange(end, end);
}

export function PinInput({
  value,
  onChange,
  onComplete,
  length = DEVICE_PIN_LENGTH,
  disabled = false,
  autoFocus = false,
  className,
  ref,
}: PinInputProps) {
  // The ordinary field wiring: the enclosing `Field`'s id, its `aria-describedby`
  // and its `aria-invalid` all belong to the one control that really exists.
  const fieldProps = useFieldControl();
  const input = useRef<HTMLInputElement>(null);

  const [focused, setFocused] = useState(false);

  /**
   * Which box is showing its digit rather than a dot, and the timer that ends
   * it.
   *
   * A ref beside the state because the timer has to be cancellable from the next
   * keystroke and from unmount — a `setTimeout` outliving this component would
   * call `setRevealed` on something that is gone, which on the lock screen
   * happens every single time a PIN succeeds.
   */
  const [revealed, setRevealed] = useState<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );

  // After every change, including one the host made: the value shrinking under
  // a caret that was past the new end is exactly the state a cleared entry is
  // in.
  useEffect(() => {
    pinCaret(input.current);
  }, [value]);

  /**
   * The caret, handed back after the host empties a filled entry.
   *
   * A wrong PIN on the lock screen clears the value *and* passes `disabled`
   * while the attempt is in flight — and a browser blurs a control that becomes
   * disabled, so by the time the boxes come back the keyboard types nowhere.
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
    input.current?.focus();
  }, [value, disabled]);

  function reveal(index: number | null) {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    setRevealed(index);
    if (index === null) return;
    hideTimer.current = setTimeout(() => setRevealed(null), REVEAL_MS);
  }

  function change(event: React.ChangeEvent<HTMLInputElement>) {
    const raw = event.target.value;
    const next = pinDigits(raw, length);

    // The control is controlled, but React re-renders nothing when the filtered
    // value is unchanged — which is precisely the case where a rejected
    // character was typed. Putting the sanitised string back on the node is what
    // stops a stray `a` sitting in the field, invisibly, in front of the caret.
    if (raw !== next) {
      event.target.value = next;
      pinCaret(event.target);
    }

    reveal(revealedBox(value, next));
    if (next === value) return;

    onChange(next);
    if (next.length === length) onComplete?.(next);
  }

  const active = caretBox(value, length);
  const invalid = fieldProps['aria-invalid'] === true;

  return (
    <div className={cn('relative w-fit', className)}>
      {/* Paint. The control is the input below; these exist so six digits look
          like six digits, and a screen reader is told about them exactly once —
          by the field's own label, on the thing that actually has the value. */}
      <div aria-hidden="true" className="flex items-center gap-2">
        {maskedBoxes(value, revealed, length).map((glyph, index) => (
          <div
            key={index}
            className={cn(
              INPUT_BASE,
              'grid size-12 shrink-0 place-items-center font-mono text-lg leading-none',
              // `INPUT_BASE`'s own `disabled:` and `aria-[invalid]:` variants
              // cannot match a `div`, so both states are spelled out here from
              // the same tokens rather than left silently unstyled.
              invalid && 'border-danger',
              disabled && 'bg-surface-hover text-fg-disabled',
              // The box the next digit lands in, drawn with the same outline the
              // rest of the product uses for focus — on the box rather than on
              // the transparent input, which is the whole point of the overlay.
              focused &&
                !disabled &&
                index === active &&
                'border-fg-subtle outline-2 outline-offset-2 outline-[var(--ring)]',
            )}
          >
            {glyph}
          </div>
        ))}
      </div>

      <input
        // The field's id, `aria-describedby` and `aria-invalid` land on the one
        // element that can be focused and therefore the one whose description a
        // screen reader will read. A hint or an error hung on the wrapper around
        // the boxes is a message nothing ever announces.
        {...fieldProps}
        ref={(node) => {
          input.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref !== null && ref !== undefined) ref.current = node;
        }}
        // `password`, so assistive technology never has the digits. See above.
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={length}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={change}
        onFocus={() => {
          setFocused(true);
          pinCaret(input.current);
        }}
        onBlur={() => setFocused(false)}
        // Fired by React for caret movement as well as for a selection, so a
        // click into the middle of the field is pulled back to the end before
        // anything can be typed there.
        onSelect={() => pinCaret(input.current)}
        // Invisible rather than off screen, and the full size of the boxes: a
        // click anywhere in the group lands on the control itself. The text is
        // hidden by the opacity — including the caret, and including the focus
        // outline, which is drawn on the active box instead.
        className="absolute inset-0 size-full opacity-0"
      />
    </div>
  );
}
