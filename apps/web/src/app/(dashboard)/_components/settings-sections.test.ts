import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { authoritySummary } from '@xecret/core/authz';
import type { Action, CustomRole, OrgRole } from '@xecret/core/authz';

import { appPath } from '../_lib/paths';
import type { SessionOrganization } from './session';
import {
  accountSettingsSections,
  activeSettingsSection,
  environmentSettingsSections,
  legacyAnchorTarget,
  organizationSettingsSections,
  visibleSettingsGroups,
} from './settings-sections';
import type { SettingsSectionGroup } from './settings-sections';

/**
 * Each settings area's list of sections: which a viewer is shown, which one a
 * pathname is, where a fragment from before the sections had addresses is
 * sent — and that every address in the lists is a page that exists.
 */

/** A session organisation, as `/api/auth/me` builds one. */
function member(role: OrgRole, customRole?: CustomRole): SessionOrganization {
  const summary = authoritySummary({ role, customRole });
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: {
      role,
      customRole:
        customRole === undefined
          ? null
          : { id: customRole.id, name: customRole.name, baseRole: customRole.baseRole },
      ...summary,
    },
  };
}

/** An admin whose custom role withholds `without`. */
function narrowedAdmin(without: Action): SessionOrganization {
  const base = authoritySummary({ role: 'admin' }).capabilities;
  return member('admin', {
    id: 'role-1',
    name: 'Narrowed',
    baseRole: 'admin',
    allowedActions: base.filter((action) => action !== without),
  });
}

/** The labels a viewer is shown, in order. */
function shown(groups: readonly SettingsSectionGroup[]): string[] {
  return visibleSettingsGroups(groups).flatMap((group) =>
    group.sections.map((section) => section.label),
  );
}

const ENV_SETTINGS = appPath.environmentSettings('acme', 'payments-api', 'production');

describe('the account settings', () => {
  it('lists the account’s sections, and nothing of any organisation’s', () => {
    expect(shown(accountSettingsSections({ vaultConfigured: true }))).toEqual([
      'Profile',
      'Appearance',
      'Password & sign-in',
      'Vault',
      'Unlock & auto-lock',
      'Signed-in devices',
      'Danger zone',
    ]);
  });

  it('keeps Profile at the address the account menu has always opened', () => {
    const [first] = visibleSettingsGroups(accountSettingsSections({ vaultConfigured: true }));
    expect(first?.sections[0]?.href).toBe('/app/settings/account');
  });

  it('leaves out the unlock until there is a vault to unlock', () => {
    expect(shown(accountSettingsSections({ vaultConfigured: false }))).not.toContain(
      'Unlock & auto-lock',
    );
  });

  it('keeps the security sections together, as the Security tab kept them', () => {
    const groups = visibleSettingsGroups(accountSettingsSections({ vaultConfigured: true }));
    expect(groups.map((group) => group.sections.map((section) => section.label))).toEqual([
      ['Profile', 'Appearance'],
      ['Password & sign-in', 'Vault', 'Unlock & auto-lock', 'Signed-in devices'],
      ['Danger zone'],
    ]);
  });
});

describe('an organisation’s settings', () => {
  const organization = (viewer: SessionOrganization | null) =>
    shown(organizationSettingsSections('acme', viewer));

  it('lists every section for an owner', () => {
    expect(organization(member('owner'))).toEqual([
      'General',
      'Roles',
      'Single sign-on',
      'Policies',
      'Webhooks',
      'Billing',
      'Plans',
      'Danger zone',
    ]);
  });

  it('hides billing and the deletion from an admin, as the old page hid their cards', () => {
    expect(organization(member('admin'))).toEqual([
      'General',
      'Roles',
      'Single sign-on',
      'Policies',
      'Webhooks',
      'Plans',
    ]);
  });

  it('shows a developer and a viewer only what every member may read', () => {
    for (const role of ['developer', 'viewer'] as const) {
      expect(organization(member(role)), role).toEqual(['General', 'Policies', 'Plans']);
    }
  });

  it('takes away exactly the section an admin’s custom role withholds', () => {
    expect(organization(narrowedAdmin('member.update'))).not.toContain('Roles');
    const withoutUpdate = organization(narrowedAdmin('org.update'));
    expect(withoutUpdate).not.toContain('Single sign-on');
    expect(withoutUpdate).not.toContain('Webhooks');
    expect(withoutUpdate).toContain('Roles');
  });

  it('shows somebody who is not a member only the sections every member reads', () => {
    expect(organization(null)).toEqual(['General', 'Policies', 'Plans']);
  });

  it('keeps billing and the plans where Dodo and the emails send people', () => {
    const sections = organizationSettingsSections('acme', member('owner')).flatMap(
      (group) => group.sections,
    );
    const href = (label: string) => sections.find((section) => section.label === label)?.href;

    expect(href('General')).toBe(appPath.orgSettings('acme'));
    expect(href('Billing')).toBe(appPath.orgBilling('acme'));
    expect(href('Plans')).toBe(appPath.orgPlans('acme'));
  });
});

