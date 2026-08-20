'use client';

import { useState } from 'react';

import { PIN_LENGTH } from '@xecret/core/auth';
import { api, errorMessage, isApiError } from '@/lib/api';
import { PinInput } from '@/components/auth/pin-input';
import { Button } from '@/components/ui';

/**
 * The two forms that open a locked session: enter the PIN, or choose one.
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
 * ── Where the request lives ──
 * `PinUnlockForm` owns its request: there is one way to unlock a session and
 * one thing to do afterwards. `PinChooseForm` does not, because the same two
 * fields set a first PIN (`POST /auth/pin`) and spend an emailed reset link
 * (`POST /auth/pin/reset/confirm`), and that third page was a third copy of
 * this form. So the caller says what to do with the PIN and this keeps the part
 * that was actually being copied: the confirmation, the server's per-field
 * reason, and a button that is busy for exactly as long as the work lasts.
 *
 * ── Busy outlives the response ──
 * Both forms stay busy until the *caller* is finished, not until the server
 * answers. Both screens keep the form mounted while they re-read
 * `GET /api/auth/me` — that request is what dismisses them — so clearing it any
 * earlier shows an idle form on a page still working, and clearing it only on
 * failure (which is what these did when the lock screen was their only caller,
 * and unmounted them the instant the PIN was accepted) leaves a spinner nothing
 * can stop when the re-read is the thing that fails.
 */

export interface PinUnlockFormProps {
  /** Called after the session is unlocked. Re-read `/auth/me` from here. */
  onDone: () => void | Promise<void>;
}

export function PinUnlockForm({ onDone }: PinUnlockFormProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(candidate: string) {
    if (busy || candidate.length !== PIN_LENGTH) return;
    setBusy(true);
    setError(null);

    try {
      await api.post('/auth/pin/unlock', { pin: candidate });
    } catch (cause) {
      // Cleared on failure so the next attempt starts from an empty field
      // rather than requiring six backspaces.
      setPin('');
      setError(errorMessage(cause));
      setBusy(false);
      return;
    }

    // Accepted. What the caller does next is still this form's wait.
    try {
      await onDone();
    } finally {
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
        autoFocus
      />

      {error !== null ? (
        <p role="alert" className="text-danger-text text-center text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" loading={busy} disabled={pin.length !== PIN_LENGTH}>
        Unlock
      </Button>
    </form>
  );
}

export interface PinChooseFormProps {
  /**
   * Sends the chosen PIN and does whatever follows it — a session re-read, a
   * navigation. Rejecting shows the reason and empties both fields; a `pin`
   * field error is preferred to the generic message, because the weak-PIN rules
   * live on the server and "too common" is worth more than "invalid".
   */
  submit: (pin: string) => Promise<void>;
}

export function PinChooseForm({ submit }: PinChooseFormProps) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Confirmed in the browser before the request, because "the two PINs do not
  // match" is not the server's business — it has one PIN and no way to know the
  // user typed a different one the first time.
  const mismatch = confirm.length === PIN_LENGTH && confirm !== pin;
  const ready = pin.length === PIN_LENGTH && confirm === pin;

  async function send() {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);

    try {
      await submit(pin);
    } catch (cause) {
      const fields = isApiError(cause) ? cause.fieldErrors() : {};
      setError(fields['pin'] ?? errorMessage(cause));
      setPin('');
      setConfirm('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="flex flex-col gap-5"
    >
      <div className="flex flex-col gap-2">
        <p className="text-fg-muted text-center text-sm font-medium">New PIN</p>
        <PinInput
          label="New PIN"
          value={pin}
          onChange={(next) => {
            setPin(next);
            setError(null);
          }}
          disabled={busy}
          autoFocus
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
          onComplete={() => void send()}
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
        Set my PIN
      </Button>
    </form>
  );
}

/**
 * Storing a first or replacement PIN, which also unlocks the session.
 *
 * Exported so the two callers that use this endpoint name it once between them
 * rather than each spelling out a path; the reset page has its own, because it
 * spends a token instead.
 */
export function storePin(pin: string): Promise<unknown> {
  return api.post('/auth/pin', { pin });
}
