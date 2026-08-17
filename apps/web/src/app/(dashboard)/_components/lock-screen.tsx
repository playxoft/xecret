'use client';

import { useState } from 'react';

import { PIN_LENGTH } from '@xecret/core/auth';
import { api, endSession, errorMessage, isApiError, SIGN_IN_PATH } from '@/lib/api';
import { PinInput } from '@/components/auth/pin-input';
import { Wordmark } from '@/components/layout';
import { Alert, Button, LockIcon, ShieldCheckIcon } from '@/components/ui';
import type { PinResetResult, PinStatus } from './session';

/**
 * The screen between a signed-in session and the secrets it can reach.
 *
 * ── Three states, one component ──
 * A session arrives here in exactly one of three conditions, and conflating any
 * two of them produces a screen that asks the wrong question:
 *
 *  - **No PIN yet.** First sign-in. Choose one, twice.
 *  - **Locked.** A PIN exists; enter it.
 *  - **Resetting.** A link from the account's mailbox has been opened.
 *
 * ── Why the whole dashboard is behind this ──
 * Not because the server needs it to be — every gated route refuses a locked
 * session on its own, so a client that skipped this screen would simply see a
 * page of failed requests. It is here because a dashboard rendering empty tables
 * and error toasts is a worse way to learn you are locked than being told.
 *
 * ── What this screen never does ──
 * It does not offer "remember this device", because a lock you can permanently
 * dismiss is not a lock. It does not show how many attempts remain — that would
 * tell somebody guessing exactly how much room they have left, and the person
 * who knows their own PIN does not need a countdown. And it always offers a way
 * out: sign out, and reset by email, so no-one is ever stuck behind it.
 */

export interface LockScreenProps {
  status: PinStatus;
  email: string;
  /** Re-reads `/api/auth/me`, which is what actually dismisses this screen. */
  onUnlocked: () => void;
}

type Mode = 'unlock' | 'setup' | 'reset';

export function LockScreen({ status, email, onUnlocked }: LockScreenProps) {
  const [mode, setMode] = useState<Mode>(status.configured ? 'unlock' : 'setup');

  return (
    <div className="bg-canvas flex min-h-dvh flex-col">
      <header className="border-line flex h-[var(--topbar-height)] shrink-0 items-center border-b px-4 sm:px-6">
        <Wordmark />
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12 sm:px-6">
        {mode === 'setup' ? (
          <SetupPanel email={email} onDone={onUnlocked} />
        ) : mode === 'reset' ? (
          <ResetPanel email={email} onCancel={() => setMode('unlock')} />
        ) : (
          <UnlockPanel email={email} onDone={onUnlocked} onForgot={() => setMode('reset')} />
        )}
      </main>
    </div>
  );
}

function PanelFrame({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-line bg-surface rounded-xl border p-6 sm:p-8">
      <div className="flex flex-col items-center text-center">
        <span
          aria-hidden="true"
          className="bg-canvas-inset text-fg-muted mb-4 grid size-11 place-items-center rounded-full"
        >
          {icon}
        </span>
        <h1 className="text-fg text-lg font-medium">{title}</h1>
        <p className="text-fg-muted mt-1.5 text-sm leading-6">{description}</p>
      </div>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function UnlockPanel({
  email,
  onDone,
  onForgot,
}: {
  email: string;
  onDone: () => void;
  onForgot: () => void;
}) {
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
    <PanelFrame
      icon={<LockIcon className="size-5" />}
      title="Enter your PIN"
      description={`Signed in as ${email}. Your PIN unlocks xecret on this device for the next 8 hours.`}
    >
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

      <Footer>
        <button type="button" onClick={onForgot} className="hover:text-fg underline">
          Forgot your PIN?
        </button>
      </Footer>
    </PanelFrame>
  );
}

function SetupPanel({ email, onDone }: { email: string; onDone: () => void }) {
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
    <PanelFrame
      icon={<ShieldCheckIcon className="size-5" />}
      title="Choose a PIN"
      description={`You stay signed in as ${email} for 30 days. A ${PIN_LENGTH}-digit PIN keeps your secrets closed if someone else reaches your screen.`}
    >
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
          Set my PIN
        </Button>

        <Alert tone="info" title="If you forget it">
          We will email a reset link to {email}. There is no way to recover a PIN without access to
          that mailbox — nobody at xecret can read it, because only a derived hash is stored.
        </Alert>
      </form>
    </PanelFrame>
  );
}

/**
 * Requesting a reset link.
 *
 * The request is made from an authenticated session, so no email address is
 * accepted or shown as a choice — it goes to the address on the account and
 * nowhere else. That is what makes this flow free of the usual "if that address
 * exists…" evasion: there is no stranger to protect a secret from, because a
 * stranger cannot get here.
 */
function ResetPanel({ email, onCancel }: { email: string; onCancel: () => void }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setState('sending');
    setError(null);
    try {
      const result = await api.post<PinResetResult>('/auth/pin/reset');
      // `sent: false` is a successful request with an unhappy answer — either
      // mail is not configured on this deployment, or the provider refused the
      // send. Reporting "check your email" would leave somebody watching an
      // inbox nothing will ever arrive in, and this screen is where that costs
      // the most: whoever is reading it is already locked out.
      if (!result.sent) {
        setError(result.reason ?? 'A reset link could not be sent.');
        setState('idle');
        return;
      }
      setState('sent');
    } catch (cause) {
      setError(errorMessage(cause));
      setState('idle');
    }
  }

  if (state === 'sent') {
    return (
      <PanelFrame
        icon={<ShieldCheckIcon className="size-5" />}
        title="Check your email"
        description={`We sent a link to ${email}. It works once and expires in 15 minutes.`}
      >
        <Button variant="secondary" className="w-full" onClick={onCancel}>
          Back to the PIN screen
        </Button>
        <Footer>
          Opening the link in this browser will let you choose a new PIN straight away.
        </Footer>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame
      icon={<LockIcon className="size-5" />}
      title="Reset your PIN"
      description={`We will email a link to ${email}. Opening it lets you choose a new PIN.`}
    >
      <div className="flex flex-col gap-3">
        {error !== null ? (
          <Alert tone="danger" title="Could not send the email">
            {error}
          </Alert>
        ) : null}

        <Button variant="primary" loading={state === 'sending'} onClick={() => void send()}>
          Email me a reset link
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Back
        </Button>
      </div>
    </PanelFrame>
  );
}

/**
 * The way out, on every panel.
 *
 * Signing out has to work for somebody who cannot remember their PIN — otherwise
 * the lock screen is a trap rather than a lock. `DELETE /api/auth/session` is a
 * public route for exactly this reason, so it succeeds from a locked session.
 */
function Footer({ children }: { children?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await endSession();
    } finally {
      // Regardless of the outcome. A failed revoke still leaves a browser that
      // should stop presenting the cookie, and the sign-in page is the one
      // place from which everything is recoverable.
      window.location.assign(SIGN_IN_PATH);
    }
  }

  return (
    <div className="text-fg-subtle mt-5 space-y-2 text-center text-sm leading-5">
      {children ? <p>{children}</p> : null}
      <p>
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={busy}
          className="hover:text-fg underline"
        >
          Sign out instead
        </button>
      </p>
    </div>
  );
}
