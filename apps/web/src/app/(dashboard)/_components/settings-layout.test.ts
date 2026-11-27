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

    it('runs the groups together, as one list', () => {
      expect(html.match(/<ul[ >]/g)).toHaveLength(1);
      // Every section is an item of it, Danger zone included.
      expect(html.match(/<li[ >]/g)).toHaveLength(links(html).length);
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
  });

  describe('as a plain list', () => {
    /** The classes of the item holding the link labelled `label`. */
    function item(html: string, label: string): string[] {
      const match = new RegExp(`<li class="([^"]*)"><a [^>]*>${label}</a></li>`).exec(html);
      return (match?.[1] ?? '').split(' ');
    }

    it('prints no group headings, in any area', () => {
      const environment = appPath.environmentSettings('acme', 'payments-api', 'production');
      for (const html of [
        nav(accountSettingsSections({ vaultConfigured: true }), appPath.account()),
        nav(organizationSettingsSections('acme', member('owner')), ORG_SETTINGS),
        nav(environmentSettingsSections(environment, member('admin')), environment),
      ]) {
        expect(html).not.toMatch(/<(p|h\d)[ >]/);
        expect(html).not.toContain('aria-labelledby');
        // Every word in the nav is a link's.
        expect(html.replace(/<a [^>]*>[^<]*<\/a>/g, '').replace(/<[^>]*>/g, '')).toBe('');
      }
      const organization = nav(organizationSettingsSections('acme', member('owner')), ORG_SETTINGS);
      expect(organization).not.toContain('Plan and billing');
      expect(
        nav(accountSettingsSections({ vaultConfigured: true }), appPath.account()),
      ).not.toMatch(/>Security</);
    });

    it('sets each former group a little apart in the column, and only there', () => {
      const html = nav(organizationSettingsSections('acme', member('owner')), ORG_SETTINGS);

      // The first section of every group after the first: Billing, Danger zone.
      for (const label of ['Billing', 'Danger zone']) {
        expect(item(html, label), label).toContain('xl:mt-3');
        expect(
          item(html, label).some((name) => /^m[tb]?-/.test(name)),
          label,
        ).toBe(false);
      }
      for (const label of ['General', 'Roles', 'Webhooks', 'Plans']) {
        expect(item(html, label), label).not.toContain('xl:mt-3');
      }
    });

    it('starts the gap from the first section the viewer is shown, when a group’s first is hidden', () => {
      // An admin is not shown Billing, so Plans opens that group.
      const html = nav(organizationSettingsSections('acme', member('admin')), ORG_SETTINGS);
      expect(item(html, 'Plans')).toContain('xl:mt-3');
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
    // Unescaped, because an arbitrary variant's `&` arrives as `&amp;`.
    const classes = /<div class="([^"]*)"><p>the section<\/p>/.exec(html)?.[1] ?? '';
    return classes.replaceAll('&amp;', '&').split(' ');
  }

  const groups = organizationSettingsSections('acme', member('owner'));

  it('draws the area’s heading, the nav, and the section open under it', () => {
    const html = frame(groups, ORG_SETTINGS);
    expect(html.indexOf('<h1>Organisation settings</h1>')).toBeLessThan(html.indexOf('<nav'));
    expect(html.indexOf('<nav')).toBeLessThan(html.indexOf('the section'));
  });

  /** Every section of every area, as the frame would be asked to draw it. */
  const ENVIRONMENT = appPath.environmentSettings('acme', 'payments-api', 'production');
  const AREAS = [
    accountSettingsSections({ vaultConfigured: true }),
    groups,
    environmentSettingsSections(ENVIRONMENT, member('admin')),
  ];

  it('draws every section in the same column, so the page never changes width under you', () => {
    for (const area of AREAS) {
      const columns = area
        .flatMap((group) => group.sections)
        .map((section) => column(frame(area, section.href)).join(' '));

      expect(columns[0]).not.toBe('');
      expect(new Set(columns).size).toBe(1);
    }
  });

  it('gives that column the frame’s whole width, the plans’ and a form’s alike', () => {
    const plans = column(frame(groups, appPath.orgPlans('acme')));
    expect(plans).toContain('flex-1');
    // No measure of its own: the column is the frame less the nav.
    expect(plans.some((name) => /^max-w-/.test(name))).toBe(false);
  });

  it('holds a section’s fields to a form’s measure inside it', () => {
    expect(column(frame(groups, ORG_SETTINGS))).toContain('[&_[data-field]]:max-w-2xl');
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
   * The arithmetic the column's width rests on, done on the classes it
   * renders: at its widest, the frame less the nav column and the gap beside
   * it must hold the plans side by side — three columns from a 56rem
   * container, `@4xl` in `upgrade-screen.tsx` — and their comparison table
   * whole, which is `min-w-[52rem]` and scrolls inside its own box below that.
   */
  it('leaves every section room for the plans’ three columns and 52rem table beside the nav', () => {
    const html = frame(groups, appPath.orgPlans('acme'));
    const rem = (scale: string) => Number(scale) / 4;
    const MAX_WIDTH_REM: Record<string, number> = { '5xl': 64, '6xl': 72, '7xl': 80 };

    const frameWidth = MAX_WIDTH_REM[/max-w-(\w+)/.exec(outer(html).join(' '))?.[1] ?? ''];
    const navWidth = rem(/<nav [^>]*class="[^"]*xl:w-(\d+)/.exec(html)?.[1] ?? 'NaN');
    const gap = rem(/xl:flex-row[^"]*xl:gap-(\d+)/.exec(html)?.[1] ?? 'NaN');
    const room = (frameWidth ?? 0) - navWidth - gap;

    const PLAN_COLUMNS_REM = 56;
    const COMPARISON_TABLE_REM = 52;
    expect(frameWidth).toBeDefined();
    expect(room).toBeGreaterThanOrEqual(PLAN_COLUMNS_REM);
    expect(room).toBeGreaterThanOrEqual(COMPARISON_TABLE_REM);
  });
});
