/**
 * Theme preference: read, write, apply.
 *
 * The stored *preference* is one of three values; the *applied* value on
 * `<html data-theme>` is always `light` or `dark`. Keeping those separate is
 * what lets "System" keep tracking the OS after the page has loaded — a single
 * resolved value would forget that the user ever chose to follow the system.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'xecret.theme';
export const SIDEBAR_STORAGE_KEY = 'xecret.sidebar';

/**
 * Rendered by the server and applied by the inline script if no preference has
 * been stored yet. Dark is the product's primary theme.
 */
export const DEFAULT_RESOLVED_THEME: ResolvedTheme = 'dark';

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** The OS-level preference, or `dark` where it cannot be determined. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return DEFAULT_RESOLVED_THEME;
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

/**
 * `localStorage` throws in Safari private mode and in sandboxed iframes, and a
 * theme preference is never worth breaking a page over.
 */
export function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function readSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/** Applies the resolved theme to `<html>`. Returns what was applied. */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset['theme'] = resolved;
  return resolved;
}

/* ───────────────────────────────────────────────────────────────────────────
   These preferences live in `localStorage` and on `<html>` — outside React.
   They are exposed as external stores so components can read them with
   `useSyncExternalStore`, which is the one API that gives a correct server
   snapshot, a correct client snapshot, and no setState-in-an-effect.

   The `storage` event gives cross-tab consistency for free: changing the theme
   in one tab updates every other tab of the app.
   ─────────────────────────────────────────────────────────────────────────── */

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('storage', notify);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', notify);
    }
  };
}

export const themePreferenceStore = {
  subscribe,
  getSnapshot: readThemePreference,
  getServerSnapshot: (): ThemePreference => 'system',
  set(preference: ThemePreference): void {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Not persisted; the current page still honours the choice.
    }
    applyTheme(preference);
    notify();
  },
} as const;

export const sidebarCollapsedStore = {
  subscribe,
  getSnapshot: readSidebarCollapsed,
  getServerSnapshot: (): boolean => false,
  set(collapsed: boolean): void {
    const value = collapsed ? 'collapsed' : 'expanded';
    document.documentElement.dataset['sidebar'] = value;
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, value);
    } catch {
      // Same reasoning as the theme preference.
    }
    notify();
  },
} as const;

/** The OS preference, as its own store so `system` keeps tracking it live. */
export const systemThemeStore = {
  subscribe(listener: () => void): () => void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return () => {};
    }
    const query = window.matchMedia('(prefers-color-scheme: light)');
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  },
  getSnapshot: systemTheme,
  getServerSnapshot: (): ResolvedTheme => DEFAULT_RESOLVED_THEME,
} as const;

/**
 * The no-flash bootstrap.
 *
 * This runs synchronously in `<head>`, before the browser has painted
 * anything. It has to be *inline* and *render-blocking* for two reasons:
 *
 *  1. `localStorage` does not exist during server rendering, so the HTML is
 *     necessarily emitted with a default theme. Anything that corrects it
 *     after hydration — `useEffect`, `useLayoutEffect`, a deferred script —
 *     runs after the browser has already painted, and a dark-mode user sees a
 *     full-screen white flash on every hard navigation.
 *  2. An external `<script src>` would be a separate network round trip. On a
 *     cold cache the browser paints before it arrives, which is the same flash
 *     with extra steps.
 *
 * The cost is a few hundred bytes of blocking JavaScript, and a Content
 * Security Policy that must allow it via a nonce or hash. That is the correct
 * trade: the alternative is a visible defect on every page load.
 *
 * It also restores the sidebar collapse state, for the same reason — driving
 * that width from React state means a layout shift on every load.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{
var d=document.documentElement,s=localStorage;
var t=s.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
d.dataset.theme=t;
d.dataset.sidebar=s.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)})==='collapsed'?'collapsed':'expanded';
}catch(e){}})()`;
