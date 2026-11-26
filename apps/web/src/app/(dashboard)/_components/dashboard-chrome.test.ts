import { describe, expect, it } from 'vitest';

import { parseDashboardPath } from '../_lib/paths';
import { buildBreadcrumbs, trailPath } from './dashboard-chrome';

/**
 * The breadcrumb trail: every crumb labelled with what the thing is called, and
 * linked by its slug, which is the identifier and belongs in the URL.
 */

const NAMES = { org: 'Acme', project: 'Payments API', environment: 'Production' };

describe('the breadcrumb trail', () => {
  it('names the project and the environment by their display names, and links by slug', () => {
    const trail = buildBreadcrumbs(parseDashboardPath('/app/acme/payments-api/production'), NAMES);

    expect(trail).toEqual([
      { label: 'Acme', href: '/app/acme' },
      { label: 'Payments API', href: '/app/acme/payments-api' },
      { label: 'Production', href: '/app/acme/payments-api/production' },
    ]);
  });

  it('shows the slug only while a name is not known', () => {
    const trail = buildBreadcrumbs(parseDashboardPath('/app/acme/payments-api/production'), {
      org: null,
      project: null,
      environment: null,
    });

    expect(trail.map((crumb) => crumb.label)).toEqual(['acme', 'payments-api', 'production']);
  });

  it('stops at the deepest resource in the URL', () => {
    expect(buildBreadcrumbs(parseDashboardPath('/app/acme/payments-api'), NAMES)).toEqual([
      { label: 'Acme', href: '/app/acme' },
      { label: 'Payments API', href: '/app/acme/payments-api' },
    ]);
    // An organisation page holds no project, whatever names are to hand.
    expect(buildBreadcrumbs(parseDashboardPath('/app/acme/members'), NAMES)).toEqual([
      { label: 'Acme', href: '/app/acme' },
    ]);
    expect(buildBreadcrumbs(parseDashboardPath('/app/settings/account'), NAMES)).toEqual([
      { label: 'Account' },
    ]);
  });

  it('names the admin page, not an organisation called "admin"', () => {
    expect(buildBreadcrumbs(parseDashboardPath('/app/admin'), NAMES)).toEqual([{ label: 'Admin' }]);
  });
});

describe('what the trail reads its names from', () => {
  const unlocked = { configured: true, unlocked: true, unlockedUntil: null, autoLockMinutes: 0 };
  const locked = { ...unlocked, unlocked: false };
  const inProject = parseDashboardPath('/app/acme/payments-api/production');

  it('is the project the URL is inside, once the vault is unlocked', () => {
    expect(trailPath(inProject, unlocked)).toBe('/api/orgs/acme/projects/payments-api');
  });

  it('is nothing while the session is unknown or locked, so the unlock is what reads it', () => {
    // A cold load onto a locked vault used to read the project behind the lock
    // screen, be refused, and never ask again: the path had not changed. Held
    // back until the unlock, the unlock is the change that reads it.
    expect(trailPath(inProject, undefined)).toBeNull();
    expect(trailPath(inProject, locked)).toBeNull();
    expect(trailPath(inProject, { ...unlocked, configured: false })).toBeNull();
  });

  it('is nothing outside a project', () => {
    expect(trailPath(parseDashboardPath('/app/acme'), unlocked)).toBeNull();
    expect(trailPath(parseDashboardPath('/app/acme/members'), unlocked)).toBeNull();
    expect(trailPath(parseDashboardPath('/app/settings/account'), unlocked)).toBeNull();
  });
});
