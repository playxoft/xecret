import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { appPath } from '../../_lib/paths';

/**
 * Which settings tabs carry the contents rail. Static markup is the first
 * paint, before any section has been read — so what is asserted is the gutter
 * the rail holds open, and its absence on Security, where there is none.
 */

const route = vi.hoisted(() => ({ pathname: '' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));

const { SettingsToc } = await import('./settings-toc');

function renderAt(pathname: string): string {
  route.pathname = pathname;
  return renderToStaticMarkup(createElement(SettingsToc));
}

describe('the settings contents rail', () => {
  it('holds its gutter open on General and Danger zone', () => {
    for (const pathname of [appPath.account(), appPath.settingsDanger()]) {
      expect(renderAt(pathname)).toBe('<div class="hidden w-56 shrink-0 xl:block"></div>');
    }
  });

  it('is not drawn on Security, gutter and all', () => {
    expect(renderAt(appPath.settingsSecurity())).toBe('');
  });
});
