'use client';

import Link from 'next/link';
import { useState } from 'react';

import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';
import { THEME_LABELS } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';
import {
  ariaKeyShortcuts,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ExternalLinkIcon,
  LockIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  ShieldIcon,
  Shortcut,
  SunIcon,
  UpgradeIcon,
} from '@/components/ui';
import { signOutAndLeave } from './sign-out';
import { useTheme } from './theme-provider';

/** The public pricing page the account menu's Upgrade item opens. */
export const PRICING_PATH = '/pricing';

export interface ShellUser {
  name: string;
  email: string;
}

export interface UserMenuProps {
  user: ShellUser;
  /** Adds an "Account settings" item when provided. */
  accountHref?: string;
  /**
   * Adds "Admin" when provided: the page where xecret's own staff give an
   * organisation a free plan and issue promo codes. The shell hands it over
   * only for one of xecret's admins, as the session reports them; for anybody
   * else the page is a 404, so an item drawn by mistake leads nowhere.
   */
  adminHref?: string;
  /**
   * Locks the session without ending it. Adds the "Lock now" item when given.
   *
   * A prop rather than a call into the session context, so this component stays
   * usable by anything that renders the shell — including the tests, which have
   * no session provider.
   */
  onLock?: () => Promise<void>;
  className?: string;
}

const THEME_ICONS: Record<ThemePreference, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

const THEME_ORDER: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function UserMenu({ user, accountHref, adminHref, onLock, className }: UserMenuProps) {
  const { preference, setPreference } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const [locking, setLocking] = useState(false);

  /**
   * Locking is the cheap safe action, and it is placed above signing out for
   * that reason: it costs one passphrase to undo, where signing out costs a full trip
   * through the identity provider. Making the safe thing the easy thing is what
   * gets it used when somebody stands up from their desk.
   */
  async function handleLock() {
    if (!onLock) return;
    setLocking(true);
    try {
      await onLock();
    } catch {
      // Caught and dropped, as the idle timer does. The keys are gone whatever
      // the request did, and the shell has re-read the session, which is what
      // shows the outcome — the lock screen, or why the account could not be
      // reached. A rejection left floating would say nothing more.
    } finally {
      setLocking(false);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    // Shared with the frames the shell draws without a session (`sign-out.tsx`).
    await signOutAndLeave();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'hover:bg-surface-hover data-[state=open]:bg-surface-hover flex items-center gap-2 rounded-lg p-1 transition-colors',
          className,
        )}
        aria-label={`Account menu for ${user.name}`}
      >
        <span
          aria-hidden="true"
          className="bg-surface-active text-fg-muted grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold"
        >
          {initials(user.name)}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-60">
        <div className="px-2 py-1.5">
          <p className="text-fg truncate text-sm font-medium">{user.name}</p>
          <p className="text-fg-subtle truncate text-sm">{user.email}</p>
        </div>

        <DropdownMenuSeparator />

        {accountHref ? (
          <DropdownMenuItem asChild>
            {/* Emphasised: this is the only route to the account area from
                an organisation, and the sidebar's "Organisation settings"
                is the plausible-but-wrong place people look first. */}
            <Link href={accountHref}>
              <SettingsIcon className="text-accent-text size-4" />
              <span className="font-medium">Account settings</span>
            </Link>
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuItem
          asChild
          // Tinted at rest rather than only on hover, so it is found without
          // being hunted for — and tinted rather than filled, so it reads as
          // an offer beside the account items and not as the menu's
          // primary action.
          className="bg-accent-tint text-accent-text data-[highlighted]:bg-surface-active data-[highlighted]:text-accent-text mt-0.5"
        >
          {/* The public pricing page, in a new tab (the owner's call): every
              plan side by side, without leaving the work on screen. Always
              offered — it needs no organisation, and on an installation that
              sells nothing the page compares the plans without a price and
              says why. The organisation's own plans page, with its checkout,
              stays in its settings. A plain <a>, not <Link>: a new tab is a
              new document, and the client router has nothing to do. */}
          <a href={PRICING_PATH} target="_blank" rel="noopener noreferrer">
            <UpgradeIcon className="size-4" />
            <span className="flex-1 font-medium">Upgrade</span>
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            <span className="sr-only">(opens the pricing page in a new tab)</span>
          </a>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Its own group, below the account's and the organisation's items:
            it is about neither, and somebody who has it uses it rarely enough
            that it should not sit where "Account settings" is reached for. */}
        {adminHref ? (
          <>
            <DropdownMenuItem asChild>
              <Link href={adminHref}>
                <ShieldIcon className="size-4" />
                Admin
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}

        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {/* A radio group rather than a cycle button: three states cannot be
            represented by one toggle, and "System" is the default most people
            want back once they have left it. */}
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(next) => setPreference(next as ThemePreference)}
        >
          {THEME_ORDER.map((option) => {
            const Icon = THEME_ICONS[option];
            return (
              <DropdownMenuRadioItem key={option} value={option}>
                <Icon className="size-4" />
                {THEME_LABELS[option]}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        {onLock ? (
          <DropdownMenuItem
            disabled={locking}
            onSelect={(event) => {
              event.preventDefault();
              void handleLock();
            }}
            aria-keyshortcuts={ariaKeyShortcuts(['Shift', 'L'])}
          >
            <LockIcon className="size-4" />
            <span className="flex-1">{locking ? 'Locking…' : 'Lock now'}</span>
            {/* The chord `AppShell` registers, advertised on the item that does
                the same thing. This menu is where somebody looks for "lock",
                so it is where they should learn they need not open it again. */}
            <Shortcut keys={['Shift', 'L']} />
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuItem
          destructive
          disabled={signingOut}
          // `onSelect` fires before Radix closes the menu, so the async work is
          // started here and the navigation replaces the page regardless.
          onSelect={(event) => {
            event.preventDefault();
            void handleSignOut();
          }}
        >
          <LogOutIcon className="size-4" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
