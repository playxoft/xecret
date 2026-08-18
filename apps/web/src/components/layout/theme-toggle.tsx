'use client';

import { MoonIcon, SunIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { resolveTheme, themePreferenceStore, readThemePreference } from '@/lib/theme';

/**
 * Light ⇄ dark, in the header.
 *
 * ── Two states, not three ──
 * The account settings screen offers Light, Dark and System, because that is a
 * settings screen and "follow my OS" is a real preference. This control is a
 * single button in a nav bar: it flips to the other theme and stores that
 * choice explicitly. A three-way cycle in a header is a control where nobody
 * can predict what the next click does.
 *
 * Choosing here therefore *ends* System for this browser, which is the correct
 * reading of a deliberate click on a theme button. The settings screen can put
 * it back.
 *
 * ── Why it reads the DOM instead of context ──
 * The rendered markup is identical in both themes — see `.x-theme-when-*` in
 * globals.css, which decides the visible face from `<html data-theme>` before
 * the first paint. So this component needs no theme state at all, only the
 * current value at the moment of a click, which is read from the same place
 * the CSS reads it. That keeps it out of the ThemeProvider's context, and lets
 * the header stay usable on pages that render before hydration.
 */
export function ThemeToggle({ className }: { className?: string }) {
  function toggle() {
    const current = document.documentElement.dataset['theme'];
    // The dataset is authoritative — the bootstrap script set it — but a
    // hard-reloaded page whose script was blocked could leave it unset, so
    // fall back to resolving the stored preference the same way the script does.
    const resolved =
      current === 'light' || current === 'dark' ? current : resolveTheme(readThemePreference());

    themePreferenceStore.set(resolved === 'dark' ? 'light' : 'dark');
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        'text-fg-muted hover:bg-surface-hover hover:text-fg grid size-9 shrink-0 place-items-center',
        'rounded-full transition-colors',
        className,
      )}
    >
      {/* Each face carries its own label. Only one is in the accessibility
          tree at a time, so the button is always named for what it will do. */}
      <span className="x-theme-when-dark">
        <SunIcon className="size-[1.05rem]" />
        <span className="sr-only">Switch to the light theme</span>
      </span>
      <span className="x-theme-when-light">
        <MoonIcon className="size-[1.05rem]" />
        <span className="sr-only">Switch to the dark theme</span>
      </span>
    </button>
  );
}