describe('an environment’s settings', () => {
  it('lists every section for somebody who can delete it', () => {
    const groups = environmentSettingsSections(ENV_SETTINGS, member('admin'));
    expect(shown(groups)).toEqual([
      'General',
      'Encryption key',
      'Inheritance',
      'Policy',
      'Danger zone',
    ]);
    expect(groups.flatMap((group) => group.sections.map((section) => section.href))).toEqual([
      '/app/acme/payments-api/production/settings',
      '/app/acme/payments-api/production/settings/encryption',
      '/app/acme/payments-api/production/settings/inheritance',
      '/app/acme/payments-api/production/settings/policy',
      '/app/acme/payments-api/production/settings/danger',
    ]);
  });

  it('hides the deletion from anybody without environment.delete', () => {
    for (const viewer of [
      member('developer'),
      member('viewer'),
      narrowedAdmin('environment.delete'),
    ]) {
      expect(shown(environmentSettingsSections(ENV_SETTINGS, viewer))).toEqual([
        'General',
        'Encryption key',
        'Inheritance',
        'Policy',
      ]);
    }
  });
});

describe('which section a pathname is', () => {
  const organization = organizationSettingsSections('acme', member('owner'));

  it('matches exactly, so General is not lit on every page beneath it', () => {
    expect(activeSettingsSection(organization, '/app/acme/settings')?.label).toBe('General');
    expect(activeSettingsSection(organization, '/app/acme/settings/webhooks')?.label).toBe(
      'Webhooks',
    );
    expect(activeSettingsSection(organization, '/app/acme/settings/billing')?.label).toBe(
      'Billing',
    );
  });

  it('forgives a trailing slash', () => {
    expect(activeSettingsSection(organization, '/app/acme/settings/policies/')?.label).toBe(
      'Policies',
    );
  });

  it('is nothing outside the area', () => {
    expect(activeSettingsSection(organization, '/app/acme/members')).toBeUndefined();
    expect(activeSettingsSection(organization, '/app/acme/settings/nonsense')).toBeUndefined();
  });

  it('still names a section the viewer is not shown, for a visit to its address', () => {
    const developer = organizationSettingsSections('acme', member('developer'));
    expect(activeSettingsSection(developer, '/app/acme/settings/danger')?.label).toBe(
      'Danger zone',
    );
  });
});

describe('a fragment from before the sections had addresses', () => {
  const account = accountSettingsSections({ vaultConfigured: true });

  it('is sent on to the section that holds its card now', () => {
    // `/app/settings/security` redirects to the vault, and the browser carries
    // the fragment along: what arrives is the vault's address with the old
    // fragment on it.
    expect(legacyAnchorTarget(account, '/app/settings/vault', '#devices')).toBe(
      '/app/settings/devices#devices',
    );
    expect(legacyAnchorTarget(account, '/app/settings/vault', '#sign-in')).toBe(
      '/app/settings/sign-in#sign-in',
    );
    expect(legacyAnchorTarget(account, '/app/settings/vault', '#unlock')).toBe(
      '/app/settings/unlock#unlock',
    );
    expect(legacyAnchorTarget(account, '/app/settings/account', '#appearance')).toBe(
      '/app/settings/appearance#appearance',
    );
  });

  it('stays put when the card is already on the page', () => {
    expect(legacyAnchorTarget(account, '/app/settings/vault', '#previous-vaults')).toBeNull();
    expect(legacyAnchorTarget(account, '/app/settings/vault', '#vault')).toBeNull();
    expect(legacyAnchorTarget(account, '/app/settings/danger', '#delete-account')).toBeNull();
    // …which is also what stops the forwarded visit being forwarded again.
    expect(legacyAnchorTarget(account, '/app/settings/devices', '#devices')).toBeNull();
  });

  it('forwards the organisation’s two anchored cards', () => {
    const organization = organizationSettingsSections('acme', member('owner'));
    expect(legacyAnchorTarget(organization, '/app/acme/settings', '#single-sign-on')).toBe(
      '/app/acme/settings/single-sign-on#single-sign-on',
    );
    expect(legacyAnchorTarget(organization, '/app/acme/settings', '#webhooks')).toBe(
      '/app/acme/settings/webhooks#webhooks',
    );
  });

  it('still leads to a section the viewer is not shown, which says who may use it', () => {
    const developer = organizationSettingsSections('acme', member('developer'));
    expect(legacyAnchorTarget(developer, '/app/acme/settings', '#webhooks')).toBe(
      '/app/acme/settings/webhooks#webhooks',
    );
  });

  it('leaves alone a fragment nobody gave a card, and one that is not a fragment', () => {
    expect(legacyAnchorTarget(account, '/app/settings/vault', '')).toBeNull();
    expect(legacyAnchorTarget(account, '/app/settings/vault', '#')).toBeNull();
    expect(legacyAnchorTarget(account, '/app/settings/vault', '#nowhere')).toBeNull();
    expect(legacyAnchorTarget(account, '/app/settings/vault', '#%E0%A4%A')).toBeNull();
  });
});

