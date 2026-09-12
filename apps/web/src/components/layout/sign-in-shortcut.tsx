'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useSyncExternalStore } from 'react';
import type { ComponentPropsWithoutRef } from 'react';

import { signInDestination, SIGN_IN_PATH } from '@/lib/session-hint';
import { SIGN_IN_SHORTCUT_KEYS } from '@/lib/site';
import { useGlobalShortcut } from './use-nav-shortcuts';

/**
 * The chord, as `useGlobalShortcut` wants it: a `KeyboardEvent.code`.
 *
 * Derived from the cap `SiteHeader` prints rather than written out again, so the
 * key advertised and the key bound cannot come apart. `codeFor` in
 * `use-nav-shortcuts.ts` does the same translation for the sidebar's chords; one
 * letter needs no table.
 */
const SIGN_IN_CHORD = `Key${SIGN_IN_SHORTCUT_KEYS[0]}` as const;

/**
 * Makes `S` on the landing page open the sign-in screen — or the dashboard, if
 * the visitor already has a session.
 *
 * Renders nothing. The visible half is the button in `SiteHeader`, which stays
 * a server-rendered anchor: splitting the listener out keeps the chrome's
 * markup free and costs the reader one small island rather than a client
 * component wrapped around the header's only call to action.
 *
 * ── Why an unmodified letter is acceptable *here* ──
 * `useNavShortcuts` explains at length why bare letters are a hostile thing to
 * claim in this product: the dashboard is where people hand-edit secret values,
 * and a stolen `S` is indistinguishable from data loss. None of that applies to
 * a prerendered marketing page, which has no field worth losing a character
 * from — and `useGlobalShortcut` stands down on the ones it does have anyway,
 * inputs and overlays alike, because the guards are shared rather than
 * restated.
 *
 * ── Where it sends people ──
 * Decided at the keypress rather than at render, so a visitor who signs in in
 * another tab and comes back to this one gets the dashboard rather than a
 * destination baked in before they had a session. `signInDestination` reads the
 * CSRF cookie to make that call; the note on it covers what happens when the
 * guess is stale, and why it is not a security boundary.
 */
export function SignInShortcut() {
  const router = useRouter();

  const go = useCallback(() => {
    router.push(signInDestination());
  }, [router]);

  useGlobalShortcut(SIGN_IN_CHORD, go);

  return null;
}

function subscribeToNothing(): () => void {
  // A cookie cannot announce itself, and nothing in this tab writes one: the
  // page this renders on is prerendered marketing chrome. A visitor who signs
  // in elsewhere and comes back gets a fresh render anyway.
  return () => {};
}

function destinationSnapshot(): string {
  return signInDestination();
}

function serverDestination(): string {
  return SIGN_IN_PATH;
}

/**
 * The visible half of the same offer: the header's sign-in button, pointed
 * wherever `S` would take you.
 *
 * The two used to disagree. The button is server-rendered and could only ever
 * name `/sign-in`, while the shortcut asked `signInDestination()` at the
 * keypress — so on the landing page a visitor who already had a session was
 * sent to the dashboard by the key and to the sign-in screen by the button
 * beside it, which then redirected. One of them advertised the wrong
 * destination in the status bar, and it was the one people click.
 *
 * `useSyncExternalStore` for the same reason `useModKey` uses it: there is no
 * cookie to read during a prerender, so the destination is `/sign-in` in the
 * HTML and during hydration, and the hint takes over on the commit after. No
 * setState in an effect, and no mismatch on the most-visited page in the
 * product.
 *
 * Props are forwarded because `Button asChild` clones this element with the
 * class names and `aria-` attributes the button contributes.
 */
export function SignInLink({
  children,
  ...rest
}: Omit<ComponentPropsWithoutRef<typeof Link>, 'href'>) {
  const href = useSyncExternalStore(subscribeToNothing, destinationSnapshot, serverDestination);

  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}
