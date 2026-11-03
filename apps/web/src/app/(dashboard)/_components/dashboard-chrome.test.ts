import { describe, expect, it } from 'vitest';

import { parseDashboardPath } from '../_lib/paths';
import { buildBreadcrumbs } from './dashboard-chrome';

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
});
