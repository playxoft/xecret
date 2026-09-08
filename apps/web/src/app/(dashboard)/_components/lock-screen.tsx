'use client';

import { useState } from 'react';

import { endSession, SIGN_IN_PATH } from '@/lib/api';
import { Wordmark } from '@/components/layout';
import { Alert, Button, LockIcon, ShieldCheckIcon } from '@/components/ui';
import type { VaultStatus } from './session';

/**
 * The screen between a signed-in session and the key material it can reach.
 *
 * ── Phase 2b: this is a placeholder, and deliberately inert ──
 * The PIN screen that stood here has been removed with the PIN itself (ADR 0009
 * §4.4). What replaces it is the vault UI — the setup ceremony, the passphrase
 * unlock form, the passkey button, the recovery-code flow and the in-memory key
 * store they all write into — and none of that exists yet. A follow-up owns it.
 *
 * This renders the two honest states and offers the one action that must always
 * work, rather than a half-built form that would appear to do something. The
 * server side is complete underneath it: `/api/auth/vault*` will accept
 * everything the real screen needs to send.
 *
 * ── Why the whole dashboard is behind this ──
 * Not because the server needs it to be — every gated route refuses a locked
 * session on its own, so a client that skipped this screen would simply see a
 * page of failed requests. It is here because a dashboard rendering empty tables
 * and error toasts is a worse way to learn you are locked than being told.
 *
 * ── What this screen must never do, once it is real ──
 * It must not offer "remember this device", because a lock you can permanently
 * dismiss is not a lock. It must not show how many attempts remain — that would
 * tell somebody guessing exactly how much room they have left, and the person
 * who knows their own passphrase does not need a countdown. And it must always
 * offer a way out, which is the part implemented below.
 */

export interface LockScreenProps {
  status: VaultStatus;
  email: string;
  /** Re-reads `/api/auth/me`, which is what actually dismisses this screen. */
  onUnlocked: () => void;
}

export function LockScreen({ status, email }: LockScreenProps) {
  return (
    <div className="bg-canvas flex min-h-dvh flex-col">
      <header className="border-line flex h-[var(--topbar-height)] shrink-0 items-center border-b px-4 sm:px-6">
        <Wordmark />
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12 sm:px-6">
        <PanelFrame
          icon={
            status.configured ? (
              <LockIcon className="size-5" />
            ) : (
              <ShieldCheckIcon className="size-5" />
            )
          }
          title={status.configured ? 'Your vault is locked' : 'Set up your vault'}
          description={
            status.configured
              ? `Signed in as ${email}. Unlocking decrypts your keys in this browser — xecret never sees your passphrase.`
              : `Signed in as ${email}. A master passphrase encrypts everything you store, on your device, before it leaves it.`
          }
        >
          <div className="flex flex-col gap-5">
            <Alert tone="info" title="This screen is being rebuilt">
              The unlock and setup flows are moving to end-to-end encryption. They are not available
              in this build.
            </Alert>

            <Footer />
          </div>
        </PanelFrame>
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

/**
 * The way out.
 *
 * Signing out has to work for somebody who cannot get past this screen —
 * otherwise the lock screen is a trap rather than a lock. `DELETE
 * /api/auth/session` is exempt from the lock gate for exactly this reason, so it
 * succeeds from a locked session.
 */
function Footer() {
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
    <Button variant="ghost" loading={busy} onClick={() => void signOut()}>
      Sign out
    </Button>
  );
}
