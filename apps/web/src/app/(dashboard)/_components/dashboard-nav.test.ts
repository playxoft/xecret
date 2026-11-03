import { describe, expect, it } from 'vitest';

import { isNavItemActive } from '@/components/layout/sidebar';
import { parseDashboardPath } from '../_lib/paths';
import { dashboardNav } from './dashboard-nav';

/**
 * The sidebar for a pathname, the way the chrome builds it: the URL parsed by
 * the same `parseDashboardPath`, then the nav, then which row each page lights.
 */
function sidebarAt(pathname: string) {
  const location = parseDashboardPath(pathname);
  const items = dashboardNav({
    orgSlug: location.orgSlug ?? 'acme',
    projectSlug: location.projectSlug,
    viewer: null,
  }).flatMap((section) => section.items);
  return {
    items,
    active: items.filter((item) => isNavItemActive(pathname, item)).map((item) => item.label),
  };
}

describe('the dashboard sidebar', () => {
  it('shows Projects as one row that goes to the projects page, with no list under it', () => {
    const { items } = sidebarAt('/app/acme/payments-api');
    const projects = items.find((item) => item.label === 'Projects');

    expect(projects?.href).toBe('/app/acme');
    // Nothing nested and nothing per project: the row is the whole of it.
    expect(Object.keys(projects ?? {})).not.toContain('children');
    expect(items.map((item) => item.href)).not.toContain('/app/acme/payments-api');
  });

  it('lights Projects on the projects page and on every project and environment page', () => {
    for (const pathname of [
      '/app/acme',
      '/app/acme/payments-api',
      '/app/acme/payments-api/production',
      '/app/acme/payments-api/production/settings',
    ]) {
      expect(sidebarAt(pathname).active, pathname).toEqual(['Projects']);
    }
  });

  it('lights the organisation’s other pages on their own, never Projects with them', () => {
    expect(sidebarAt('/app/acme/members').active).toEqual(['Members']);
    expect(sidebarAt('/app/acme/settings').active).toEqual(['Organisation settings']);
    expect(sidebarAt('/app/acme/settings/billing').active).toEqual(['Organisation settings']);
  });

  it('lights nothing in the account area, which belongs to no organisation', () => {
    expect(sidebarAt('/app/settings/account').active).toEqual([]);
  });
});
