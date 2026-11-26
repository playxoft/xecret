import { describe, expect, it } from 'vitest';

import { isNavItemActive } from '@/components/layout/sidebar';
import { parseDashboardPath } from '../_lib/paths';
import { dashboardNav } from './dashboard-nav';

/** A project's id: what the project and environment pages are addressed by. */
const PROJECT_ID = '0193f2a1-7c3e-7d2a-9b1f-2a3b4c5d6e7f';

/**
 * The sidebar for a pathname, the way the chrome builds it: the URL parsed by
 * the same `parseDashboardPath`, then the nav, then which row each page lights.
 */
function sidebarAt(pathname: string) {
  const location = parseDashboardPath(pathname);
  const items = dashboardNav({
    orgSlug: location.orgSlug ?? 'acme',
    projectId: location.projectId,
    viewer: null,
  }).flatMap((section) => section.items);
  return {
    items,
    active: items.filter((item) => isNavItemActive(pathname, item)).map((item) => item.label),
  };
}

describe('the dashboard sidebar', () => {
  it('shows Projects as one row that goes to the projects page, with no list under it', () => {
    const { items } = sidebarAt(`/app/acme/${PROJECT_ID}`);
    const projects = items.find((item) => item.label === 'Projects');

    expect(projects?.href).toBe('/app/acme');
    // Nothing nested and nothing per project: the row is the whole of it.
    expect(Object.keys(projects ?? {})).not.toContain('children');
    expect(items.map((item) => item.href)).not.toContain(`/app/acme/${PROJECT_ID}`);
  });

  it('lights Projects on the projects page and on every project and environment page', () => {
    for (const pathname of [
      '/app/acme',
      `/app/acme/${PROJECT_ID}`,
      `/app/acme/${PROJECT_ID}/production`,
      `/app/acme/${PROJECT_ID}/production/settings`,
      `/app/acme/${PROJECT_ID}/production/settings/encryption`,
    ]) {
      expect(sidebarAt(pathname).active, pathname).toEqual(['Projects']);
    }
  });

  it('lights the organisation’s other pages on their own, never Projects with them', () => {
    expect(sidebarAt('/app/acme/members').active).toEqual(['Members']);
    expect(sidebarAt('/app/acme/settings').active).toEqual(['Organisation settings']);
    expect(sidebarAt('/app/acme/settings/billing').active).toEqual(['Organisation settings']);
    // …and on every other section of the organisation's settings.
    for (const section of ['roles', 'single-sign-on', 'policies', 'webhooks', 'plans', 'danger']) {
      expect(sidebarAt(`/app/acme/settings/${section}`).active, section).toEqual([
        'Organisation settings',
      ]);
    }
  });

  it('lights nothing in the account area, which belongs to no organisation', () => {
    expect(sidebarAt('/app/settings/account').active).toEqual([]);
    expect(sidebarAt('/app/settings/vault').active).toEqual([]);
  });
});
