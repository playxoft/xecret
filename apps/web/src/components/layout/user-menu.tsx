'use client';

import Link from 'next/link';
import { useState } from 'react';

import { cn } from '@/lib/cn';
import { endSession, SIGN_IN_PATH } from '@/lib/api';
import { initials } from '@/lib/format';
import { THEME_LABELS } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from '@/components/ui';
import { useTheme } from './theme-provider';

export interface ShellUser {
  name: string;
  email: string;
}

export interface UserMenuProps {
  user: ShellUser;
  /** Adds an "Account settings" item when provided. */
  accountHref?: string;
  className?: string;
}

const THEME_ICONS: Record<ThemePreference, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

const THEME_ORDER: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function UserMenu({ user, accountHref, className }: UserMenuProps) {
  const { preference, setPreference } = useTheme();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await endSession();
    } finally {
      // A full navigation rather than a router push. Every RSC payload cached
      // in this tab was rendered for a session that no longer exists, and the
      // only way to be certain none of it is reused is to throw the document
      // away. This runs even if sign-out threw: the cookie is already gone in
      // the common failure modes, and staying on a dashboard the user believes
      // they have left is the worse outcome.
      window.location.assign(SIGN_IN_PATH);
    }
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
          className="bg-surface-active text-fg-muted grid size-7 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold"
        >
          {initials(user.name)}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-60">
        <div className="px-2 py-1.5">
          <p className="text-fg truncate text-sm font-medium">{user.name}</p>
          <p className="text-fg-subtle truncate text-xs">{user.email}</p>
        </div>

        <DropdownMenuSeparator />

        {accountHref ? (
          <>
            <DropdownMenuItem asChild>
              <Link href={accountHref}>
                <SettingsIcon className="size-4" />
                Account settings
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
