'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * The organisation this tab was last actually in.
 *
 * Two routes under `/app` name no organisation: the account area
 * (`/app/settings/*`) and the organisation picker. The shell still has to point
 * its sidebar, its switcher and its breadcrumb at something, and the only
 * answer that does not move the furniture underneath somebody is the
 * organisation they were working in a moment ago.
 *
 * ── Why not the first membership ──
 * `GET /api/auth/me` returns memberships ordered by name. Falling back to the
 * first of them means a member of Acme and Zebra, working in Zebra, opens their
 * account settings and finds the entire shell re-pointed at Acme — every
 * sidebar href, the switcher's label, and the admin gate with it. Clicking
 * "Projects" to get back to what they were doing would land them in a different
 * tenant's project list. A wrong organisation is worse than the empty sidebar
 * this replaced.
 *
 * ── Why `sessionStorage` ──
 * Holding the slug in React state alone would cover a click through the user
 * menu and nothing else: it does not survive a reload, so refreshing
 * `/app/settings/security` — a page with a button that re-reads the session, on
 * a screen people sit on — would quietly re-point the shell at whichever
 * organisation sorts first. `sessionStorage` is scoped to the tab, which is the
 * correct scope: two tabs open on two organisations must not overwrite each
 * other's idea of "here", which is exactly what `localStorage` would do.
 *
 * A fresh tab remembers nothing, and the caller falls back to the first
 * membership there. That case has no better answer available — nothing on the
 * client knows where a cold visitor came from.
 *
 * ── Why a store rather than state ──
 * The value lives outside React, in storage, and is written from a navigation
 * rather than from an event handler. `useSyncExternalStore` is the API that
 * reads such a thing with a correct server snapshot (`null` — there is no
 * storage there), a correct client snapshot, and no `setState` inside an
 * effect. The same reasoning is written out at greater length in `lib/theme.ts`,
 * which holds the theme and sidebar preferences the same way.
 *
 * The slug is a hint, never authority: the caller checks it against the
 * session's memberships before using it, so an organisation the viewer has
 * since been removed from cannot outlive their access, and every page behind
 * these links authorises on its own regardless.
 */

const STORAGE_KEY = 'xecret.last-org';

/**
 * @param orgSlug The organisation in the current URL, or `null` on the routes
 *   that have none. Returned unchanged when present — the URL always wins — and
 *   remembered for when it is not.
 */
export function useLastVisitedOrg(orgSlug: string | null): string | null {
  const lastVisited = useSyncExternalStore(subscribe, readLastVisitedOrg, serverSnapshot);

  useEffect(() => {
    if (orgSlug === null) return;
    rememberOrg(orgSlug);
  }, [orgSlug]);

  return orgSlug ?? lastVisited;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * There is no storage on the server, so the server render and the hydration
 * that has to match it both know nothing; React re-reads the real snapshot
 * straight afterwards. Nothing downstream is in the DOM by then anyway — the
 * shell is still showing its skeleton until `/api/auth/me` answers.
 */
function serverSnapshot(): string | null {
  return null;
}

/**
 * The tab's answer, mirrored in memory. Two reasons, both of them the store
 * contract rather than performance: `getSnapshot` has to return the same value
 * until something notifies, and `sessionStorage` throws in Safari's private
 * mode and inside sandboxed iframes — where the mirror still carries the slug
 * for as long as the page stays loaded, instead of losing the feature entirely.
 *
 * `undefined` means "not read yet", which is how the first read distinguishes
 * itself from a tab that has genuinely visited nothing.
 */
let remembered: string | null | undefined;

function readLastVisitedOrg(): string | null {
  if (remembered !== undefined) return remembered;
  if (typeof window === 'undefined') return null;

  try {
    remembered = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    remembered = null;
  }

  return remembered;
}

function rememberOrg(orgSlug: string): void {
  // Nothing to announce when the tab is already here, which is the common case:
  // this runs on every navigation, and most of them stay inside one
  // organisation.
  if (readLastVisitedOrg() === orgSlug) return;
  remembered = orgSlug;

  try {
    window.sessionStorage.setItem(STORAGE_KEY, orgSlug);
  } catch {
    // Not carried past this page load. The mirror above still answers.
  }

  for (const listener of listeners) listener();
}
