'use client';

import { createContext, use, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { systemThemeStore, themePreferenceStore } from '@/lib/theme';
import type { ResolvedTheme, ThemePreference } from '@/lib/theme';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Owns the theme preference after hydration.
 *
 * The *first* application of the theme is not done here — the inline script in
 * the root layout does that before paint. This provider takes over afterwards
 * so a change is reflected immediately and so "System" keeps tracking the OS
 * while the tab stays open.
 *
 * Both inputs are read with `useSyncExternalStore` because both genuinely live
 * outside React: one in `localStorage`, one in a media query. It gives a
 * correct server snapshot without a hydration mismatch, and it re-renders on
 * change without an effect that writes state.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = useSyncExternalStore(
    themePreferenceStore.subscribe,
    themePreferenceStore.getSnapshot,
    themePreferenceStore.getServerSnapshot,
  );

  const system = useSyncExternalStore(
    systemThemeStore.subscribe,
    systemThemeStore.getSnapshot,
    systemThemeStore.getServerSnapshot,
  );

  const resolved: ResolvedTheme = preference === 'system' ? system : preference;

  // Writing to `<html>` is exactly what an effect is for: pushing React state
  // out to something that is not React. It also repairs the attribute after
  // Strict Mode's development-only remount, which resets `<html>` to the
  // attributes rendered from JSX and discards what the inline script set.
  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    themePreferenceStore.set(next);
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const value = use(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return value;
}
