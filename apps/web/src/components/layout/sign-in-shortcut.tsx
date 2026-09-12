'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

import { signInDestination } from '@/lib/session-hint';
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
