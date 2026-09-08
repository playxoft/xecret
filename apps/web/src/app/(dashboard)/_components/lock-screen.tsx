'use client';

import { useState } from 'react';

import { endSession, SIGN_IN_PATH } from '@/lib/api';
import { Wordmark } from '@/components/layout';
import { Button, LockIcon, ShieldCheckIcon } from '@/components/ui';
import { releaseVaultKeys, VaultSetup, VaultUnlock } from '@/components/vault';
import type { SessionUser, VaultStatus } from './session';

/**
 * The screen between a signed-in session and the key material it can reach.
 *
 * Two states, and they are different screens rather than two modes of one:
 * an account with no vault is asked to *create* one, through the ceremony in
 * `components/vault/vault-setup.tsx`; an account with a locked one is asked to
 * open it. Collapsing them would mean a single form that sometimes creates a
 * vault and sometimes opens it, which is the shape of the mistake that
 * overwrites a key hierarchy — `POST /api/auth/vault` answers 409 rather than
 * overwriting for exactly that reason.
 *
 * ── Why the whole dashboard is behind this ──
 * Not because the server needs it to be — every gated route refuses a locked
 * session on its own, so a client that skipped this screen would simply see a
 * page of failed requests. It is here because a dashboard rendering empty tables
 * and error toasts is a worse way to learn you are locked than being told.
 *
 * ── What this screen must never do ──
 * It must not offer "remember this device", because a lock you can permanently
 * dismiss is not a lock. It must not show how many attempts remain — that would
 * tell somebody guessing exactly how much room they have left, and the person
 * who knows their own passphrase does not need a countdown. And it must always
 * offer a way out, which is the `Footer` below.
 */

export interface LockScreenProps {
  status: VaultStatus;
  user: SessionUser;
  /** Re-reads `/api/auth/me`, which is what actually dismisses this screen. */
  onUnlocked: () => void;
}

export function LockScreen({ status, user, onUnlocked }: LockScreenProps) {
  const configured = status.configured;

  return (
    <div className="bg-canvas flex min-h-dvh flex-col">
      <header className="border-line flex h-[var(--topbar-height)] shrink-0 items-center border-b px-4 sm:px-6">
        <Wordmark />
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12 sm:px-6">
        <PanelFrame
          icon={
            configured ? <LockIcon className="size-5" /> : <ShieldCheckIcon className="size-5" />
          }
          title={configured ? 'Your vault is locked' : 'Set up your vault'}
          description={
            configured
              ? `Signed in as ${user.email}. Unlocking decrypts your keys in this browser — xecret never sees your passphrase.`
              : `Signed in as ${user.email}. A master passphrase encrypts everything you store, on your device, before it leaves it.`
          }
        >
          <div className="flex flex-col gap-6">
            {configured ? (
              <VaultUnlock user={user} onUnlocked={onUnlocked} />
            ) : (
              <VaultSetup user={user} onComplete={onUnlocked} />
            )}

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
      // Before the navigation and regardless of the outcome. A failed revoke
      // still leaves a browser that should stop presenting the cookie — and one
      // that must not be carrying a User Key into whatever it renders next.
      releaseVaultKeys();
      window.location.assign(SIGN_IN_PATH);
    }
  }

  return (
    <Button variant="ghost" loading={busy} onClick={() => void signOut()}>
      Sign out
    </Button>
  );
}
