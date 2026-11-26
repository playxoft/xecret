import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';

import { appPath } from '../_lib/paths';
import type { SessionOrganization } from './session';
import {
  accountSettingsSections,
  environmentSettingsSections,
  organizationSettingsSections,
} from './settings-sections';
import type { SettingsSectionGroup } from './settings-sections';

/**
 * The settings frame and its nav, rendered to static markup at a pathname —
 * the first paint, which is the one that has to be right: the list of the
 * area's sections and nothing else, the one you are on marked for assistive
 * technology as well as by colour, and the same links laid out as a row that
 * scrolls on a narrow screen and a column beside the section on a wide one.
 */

const route = vi.hoisted(() => ({ pathname: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const { SettingsLayout, SettingsNav } = await import('./settings-layout');

function member(role: OrgRole): SessionOrganization {
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: { role, customRole: null, ...authoritySummary({ role }) },
  };
}

function nav(groups: readonly SettingsSectionGroup[], pathname: string, label = 'Settings') {
  route.pathname = pathname;
  return renderToStaticMarkup(createElement(SettingsNav, { label, groups }));
}

/** Every link in the nav: its text, its address, and whether it is the current page. */
function links(html: string) {
  return [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].map((match) => ({
    label: match[2],
    href: /href="([^"]*)"/.exec(match[1] ?? '')?.[1],
    current: (match[1] ?? '').includes('aria-current="page"'),
  }));
}

const ORG_SETTINGS = appPath.orgSettings('acme');

describe('the settings nav', () => {
  it('lists the sections of the area it is in, and only those', () => {
    const html = nav(organizationSettingsSections('acme', member('owner')), ORG_SETTINGS);

    expect(links(html).map((link) => link.label)).toEqual([
      'General',
      'Roles',
      'Single sign-on',
      'Policies',
      'Webhooks',
      'Billing',
      'Plans',
      'Danger zone',
    ]);
    // Nothing of the account's, nor of any environment's.
    expect(html).not.toContain('/app/settings/');
    expect(html).not.toContain('Encryption key');
  });

  it('names itself for the area', () => {
    const html = nav(
      accountSettingsSections({ vaultConfigured: true }),
      appPath.account(),
      'Account settings',
    );
    expect(html).toMatch(/^<nav aria-label="Account settings"/);
  });

  it('marks the section you are on with aria-current="page", and no other', () => {
    const html = nav(
      organizationSettingsSections('acme', member('owner')),
      appPath.orgWebhooks('acme'),
    );
    const current = links(html).filter((link) => link.current);

    expect(current).toEqual([
      { label: 'Webhooks', href: '/app/acme/settings/webhooks', current: true },
    ]);
  });

  it('marks General on the area’s own address, and nothing on a page outside the list', () => {
    const groups = organizationSettingsSections('acme', member('owner'));
    expect(links(nav(groups, ORG_SETTINGS)).filter((link) => link.current)).toEqual([
      { label: 'General', href: ORG_SETTINGS, current: true },
    ]);
    expect(links(nav(groups, '/app/acme/members')).some((link) => link.current)).toBe(false);
  });

  it('leaves out what the viewer cannot use, as the cards were left out', () => {
    const labels = links(
      nav(organizationSettingsSections('acme', member('developer')), ORG_SETTINGS),
    ).map((link) => link.label);

    expect(labels).toEqual(['General', 'Policies', 'Plans']);
  });

  it('keeps the current mark on a section the viewer was sent to but is not listed for', () => {
    // A developer following an old link to the danger zone: the section says
    // who can use it, and nothing in the list claims to be where they are.
    const html = nav(
      organizationSettingsSections('acme', member('developer')),
      appPath.orgDanger('acme'),
    );
    expect(html).not.toContain('Danger zone');
    expect(links(html).some((link) => link.current)).toBe(false);
  });

  it('lists an environment’s sections, its deletion only for somebody who may delete it', () => {
    const settings = appPath.environmentSettings('acme', 'payments-api', 'production');
    const labels = (role: OrgRole) =>
      links(nav(environmentSettingsSections(settings, member(role)), settings)).map(
        (link) => link.label,
      );

    expect(labels('admin')).toEqual([
      'General',
      'Encryption key',
      'Inheritance',
      'Policy',
      'Danger zone',
    ]);
    expect(labels('developer')).toEqual(['General', 'Encryption key', 'Inheritance', 'Policy']);
  });

  describe('on a narrow screen', () => {
    const html = nav(accountSettingsSections({ vaultConfigured: true }), appPath.settingsDanger());

    it('is one row that scrolls sideways, becoming a column from xl', () => {
      const row = /<div[^>]*data-scroll-region=""[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';

      expect(row.split(' ')).toEqual(expect.arrayContaining(['flex', 'overflow-x-auto']));
      expect(row.split(' ')).toEqual(
        expect.arrayContaining(['xl:flex-col', 'xl:overflow-visible']),
      );
      // A row, not a column, until then.
      expect(row.split(' ')).not.toContain('flex-col');
    });

    it('runs the groups together, printing their headings only in the column', () => {
      const heading = /<p id="[^"]*" class="([^"]*)">Security<\/p>/.exec(html)?.[1] ?? '';
      expect(heading.split(' ')).toEqual(expect.arrayContaining(['hidden', 'xl:block']));
    });

    it('keeps each link on one line, underlined rather than barred when current', () => {
      const current =
        /<a [^>]*aria-current="page"[^>]*class="([^"]*)"|<a [^>]*class="([^"]*)"[^>]*aria-current="page"/.exec(
          html,
        );
      const classes = (current?.[1] ?? current?.[2] ?? '').split(' ');

      expect(classes).toEqual(
        expect.arrayContaining([
          'whitespace-nowrap',
          'border-b-2',
          'border-accent',
          'xl:border-l-2',
        ]),
      );
    });

    it('names each group for a screen reader, which hears the heading the row hides', () => {
      const id = /<p id="([^"]*)"[^>]*>Security<\/p>/.exec(html)?.[1];
      expect(id).toBeDefined();
      expect(html).toContain(`<ul aria-labelledby="${id}"`);
    });
  });
});

