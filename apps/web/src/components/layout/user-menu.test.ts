import { describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The account menu's "Upgrade plan" item.
 *
 * Radix renders a closed menu's content nowhere — and a server render has no
 * way to open it — so the menu primitives are replaced with plain elements and
 * the items are rendered as the open menu would list them. What is pinned is
 * the menu's own decision: the item appears exactly when the shell hands it an
 * organisation's plans page, and links there.
 */

vi.mock('./theme-provider', () => ({
  useTheme: () => ({ preference: 'system', setPreference: () => {} }),
}));

vi.mock('@/components/vault', () => ({ releaseVaultKeys: () => {} }));

vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  type Props = { children?: ReactNode; className?: string };
  const plain = (tag: string, role?: string) =>
    function Plain({ children, className }: Props) {
      return createElement(tag, { role, className }, children);
    };
  return {
    ...actual,
    DropdownMenu: ({ children }: Props) => createElement(Fragment, null, children),
    DropdownMenuTrigger: plain('button'),
    DropdownMenuContent: plain('div', 'menu'),
    DropdownMenuItem: plain('div', 'menuitem'),
    DropdownMenuLabel: plain('div'),
    DropdownMenuRadioGroup: plain('div', 'group'),
    DropdownMenuRadioItem: plain('div', 'menuitemradio'),
    DropdownMenuSeparator: () => createElement('hr'),
  };
});

const { UserMenu } = await import('./user-menu');

const USER = { name: 'Ada Lovelace', email: 'ada@example.com' };

describe('UserMenu', () => {
  it('offers the organisation’s plans when the shell names them', () => {
    const html = renderToStaticMarkup(
      createElement(UserMenu, {
        user: USER,
        accountHref: '/app/settings/account',
        upgradeHref: '/app/acme/upgrade',
      }),
    );

    expect(html).toContain('Upgrade plan');
    expect(html).toContain('href="/app/acme/upgrade"');
    // Beside the account item, above the theme — near the top, where it is seen.
    expect(html.indexOf('Account settings')).toBeLessThan(html.indexOf('Upgrade plan'));
    expect(html.indexOf('Upgrade plan')).toBeLessThan(html.indexOf('Theme'));
  });

  it('offers nothing to upgrade without an organisation', () => {
    const html = renderToStaticMarkup(
      createElement(UserMenu, { user: USER, accountHref: '/app/settings/account' }),
    );

    expect(html).not.toContain('Upgrade plan');
    expect(html).not.toContain('/upgrade');
  });
});
