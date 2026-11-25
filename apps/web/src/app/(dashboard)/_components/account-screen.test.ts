import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SessionUser } from './session';

/**
 * The profile's name form: Save is offered only once the field holds something
 * other than the saved name, read the way a save sends it.
 *
 * A server render runs no effects and no handlers, so what is rendered is the
 * first paint — Save disabled — and the edits after it are pinned through
 * `displayNameChanged`, which is exactly what the button's `disabled` is
 * computed from. The saved name is the session's: a save waits for the
 * session's re-read before the button comes back, and the re-read name is the
 * new baseline.
 */

const session = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    email: 'ada@example.com',
    emailVerified: true,
    displayName: 'Ada Lovelace',
    avatarUrl: null,
  } as SessionUser,
}));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useSession: () => ({ user: session.user, refresh: async () => {} }),
}));

const { Toaster } = await import('@/components/ui');
const { displayNameChanged, ProfileSettings } = await import('./account-screen');

/** The opening tag of the button whose label is `label`. */
function buttonLabelled(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  if (at === -1) throw new Error(`no button labelled ${label}`);
  const start = html.lastIndexOf('<button', at);
  return html.slice(start, html.indexOf('>', start) + 1);
}

describe('the profile’s Save name', () => {
  it('is disabled while the field holds the saved name', () => {
    const html = renderToStaticMarkup(createElement(Toaster, null, createElement(ProfileSettings)));
    expect(buttonLabelled(html, 'Save name')).toMatch(/\sdisabled=""/);
  });

  it('turns on for an edit, and off again when the edit is undone', () => {
    expect(displayNameChanged('Ada Lovelace', 'Ada Lovelace')).toBe(false);
    expect(displayNameChanged('Ada Lovelace', 'Ada King')).toBe(true);
    expect(displayNameChanged('Ada Lovelace', 'Ada Lovelace')).toBe(false);
    // Trimmed, as the save trims it: stray spaces are not a new name.
    expect(displayNameChanged('Ada Lovelace', '  Ada Lovelace ')).toBe(false);
  });

  it('counts clearing the name as a change — it sends `null` — and an empty field over no name as none', () => {
    expect(displayNameChanged('Ada Lovelace', '')).toBe(true);
    expect(displayNameChanged(null, '')).toBe(false);
    expect(displayNameChanged(null, '   ')).toBe(false);
    expect(displayNameChanged(null, 'Ada')).toBe(true);
  });

  it('is off again once the name is saved, the saved name being the new baseline', () => {
    const typed = '  Ada King ';
    expect(displayNameChanged('Ada Lovelace', typed)).toBe(true);
    // The field is set to what was sent, and the session re-reads it.
    expect(displayNameChanged(typed.trim(), typed.trim())).toBe(false);
  });
});