describe('the settings frame', () => {
  function frame(groups: readonly SettingsSectionGroup[], pathname: string) {
    route.pathname = pathname;
    type FrameProps = Parameters<typeof SettingsLayout>[0];
    const props: Omit<FrameProps, 'children'> = {
      header: createElement('h1', null, 'Organisation settings'),
      label: 'Organisation settings',
      groups,
    };
    // Asserted to the full props: `createElement` adds the children from its
    // third argument, which the props type cannot see.
    return renderToStaticMarkup(
      createElement(SettingsLayout, props as FrameProps, createElement('p', null, 'the section')),
    );
  }

  /** The classes of the column the section is drawn in. */
  function column(html: string): string[] {
    return (/<div class="([^"]*)"><p>the section<\/p>/.exec(html)?.[1] ?? '').split(' ');
  }

  const groups = organizationSettingsSections('acme', member('owner'));

  it('draws the area’s heading, the nav, and the section open under it', () => {
    const html = frame(groups, ORG_SETTINGS);
    expect(html.indexOf('<h1>Organisation settings</h1>')).toBeLessThan(html.indexOf('<nav'));
    expect(html.indexOf('<nav')).toBeLessThan(html.indexOf('the section'));
  });

  it('holds a section to a form’s measure', () => {
    expect(column(frame(groups, ORG_SETTINGS))).toContain('max-w-2xl');
    expect(column(frame(groups, appPath.orgBilling('acme')))).toContain('max-w-2xl');
  });

  it('gives the plans the column’s whole width', () => {
    expect(column(frame(groups, appPath.orgPlans('acme')))).not.toContain('max-w-2xl');
  });

  /** The classes of the frame itself, the outermost element. */
  function outer(html: string): string[] {
    return (/^<div class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ');
  }

  it('is the same width on every section, so the nav never moves sideways under the pointer', () => {
    const widths = [ORG_SETTINGS, appPath.orgBilling('acme'), appPath.orgPlans('acme')].map(
      (pathname) => outer(frame(groups, pathname)).filter((name) => name.startsWith('max-w-')),
    );
    expect(widths).toEqual([['max-w-6xl'], ['max-w-6xl'], ['max-w-6xl']]);
  });

  /**
   * The arithmetic the frame's width rests on, done on the classes it renders:
   * at its widest, the frame less the nav column and the gap beside it must
   * hold the plans' comparison table whole. The table is `min-w-[52rem]` in
   * `upgrade-screen.tsx`, and scrolls inside its own box below that.
   */
  it('leaves a wide section room for the plans’ 52rem comparison table beside the nav', () => {
    const html = frame(groups, appPath.orgPlans('acme'));
    const rem = (scale: string) => Number(scale) / 4;
    const MAX_WIDTH_REM: Record<string, number> = { '5xl': 64, '6xl': 72, '7xl': 80 };

    const frameWidth = MAX_WIDTH_REM[/max-w-(\w+)/.exec(outer(html).join(' '))?.[1] ?? ''];
    const navWidth = rem(/<nav [^>]*class="[^"]*xl:w-(\d+)/.exec(html)?.[1] ?? 'NaN');
    const gap = rem(/xl:flex-row[^"]*xl:gap-(\d+)/.exec(html)?.[1] ?? 'NaN');

    expect(frameWidth).toBeDefined();
    expect((frameWidth ?? 0) - navWidth - gap).toBeGreaterThanOrEqual(52);
  });
});