/**
 * The lists and the pages are two halves of one thing — a section in a list
 * with no page is a nav item that 404s, and a page in no list is a section
 * nobody can find. Read from the file tree, so adding either half alone fails
 * here.
 */
describe('every section is a page, and every page is a section', () => {
  const app = fileURLToPath(new URL('../app/', import.meta.url));

  /** The sub-folders of a settings folder that hold a page. */
  function pageFolders(settingsFolder: string): string[] {
    return readdirSync(`${app}${settingsFolder}`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(`${app}${settingsFolder}/${entry.name}/page.tsx`))
      .map((entry) => entry.name)
      .sort();
  }

  /** The last path segment of every section below the area's own address. */
  function sectionFolders(groups: readonly SettingsSectionGroup[], areaHref: string): string[] {
    return groups
      .flatMap((group) => group.sections.map((section) => section.href))
      .filter((href) => href !== areaHref)
      .map((href) => href.slice(areaHref.length + 1))
      .sort();
  }

  it('in the account’s settings', () => {
    const groups = accountSettingsSections({ vaultConfigured: true });
    expect(pageFolders('settings')).toEqual(sectionFolders(groups, '/app/settings'));
  });

  it('in an organisation’s settings', () => {
    const groups = organizationSettingsSections('acme', member('owner'));
    expect(existsSync(`${app}[orgSlug]/settings/page.tsx`)).toBe(true);
    expect(pageFolders('[orgSlug]/settings')).toEqual(
      sectionFolders(groups, appPath.orgSettings('acme')),
    );
  });

  it('in an environment’s settings', () => {
    const groups = environmentSettingsSections(ENV_SETTINGS, member('owner'));
    expect(existsSync(`${app}[orgSlug]/[projectId]/[envSlug]/settings/page.tsx`)).toBe(true);
    expect(pageFolders('[orgSlug]/[projectId]/[envSlug]/settings')).toEqual(
      sectionFolders(groups, ENV_SETTINGS),
    );
  });
});

/**
 * The Security tab's old address is in mail nobody can recall, so it still
 * answers — with an HTTP redirect from `next.config.ts`, not a page: a page
 * that only redirects is prerendered, and a prerendered redirect runs in the
 * client router, which drops the fragment `legacyAnchorTarget` reads. Pinned on
 * the source, because the config cannot be imported here without starting the
 * Cloudflare dev shim it ends with.
 */
describe('the Security tab’s old address', () => {
  it('redirects to the vault over HTTP, so a fragment on it survives the trip', () => {
    const config = readFileSync(new URL('../../../../next.config.ts', import.meta.url), 'utf8');
    expect(config).toContain(
      "{ source: '/app/settings/security', destination: '/app/settings/vault', permanent: false }",
    );
    expect(appPath.settingsVault()).toBe('/app/settings/vault');
  });

  it('is not also a page, which would answer before the redirect could', () => {
    const app = fileURLToPath(new URL('../app/', import.meta.url));
    expect(existsSync(`${app}settings/security/page.tsx`)).toBe(false);
  });
});
