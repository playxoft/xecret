import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Wiring between the screens and the shell that no unit test of either half
 * can see.
 *
 * Each case below is a line that, deleted, leaves every component working on
 * its own and the product visibly wrong — and none of them fails a type check,
 * because what goes missing is a call, not a shape. The screens render only
 * inside the dashboard's session and key machinery, which this suite does not
 * stand up, so the assertion is on the source: blunt, and exactly as precise
 * as the regression it pins.
 */

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** The body of the JSX attribute `name={…}`, braces balanced, or `null`. */
function attribute(text: string, name: string): string | null {
  const start = text.indexOf(`${name}={`);
  if (start === -1) return null;
  let depth = 0;
  for (let index = start + name.length + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return text.slice(start + name.length + 2, index);
  }
  return null;
}

describe('the notes of an end-to-end encrypted environment are opened before they are shown', () => {
  // The listing carries such a note only sealed, with `note: null`, and every
  // table reads `note`. Handing a table the listing as fetched is the bug
  // that made every saved note look unsaved — see `use-opened-notes.ts`.
  it('on the environment screen', () => {
    const screen = source('./environment-screen.tsx');
    expect(screen).toMatch(
      /const \{ secrets: listing, remember: rememberNotes \} = useOpenedNotes\(secrets\.data, io\)/,
    );
    const table = screen.slice(screen.indexOf('<SecretTable'));
    expect(attribute(table, 'secrets')).toBe('listing');
    // And the notes a save writes go back to it, so the row shows them at once.
    expect(attribute(table, 'onNotesWritten')).toBe('rememberNotes');
  });

  it('in every compared environment', () => {
    const hook = source('../../../components/secrets/use-compared-secrets.ts');
    expect(hook).toMatch(/io\.openNotes\(response\.data\)/);
    // And the map the cells read from is built from what that returned.
    expect(hook).toMatch(/new Map\(listing\.map\(/);
  });
});

describe('a rename reaches the breadcrumb trail', () => {
  // The trail names the project and the environment from the shell's own
  // request. A screen that reloaded only its own resource after a rename left
  // the heading on the new name and the crumb above it on the old one.
  it('from the project screen', () => {
    const screen = source('./project-screen.tsx');
    const actions = screen.slice(screen.indexOf('<ProjectActions'));
    expect(attribute(actions, 'onChanged')).toContain('refreshTrail()');
  });

  it('from the environment settings screen', () => {
    const screen = source('./environment-settings-screen.tsx');
    const form = screen.slice(screen.indexOf('<EnvironmentSettingsForm'));
    expect(attribute(form, 'onChanged')).toContain('refreshTrail()');
  });

  it('because the shell hands the screens a way to ask', () => {
    expect(attribute(source('./dashboard-chrome.tsx'), 'value')).toContain('refreshTrail');
  });
});

describe('the shell catches up with a lock through its coordinator', () => {
  // `lock-catch-up.ts` decides when the shell re-reads the session, and its own
  // tests pin how. What they cannot see is the shell actually using it — armed
  // while the unlocked dashboard is drawn, told about every answer, and the only
  // way the session is ever re-read. A re-read that went around it would land
  // on the lock screen with the one-at-a-time guard down, and re-read again.
  const chrome = source('./dashboard-chrome.tsx');

  it('is armed while the unlocked dashboard is drawn, and hears every answer', () => {
    expect(chrome).toMatch(
      /if \(!unlockedShell\) return;\s*return lockCatchUp\.arm\(\{ awaitKeys: keysObtainable \}\);/,
    );
    // Keys are awaited only where a `VaultProvider` is mounted: the unlocked
    // branch with organisations. The screen with none mounts no provider, and a
    // grace period there locked the whole account's session on every cold load.
    expect(chrome).toMatch(
      /const keysObtainable = unlockedShell && \(memberships\?\.length \?\? 0\) > 0;/,
    );
    expect(chrome).toMatch(/if \(organizations\.length === 0\) \{/);
    expect(chrome).toMatch(
      /lockCatchUp\.answered\(\);\s*\}, \[lockCatchUp, session\.data, session\.error\]\);/,
    );
  });

  it('is the only way the session is re-read', () => {
    // The resource's own reload goes to the coordinator, and nowhere else.
    expect(chrome.match(/session\.reload/g)).toEqual(['session.reload']);
    expect(chrome).toMatch(/createLockCatchUp\(\{ reload: session\.reload,/);

    expect(attribute(chrome, 'onUnlocked')).toBe('reloadSession');
    expect(attribute(chrome, 'onRetry')).toBe('reloadSession');
    expect(attribute(chrome, 'onCreated')).toBe('reloadSession');
    expect(attribute(chrome, 'value')).toContain('refresh: reloadSession');
  });

  it('locks through it, so a lock re-reads the session whatever its request answered', () => {
    expect(chrome).toMatch(/const lock = lockCatchUp\.lock;/);
  });
});
