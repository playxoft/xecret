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

describe('the project’s Manage menu edits the description in place', () => {
  // The open menu renders into a portal, which static markup never draws, so
  // the placement is read off the source: directly under Rename, in the same
  // group — no separator between them — and above Delete.
  it('directly below Rename project, in its group', () => {
    const text = source('../../../components/projects/project-actions.tsx');
    const menu = text.slice(
      text.indexOf('<DropdownMenuContent'),
      text.indexOf('</DropdownMenuContent>'),
    );

    const rename = menu.indexOf('Rename project…');
    const description = menu.indexOf('Edit description…');
    const remove = menu.indexOf('Delete project…');
    expect(rename).toBeGreaterThan(-1);
    expect(description).toBeGreaterThan(rename);
    expect(remove).toBeGreaterThan(description);

    const between = menu.slice(rename, description + 'Edit description…'.length);
    expect(between).not.toContain('DropdownMenuSeparator');
    // Gated on its own flag, and opening its own dialog.
    expect(between).toMatch(
      /\{canEditDescription \? \(\s*<DropdownMenuItem onSelect=\{\(\) => setEditingDescription\(true\)\}>\s*Edit description…/,
    );
  });

  it('through a dialog that tells the screen, so the heading re-reads', () => {
    const text = source('../../../components/projects/project-actions.tsx');
    const dialog = text.slice(text.indexOf('<EditDescriptionDialog'));
    expect(attribute(dialog, 'open')).toBe('editingDescription');
    expect(attribute(dialog, 'onSaved')).toBe('onChanged');
  });

  // The heading is where the description is read; the project screen hands it
  // whatever the project says, so a saved description shows on reload.
  it('shown under the project’s heading', () => {
    const screen = source('./project-screen.tsx');
    expect(attribute(screen, 'description')).toBe('project.data?.project.description ?? undefined');
  });
});

describe('the environment switcher', () => {
  const screen = source('./environment-screen.tsx');

  // A strip of its own, under the heading — not one more control in the
  // heading's actions, where the legend has no room.
  it('sits under the heading, not among its actions', () => {
    expect(attribute(screen, 'actions')).not.toContain('<EnvironmentSwitcher');
    expect(screen.indexOf('<EnvironmentSwitcher')).toBeGreaterThan(screen.indexOf('<PageHeader'));
  });

  // Every way the switcher takes an environment off the page — the Compare
  // menu, a legend ×, "Stop comparing", a chord — goes through the screen's
  // guard, which hears from the table how many compared cells are unsaved.
  it('takes compared environments off through the guard that knows about unsaved cells', () => {
    const switcher = screen.slice(screen.indexOf('<EnvironmentSwitcher'));
    expect(attribute(switcher, 'onCompare')).toBe('toggleCompared');
    expect(attribute(switcher, 'onStopComparing')).toBe('() => changeCompared([])');
    expect(screen).toMatch(/function toggleCompared\(slug: string\) \{\s*changeCompared\(/);
    expect(screen).toMatch(
      /if \(drops && unsavedCompared > 0\) \{[\s\S]*?setPendingCompared\(\{ next, closing \}\);\s*return;/,
    );
    // And confirming applies exactly the comparison that was asked about.
    expect(screen).toMatch(/setCompared\(pendingCompared\.next\);\s*setPendingCompared\(null\);/);

    const table = screen.slice(screen.indexOf('<SecretTable'));
    expect(attribute(table, 'onComparedUnsavedChange')).toBe('setUnsavedCompared');
    const tableSource = source('../../../components/secrets/secret-table.tsx');
    expect(tableSource).toMatch(
      /onComparedUnsavedChange\?\.\(comparedUnsaved\);\s*return \(\) => onComparedUnsavedChange\?\.\(0\);/,
    );
  });

  // Comparing used to be a shift-click nobody could find. It is a menu now, and
  // a shifted click on a capsule is the browser's again.
  it('does not take over a modified click', () => {
    const switcher = source('../../../components/projects/environment-switcher.tsx');
    expect(switcher).not.toMatch(/shiftKey/);
    expect(switcher).not.toMatch(/onClick: \(event: MouseEvent/);
  });
});

describe('the account menu offers the plans of the organisation on screen', () => {
  // The shell builds the link from the slug the switcher names — so "Upgrade
  // plan" can never open another tenant's plans — and hands it to the menu
  // only when there is one. Deleting either line leaves both components
  // working and the item gone, or pointing at `/app//settings/plans`.
  it('built from the switcher’s slug, and only when there is one', () => {
    const shell = source('../../../components/layout/app-shell.tsx');
    expect(shell).toMatch(
      /const upgradeHref = currentOrgSlug === '' \? undefined : appPath\.orgPlans\(currentOrgSlug\);/,
    );
    expect(shell.slice(shell.indexOf('<UserMenu'))).toContain('{ upgradeHref }');
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

describe('staged work survives a lock it cannot be saved through', () => {
  // Both rules are pure functions with tests of their own. What those tests
  // cannot see is the screen still calling them: unwired, each fails silently
  // in exactly the case it exists for.
  it('the listing keeps its rows when a re-read is refused as locked', () => {
    // Every save re-reads the listing, and a refusal that replaced the rows
    // unmounted the table and every staged edit in it.
    const screen = source('./environment-screen.tsx');
    const hook = screen.slice(screen.indexOf('function useSecretList'));
    expect(hook).toMatch(
      /\.catch\(\(cause: unknown\) => \{\s*if \(controller\.signal\.aborted\) return;[\s\S]*?setState\(\(current\) => listingAfterFailure\(current, path, cause\)\);/,
    );
  });

  it('the browser is asked about staged edits by the one rule that knows about sign-outs', () => {
    const guard = source('../../../components/ui/unsaved-changes-guard.tsx');
    const handler = guard.slice(guard.indexOf('const onBeforeUnload'));
    expect(handler.slice(0, handler.indexOf('event.preventDefault()'))).toMatch(
      /if \(!asksBeforeUnload\(unwinding\.current\)\) return;/,
    );
  });
});

describe('every sign-out leaves in the same order', () => {
  // Redirects suppressed before the revoke; a departure on purpose — no "Leave
  // site?" — only once the revoke is confirmed; the keys released and the page
  // left whatever the revoke did. A failed revoke may leave the session live,
  // and the browser must still be allowed to ask.
  it.each([
    ['the account menu', '../../../components/layout/user-menu.tsx'],
    ['the lock screen', './lock-screen.tsx'],
    ['the invitation screen', '../../(auth)/invite/[token]/invite-screen.tsx'],
  ])('%s', (_where, path) => {
    const text = source(path);
    expect(text).toMatch(
      /beginSignInRedirect\(\);[\s\S]*?try \{\s*destination = await endSession\(\);\s*beginLeavingPage\(\);\s*\} finally \{[\s\S]*?releaseVaultKeys\(\);/,
    );
  });
});
