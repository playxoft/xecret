import { describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The account menu's "Upgrade" item.
 *
 * Radix renders a closed menu's content nowhere — and a server render has no
 * way to open it — so the menu primitives are replaced with plain elements and
 * the items are rendered as the open menu would list them. What is pinned is
 * the menu's own decision: the item is always there, and opens the public
 * pricing page in a new tab.
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
  it('offers Upgrade, opening the pricing page in a new tab', () => {
    const html = renderToStaticMarkup(
      createElement(UserMenu, { user: USER, accountHref: '/app/settings/account' }),
    );

    expect(html).toContain('>Upgrade<');
    expect(html).toContain('<a href="/pricing" target="_blank" rel="noopener noreferrer">');
    // Said to a screen reader too: a new tab is a surprise unless announced.
    expect(html).toContain('opens the pricing page in a new tab');
    // Beside the account item, above the theme — near the top, where it is seen.
    expect(html.indexOf('Account settings')).toBeLessThan(html.indexOf('>Upgrade<'));
    expect(html.indexOf('>Upgrade<')).toBeLessThan(html.indexOf('Theme'));
  });

  it('offers it with no organisation on screen too — it needs none', () => {
    const html = renderToStaticMarkup(createElement(UserMenu, { user: USER }));

    expect(html).toContain('href="/pricing"');
    expect(html).not.toContain('/settings/plans');
  });
});

describe('UserMenu’s "Admin" item', () => {
  it('is offered when the shell hands it the admin page, below the account items', () => {
    const html = renderToStaticMarkup(
      createElement(UserMenu, {
        user: USER,
        accountHref: '/app/settings/account',
        adminHref: '/app/admin',
      }),
    );

    expect(html).toContain('>Admin<');
    expect(html).toContain('href="/app/admin"');
    expect(html.indexOf('>Upgrade<')).toBeLessThan(html.indexOf('>Admin<'));
    expect(html.indexOf('>Admin<')).toBeLessThan(html.indexOf('Theme'));
  });

  it('is not there for anybody else', () => {
    const html = renderToStaticMarkup(
      createElement(UserMenu, { user: USER, accountHref: '/app/settings/account' }),
    );

    expect(html).not.toContain('>Admin<');
    expect(html).not.toContain('/app/admin');
  });
});
