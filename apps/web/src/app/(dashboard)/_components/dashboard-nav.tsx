'use client';

import { useMemo } from 'react';

import { appPath } from '../_lib/paths';
import { BoxIcon, FileTextIcon, SettingsIcon, TerminalIcon, UsersIcon } from '@/components/ui';
import type { NavSection } from '@/components/layout';
import { canAdminister } from './session';
import type { SessionOrganization } from './session';

/**
 * The sidebar's contents.
 *
 * ── Derived from the URL, and nothing else ──
 * Every item is known before any request has resolved, so the sidebar is right
 * on the first paint of a cold navigation and costs nothing. It used to read the
 * organisation's project list as well, to unfold "Projects" into one row per
 * project; that list now lives only on the projects page, where it pages
 * properly and every card carries its description. "Projects" is one row that
 * goes there.
 *
 * ── The account area is not in here ──
 * `/app/settings/*` has no organisation in its path, and the nav used to react
 * to that by replacing itself with a single "Account" item. That is the sidebar
 * rearranging itself underneath somebody who only opened their own settings:
 * the organisation they were working in disappears, and getting back to it
 * costs a click through a menu that is no longer on screen.
 *
 * So the account area is reached from the user menu — where "Account settings"
 * already lives, and where account-shaped things belong — and the sidebar keeps
 * showing the organisation throughout. `orgSlug` falls back to the last
 * organisation the tab was in for exactly this case, resolved by the chrome;
 * nothing highlights, because none of the account routes is beneath an
 * organisation's path.
 */

export interface DashboardNavParams {
  /**
   * The organisation the sidebar describes: every href here is built from it,
   * and `viewer` is the viewer's membership of it.
   *
   * Taken from the URL where there is one, and from the last organisation the
   * tab visited where there is not — the account area and the organisation
   * picker. See the note above about why the sidebar does not empty itself out
   * on those routes.
   */
  orgSlug: string | null;
  /**
   * The project the URL is inside, or `null` on every other page — the
   * projects index included. Read for one thing: "Projects" stays highlighted
   * while you are inside one of them.
   */
  projectSlug: string | null;
  /**
   * The viewer's membership of the current organisation — its authority is
   * what decides the admin-only items — or `null` while the session is still
   * resolving. Passed in rather than read from `useSession`, because this hook
   * runs in the chrome — *above* the `SessionProvider` the chrome renders —
   * where the session is a resource, not yet a context.
   */
  viewer: SessionOrganization | null;
}

/** The nav itself, without the memo — what `useDashboardNav` renders. */
export function dashboardNav({
  orgSlug,
  projectSlug,
  viewer,
}: DashboardNavParams): readonly NavSection[] {
  // Reachable only for an account with no memberships at all — which the
  // shell answers with its own empty state rather than a sidebar. An empty nav
  // rather than a placeholder section: there is genuinely nowhere to go, and
  // the account area is reached from the user menu regardless.
  if (orgSlug === null) return [];

  // Tokens and the audit log are rendered only for viewers whose authority can
  // open them — the usual rule: authority decides what is drawn, the server
  // decides what is permitted. (The tokens page has a "your devices" half
  // everyone could use, but it lives with account-adjacent things for
  // non-admins in a later pass.)
  const showTokens = canAdminister(viewer, 'token.create') || canAdminister(viewer, 'token.revoke');
  const showAudit = canAdminister(viewer, 'audit.read');

  return [
    {
      items: [
        {
          href: appPath.org(orgSlug),
          label: 'Projects',
          icon: <BoxIcon />,
          // Chords are the initial of the label, which is the only mapping
          // nobody has to memorise. They are unmodified single letters, so see
          // `useNavShortcuts` for the (deliberately long) list of situations in
          // which it declines to act on one — chiefly, any time the keystroke
          // could have been meant for a text field.
          shortcut: ['P'],
          // The projects page, and every project and environment page beneath
          // it — but not the organisation's other pages, which share its
          // prefix: members, tokens, audit and settings all live at
          // `/app/{org}/…` too. The URL has already said which kind of page
          // this is, so outside a project the match is exact, and inside one
          // the prefix is what keeps "Projects" lit.
          exact: projectSlug === null,
        },
        {
          href: appPath.members(orgSlug),
          label: 'Members',
          icon: <UsersIcon />,
          shortcut: ['M'],
        },
        ...(showTokens
          ? [
              {
                href: appPath.tokens(orgSlug),
                label: 'Tokens',
                icon: <TerminalIcon />,
                shortcut: ['T'],
              },
            ]
          : []),
        ...(showAudit
          ? [
              {
                href: appPath.audit(orgSlug),
                label: 'Audit',
                icon: <FileTextIcon />,
                shortcut: ['A'],
              },
            ]
          : []),
        {
          href: appPath.orgSettings(orgSlug),
          // Named in full, because another "Settings" exists: the account
          // area behind the avatar menu. Two entries that differ only by
          // where they sit is how someone changes the wrong one.
          label: 'Organisation settings',
          icon: <SettingsIcon />,
          // `S` rather than `O`: it is the initial of the word people
          // actually say for this page, and `O` is nobody's mnemonic for
          // "organisation settings".
          shortcut: ['S'],
        },
      ],
    },
  ];
}

export function useDashboardNav({
  orgSlug,
  projectSlug,
  viewer,
}: DashboardNavParams): readonly NavSection[] {
  // Memoised because `useNavShortcuts` rebuilds its key map whenever the nav's
  // identity changes, and the chrome re-renders on every navigation.
  return useMemo(
    () => dashboardNav({ orgSlug, projectSlug, viewer }),
    [orgSlug, projectSlug, viewer],
  );
}
