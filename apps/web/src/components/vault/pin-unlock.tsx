'use client';

import { useState } from 'react';
import { DEVICE_PIN_LENGTH } from '@xecret/core/crypto/client';

import { pluralize } from '@/lib/format';
import { Alert, Button, Field, Input } from '@/components/ui';
import { describePinUnlockFailure, unlockWithPin } from './vault-client';
import type { VaultMaterial } from './vault-client';

/**
 * Six digits, on the one browser that has enrolled them.
 *
 * ── What this is, next to the passphrase form below it ──
 * A shortcut, and never a replacement. The wrap it opens lives in this browser
 * and the other half of its key lives on the server, so this form can do nothing
 * on a machine that has not been enrolled — which is why it renders only when
 * `hasPinWrap()` is true, and why the passphrase form stays on screen underneath
 * rather than behind a "use another method" link.
 *
 * ── Why this screen *does* show attempts remaining ──
 * The rest of the lock screen deliberately does not: a countdown next to a
 * passphrase tells somebody guessing how much room they have, and the person who
 * knows their own passphrase has no use for it. A PIN inverts both halves of
 * that. Its entire security budget is five tries — the sixth does not exist, it
 * destroys the enrolment — so the number is not a hint about a search space, it
 * is the difference between "try again" and "you are about to lose this". And
 * the guesser is somebody holding the device, who will discover the limit on
 * their fifth attempt in any case.
 *
 * ── Auto-submit ──
 * At the sixth digit, because a PIN has exactly one length and asking for a
 * confirming click afterwards is a keystroke that carries no decision. The field
 * refuses anything that is not a digit rather than validating afterwards, so
 * there is no state in which six characters are present and the form will not go.
 */

export interface PinUnlockProps {
  user: { id: string };
  material: VaultMaterial;
  /** Re-reads the session, which is what actually dismisses the lock screen. */
  onUnlocked: () => void;
  /**
   * Called when this browser's PIN has stopped existing — burned, revoked
   * elsewhere, or holding a wrap that no longer matches the vault.
   *
   * The local record is already cleared by the time this fires. The host
   * withdraws the form and shows the sentence, rather than leaving an entry box
   * that can only fail.
   */
  onGone: (message: string) => void;
  /** True while the passphrase or passkey path is working. */
  disabled?: boolean;
}

export function PinUnlock({
  user,
  material,
  onUnlocked,
  onGone,
  disabled = false,
}: PinUnlockProps) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function attempt(entered: string) {
    if (busy || disabled) return;

    setBusy(true);
    setFailure(null);
    try {
      const result = await unlockWithPin({ userId: user.id, pin: entered, material });

      switch (result.outcome) {
        case 'unlocked':
          setPin('');
          onUnlocked();
          return;
        case 'wrong':
          setPin('');
          setFailure(
            `That PIN did not match. ${pluralize(result.attemptsRemaining, 'try', 'tries')} left ` +
              'before the PIN is switched off on this browser.',
          );
          return;
        case 'burned':
          onGone(
            'That was the fifth wrong PIN, so it is now switched off on this browser — the ' +
              'encrypted copy of your key here can never be opened again. Your master passphrase ' +
              'still works, and you can set a new PIN up afterwards.',
          );
          return;
        case 'unknown':
          onGone(
            'The PIN for this browser has been turned off. Use your master passphrase — you can ' +
              'set a new PIN up from Security afterwards.',
          );
          return;
        default:
          onGone(
            'This browser’s PIN no longer matches your vault, so it has been cleared. Use your ' +
              'master passphrase.',
          );
      }
    } catch (cause) {
      setPin('');
      setFailure(describePinUnlockFailure(cause));
    } finally {
      setBusy(false);
    }
  }

  function type(raw: string) {
    // Digits only, and never more than the PIN's length. Filtering on the way in
    // rather than validating on the way out is what makes the auto-submit below
    // safe: six characters in the field are always six digits.
    const digits = raw.replace(/\D/g, '').slice(0, DEVICE_PIN_LENGTH);
    setPin(digits);
    if (digits.length === DEVICE_PIN_LENGTH) void attempt(digits);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void attempt(pin);
      }}
      noValidate
      className="flex flex-col gap-3"
    >
      {failure !== null ? (
        <Alert tone="danger" title="That PIN did not open your vault">
          {failure}
        </Alert>
      ) : null}

      <Field label={`${DEVICE_PIN_LENGTH}-digit PIN for this browser`}>
        <Input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={DEVICE_PIN_LENGTH}
          value={pin}
          onChange={(event) => type(event.target.value)}
          autoComplete="off"
          autoFocus
          spellCheck={false}
          disabled={busy || disabled}
          className="font-mono tracking-[0.5em]"
        />
      </Field>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={busy}
        disabled={pin.length !== DEVICE_PIN_LENGTH || disabled}
      >
        Unlock with my PIN
      </Button>
    </form>
  );
}
