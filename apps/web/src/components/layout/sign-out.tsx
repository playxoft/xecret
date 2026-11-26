'use client';

import { useState } from 'react';

import { endSession, SIGN_IN_PATH } from '@/lib/api';
import { beginLeavingPage, beginSignInRedirect } from '@/lib/page-exit';
import { releaseVaultKeys } from '@/components/vault';
import { Button, LogOutIcon } from '@/components/ui';

/**
 * Signs this browser out and leaves the page — the one way out, shared by the
 * account menu and the frames the shell draws when it has no session to build
 * a menu from ("Could not load your account", no organisation left).
 *
 * Ends in a full navigation whatever the revoke answered; a failed revoke
 * still rejects afterwards, for a caller that wants to know.
 */
export async function signOutAndLeave(): Promise<void> {
  // First, before the revoke and before the keys are released: from here on
  // every 401 is expected, and neither the API client's sign-in redirect nor
  // the shell's re-read of the session may start a navigation that replaces
  // the one below (`lib/page-exit.ts`). Raised unconditionally because the
  // navigation below is unconditional too.
  //
  // In two stages. Until the revoke is confirmed the session may still be
  // live — offline, a 5xx — and staged edits may still be savable, so the
  // browser is still allowed to ask about leaving them. Only a confirmed
  // revoke makes this a departure on purpose, which nobody is asked about.
  beginSignInRedirect();
  // The sign-in page, unless the server answers WorkOS's logout URL for the
  // AuthKit session this one came from — which ends that too, and comes back
  // to the sign-in page itself.
  let destination = SIGN_IN_PATH;
  try {
    destination = await endSession();
    beginLeavingPage();
  } finally {
    // The keys first, and unconditionally. The navigation below throws the
    // document away, which disposes of them too — but only once it happens,
    // and this path is also reached when sign-out failed. A browser that has
    // decided it is signed out must not still be holding a User Key while it
    // gets there.
    releaseVaultKeys();

    // A full navigation rather than a router push. Every RSC payload cached
    // in this tab was rendered for a session that no longer exists, and the
    // only way to be certain none of it is reused is to throw the document
    // away. This runs even if sign-out threw: the cookie is already gone in
    // the common failure modes, and staying on a dashboard the user believes
    // they have left is the worse outcome.
    window.location.assign(destination);
  }
}

/**
 * A plain "Sign out" button, for a frame with no account menu to put it in —
 * so a page that could not load the account is never a page with no way out.
 */
export function SignOutButton() {
  const [signingOut, setSigningOut] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={signingOut}
      onClick={() => {
        setSigningOut(true);
        // The page is left either way; a failed revoke has nothing to add.
        void signOutAndLeave().catch(() => undefined);
      }}
    >
      <LogOutIcon className="size-4" />
      {signingOut ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
