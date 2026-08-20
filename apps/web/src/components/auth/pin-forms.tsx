'use client';

import { useState } from 'react';

import { PIN_LENGTH } from '@xecret/core/auth';
import { api, errorMessage, isApiError } from '@/lib/api';
import { PinInput } from '@/components/auth/pin-input';
import { Button } from '@/components/ui';

/**
 * The two forms that open a locked session: enter the PIN, or choose the first
 * one.
 *
 * ── Why they are not part of the lock screen ──
 * The lock screen is one place a session is found locked; it is not the only
 * one. `xecret login` sends the browser to the consent screen, and a session
 * that has just signed in has never been unlocked — so that screen used to
 * refuse the approval and link to the dashboard, making the user leave a page
 * they had been sent to on purpose, unlock somewhere else, and come back. Both
 * screens now ask for the PIN where the user already is, which only works if
 * "ask for a PIN" is a form rather than a page.
 *
 * These are bodies, not screens: no heading, no icon, no way out. The caller
 * frames them, because the framing is the part that differs — a full-height
 * panel with a sign-out link on the dashboard, a paragraph inside the consent
 * card on the CLI screen.
 *
 * Both call `onDone` only after the server has agreed. The caller's job there
 * is to re-read `GET /api/auth/me`: this is the request that changes what that
 * route answers, and nothing on screen should be derived from the assumption
 * that it worked.
 */

export interface PinUnlockFormProps {
  /** Called after the session is unlocked. Re-read `/auth/me` from here. */
  onDone: () => void;
  autoFocus?: boolean;
  submitLabel?: string;
}

export function PinUnlockForm({
  onDone,
  autoFocus = true,
  submitLabel = 'Unlock',
}: PinUnlockFormProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(candidate: string) {
    if (busy || candidate.length !== PIN_LENGTH) return;
    setBusy(true);
    setError(null);

    try {
      await api.post('/auth/pin/unlock', { pin: candidate });
      onDone();
    } catch (cause) {
      // Cleared on failure so the next attempt starts from an empty field
      // rather than requiring six backspaces.
      setPin('');
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(pin);
      }}
      className="flex flex-col gap-4"
    >
      <PinInput
        label="PIN"
        value={pin}
        onChange={(next) => {
          setPin(next);
          setError(null);
        }}
        onComplete={(next) => void submit(next)}
        disabled={busy}
        invalid={error !== null}
        autoFocus={autoFocus}
      />

      {error !== null ? (
        <p role="alert" className="text-danger-text text-center text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" loading={busy} disabled={pin.length !== PIN_LENGTH}>
        {submitLabel}
      </Button>
    </form>
  );
}

export interface PinSetupFormProps {
  /** Called after the PIN is stored — which also unlocks the session. */
  onDone: () => void;
  autoFocus?: boolean;
  submitLabel?: string;
}

export function PinSetupForm({
  onDone,
  autoFocus = true,
  submitLabel = 'Set my PIN',
}: PinSetupFormProps) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Confirmed in the browser before the request, because "the two PINs do not
  // match" is not the server's business — it has one PIN and no way to know the
  // user typed a different one the first time.
  const mismatch = confirm.length === PIN_LENGTH && confirm !== pin;
  const ready = pin.length === PIN_LENGTH && confirm === pin;

  async function submit() {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);

    try {
      await api.post('/auth/pin', { pin });
      onDone();
    } catch (cause) {
      // The weak-PIN rules live on the server and are reported per field, so
      // the specific reason — too common, six in a row — reaches the user
      // rather than a generic refusal.
      const fields = isApiError(cause) ? cause.fieldErrors() : {};
      setError(fields['pin'] ?? errorMessage(cause));
      setPin('');
      setConfirm('');
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-5"
    >
      <div className="flex flex-col gap-2">
        <p className="text-fg-muted text-center text-sm font-medium">Choose a PIN</p>
        <PinInput
          label="New PIN"
          value={pin}
          onChange={(next) => {
            setPin(next);
            setError(null);
          }}
          disabled={busy}
          autoFocus={autoFocus}
        />
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-fg-muted text-center text-sm font-medium">Enter it again</p>
        <PinInput
          label="Confirm PIN"
          value={confirm}
          onChange={(next) => {
            setConfirm(next);
            setError(null);
          }}
          onComplete={() => void submit()}
          disabled={busy || pin.length !== PIN_LENGTH}
          invalid={mismatch}
        />
      </div>

      {mismatch ? (
        <p role="alert" className="text-danger-text text-center text-sm">
          Those two PINs are different.
        </p>
      ) : error !== null ? (
        <p role="alert" className="text-danger-text text-center text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
        {submitLabel}
      </Button>
    </form>
  );
}
