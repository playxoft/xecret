'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { Button, CheckIcon, CloseIcon, EyeIcon, EyeOffIcon, Field, Input } from '@/components/ui';
import { estimatePassphrase, PASSPHRASE_MIN_LENGTH, PASSPHRASE_MIN_SCORE } from './passphrase';
import type { PassphraseStrength } from './passphrase';

/**
 * The "choose a passphrase" pair of fields, and the estimate that judges them.
 *
 * Used in three places that are the same act seen from three angles — setting
 * one up, changing it, and being forced to replace it after a recovery — so the
 * bar, the wording and the feedback are identical in all three. A change form
 * that judged a passphrase differently from the setup form would be a way to end
 * up with a weaker one than the ceremony would ever have accepted.
 *
 * ── Why the estimate is a hook the *parent* calls ──
 * Because the parent owns the gate. `setupStepProblem` and the change form's
 * submit handler both read the score to decide whether to proceed. Having the
 * meter compute it and report upward through a callback would mean this
 * component setting its parent's state from an effect — a cascading render, and
 * one where the parent's gate briefly disagrees with what is on screen. So
 * {@link usePassphraseStrength} is called above, and the verdict travels *down*
 * as a prop, in one direction, with one owner.
 */

/**
 * The latest estimate for `passphrase`, or `null` while there is not one yet.
 *
 * ── Why the result is keyed by the passphrase it describes ──
 * The dictionaries are a lazy import and the estimate is not instant, so an
 * answer can land after a newer keystroke. Storing *which* passphrase each
 * verdict is about, and treating a mismatch as "no verdict", is what stops the
 * gate being opened by the score of a shorter, weaker prefix — a stale `score:
 * 4` for the first twenty characters of a string the user has since deleted half
 * of. A `cancelled` flag alone would not close that window, because the stale
 * value would still be in state.
 *
 * `userInputs` should carry the account's own email and name: a passphrase built
 * out of them is exactly as guessable as they are public, and zxcvbn only knows
 * that if it is told.
 */
export function usePassphraseStrength(
  passphrase: string,
  userInputs: readonly string[] = [],
): PassphraseStrength | null {
  const [result, setResult] = useState<{ of: string; strength: PassphraseStrength } | null>(null);

  // Joined so the effect depends on a string rather than an array identity that
  // changes on every render of the caller.
  const inputsKey = userInputs.join('\u0000');

  // Judged only after a short pause in typing. The estimate is synchronous
  // once the dictionaries are in, and running it between every keystroke is
  // what made the field stutter; a verdict is only useful for a string the
  // user has stopped on anyway.
  const debounced = useDebouncedValue(passphrase, 180);

  useEffect(() => {
    if (debounced.length === 0) return;

    let cancelled = false;
    void estimatePassphrase(debounced, inputsKey.length > 0 ? inputsKey.split('\u0000') : []).then(
      (strength) => {
        if (!cancelled) setResult({ of: debounced, strength });
      },
      () => {
        // The dictionaries did not load. Nothing is recorded, so the verdict
        // stays `null` and the gate stays shut — the right direction to fail in
        // for a form that must not accept a passphrase nothing has judged.
      },
    );

    return () => {
      cancelled = true;
    };
  }, [debounced, inputsKey]);

  return result !== null && result.of === passphrase ? result.strength : null;
}

/** `value`, but only after it has held still for `delayMs`. */
function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export interface PassphraseFieldsProps {
  passphrase: string;
  onPassphrase: (value: string) => void;
  confirm: string;
  onConfirm: (value: string) => void;
  /** From {@link usePassphraseStrength}, called by whoever owns the gate. */
  strength: PassphraseStrength | null;
  /** Shown under the fields once the parent decides to show it. */
  problem?: string | null;
  labels?: { passphrase: string; confirm: string };
  autoFocus?: boolean;
}

const STRENGTH_LABELS = ['Very guessable', 'Guessable', 'Fair', 'Strong', 'Very strong'] as const;

/**
 * Red through green, with only the accepted score reaching green.
 *
 * Score 3 is deliberately *not* green: it is the score this product refuses, and
 * a meter that turned reassuring one notch before the gate opens would read as a
 * bug in the gate rather than as the honest "nearly" it is.
 */
const STRENGTH_TONES = [
  'bg-danger',
  'bg-danger',
  'bg-warning',
  'bg-warning',
  'bg-success',
] as const;

export function PassphraseFields({
  passphrase,
  onPassphrase,
  confirm,
  onConfirm,
  strength,
  problem = null,
  labels = { passphrase: 'Master passphrase', confirm: 'Confirm passphrase' },
  autoFocus = false,
}: PassphraseFieldsProps) {
  const empty = passphrase.length === 0;
  const [revealPassphrase, setRevealPassphrase] = useState(false);
  const [revealConfirm, setRevealConfirm] = useState(false);

  // What the meter *shows* is allowed to lag what the gate *knows*. The strict
  // verdict blanks on every keystroke (see the hook), and a meter wired to it
  // directly flickered empty while the user typed. Holding the last verdict on
  // screen until the next one lands keeps the reading steady; the parent's
  // gate still reads the strict prop and stays shut in the gap.
  const [held, setHeld] = useState<PassphraseStrength | null>(null);
  useEffect(() => {
    if (strength !== null) setHeld(strength);
    else if (passphrase.length === 0) setHeld(null);
  }, [strength, passphrase]);

  const display = strength ?? (empty ? null : held);
  const score = display?.score ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <Field
        label={labels.passphrase}
        hint="A phrase of several unrelated words is the easiest kind to remember and the hardest to guess. Length beats punctuation."
        error={problem}
      >
        <Input
          type={revealPassphrase ? 'text' : 'password'}
          value={passphrase}
          onChange={(event) => onPassphrase(event.target.value)}
          autoComplete="new-password"
          autoFocus={autoFocus}
          spellCheck={false}
          endSlot={
            <RevealToggle
              visible={revealPassphrase}
              onToggle={() => setRevealPassphrase((current) => !current)}
            />
          }
        />
      </Field>

      {/* Rendered empty rather than not at all: the meter appearing on the
          first keystroke moved everything under it, and the fixed-width label
          exists for the same reason — the verdict changes, the layout must
          not. */}
      <div className="flex items-center gap-3">
        <div
          className="bg-canvas-inset flex h-1.5 flex-1 gap-1 overflow-hidden rounded-full"
          role="img"
          aria-label={
            empty ? 'Passphrase strength' : `Passphrase strength: ${STRENGTH_LABELS[score]}`
          }
        >
          {[0, 1, 2, 3, 4].map((step) => (
            <span
              key={step}
              className={cn(
                'h-full flex-1 rounded-full transition-colors',
                !empty && step <= score ? STRENGTH_TONES[score] : 'bg-line',
              )}
            />
          ))}
        </div>
        <span aria-hidden="true" className="text-fg-muted w-28 shrink-0 text-right text-sm">
          {empty ? '' : display === null ? 'Checking…' : STRENGTH_LABELS[score]}
        </span>
      </div>

      <Field label={labels.confirm}>
        <Input
          type={revealConfirm ? 'text' : 'password'}
          value={confirm}
          onChange={(event) => onConfirm(event.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          endSlot={
            <RevealToggle
              visible={revealConfirm}
              onToggle={() => setRevealConfirm((current) => !current)}
            />
          }
        />
      </Field>

      {/* The checklist lives *below* both inputs and every row is always
          rendered, so nothing the user types can add, remove, or move a line —
          rows only change colour. The estimator's one-line warning is the sole
          variable-height element, and it sits last for the same reason. */}
      <ul className="flex min-h-24 flex-col gap-1 text-sm leading-5">
        <ChecklistPoint met={passphrase.length >= PASSPHRASE_MIN_LENGTH}>
          At least {PASSPHRASE_MIN_LENGTH} characters
        </ChecklistPoint>
        <ChecklistPoint met={!empty && display !== null && score >= PASSPHRASE_MIN_SCORE}>
          Rated “Very strong” — hard for an attacker to guess
          {!empty && display !== null ? (
            <span className="text-fg-muted">
              {' '}
              {/* The offline figure, because that is the attack this product's
                  threat model actually describes — see `passphrase.ts`. */}
              (about {display.crackTime} to crack)
            </span>
          ) : null}
        </ChecklistPoint>
        <ChecklistPoint met={confirm.length > 0 && confirm === passphrase}>
          Both passphrases match
        </ChecklistPoint>
        {!empty && display !== null && display.warning !== null && score < PASSPHRASE_MIN_SCORE ? (
          <li className="text-warning-text pl-6">{display.warning}</li>
        ) : null}
      </ul>
    </div>
  );
}

/** One always-visible requirement row: grey ✗ until met, green ✓ after. */
function ChecklistPoint({ met, children }: { met: boolean; children: ReactNode }) {
  return (
    <li
      className={cn('flex items-start gap-2', met ? 'text-success-text' : 'text-fg-subtle')}
      aria-label={met ? 'Requirement met' : 'Requirement not met'}
    >
      {met ? (
        <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      ) : (
        <CloseIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      )}
      <span>{children}</span>
    </li>
  );
}

/** The eye. Reports its state via `aria-pressed`, like the sign-in form's. */
function RevealToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-7"
      onClick={onToggle}
      aria-pressed={visible}
      aria-label={visible ? 'Hide passphrase' : 'Show passphrase'}
    >
      {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
    </Button>
  );
}
