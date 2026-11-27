import { describe, expect, it } from 'vitest';

import { parseDashboardPath } from '../_lib/paths';
import { buildBreadcrumbs, trailCarry, trailPath } from './dashboard-chrome';

/**
 * The breadcrumb trail: every crumb labelled with what the thing is called, and
 * linked by the address the URL uses — the project by its id, the organisation
 * and the environment by slug.
 */

const NAMES = { org: 'Acme', project: 'Payments API', environment: 'Production' };
const PROJECT_ID = '0193f2a1-7c3e-7d2a-9b1f-2a3b4c5d6e7f';

describe('the breadcrumb trail', () => {
  it('names the project and the environment by their display names, and links by id', () => {
    const trail = buildBreadcrumbs(parseDashboardPath(`/app/acme/${PROJECT_ID}/production`), NAMES);

    expect(trail).toEqual([
      { label: 'Acme', href: '/app/acme' },
      { label: 'Payments API', href: `/app/acme/${PROJECT_ID}` },
      { label: 'Production', href: `/app/acme/${PROJECT_ID}/production` },
    ]);
  });

  it('shows the slugs only while a name is not known — and never the project’s id', () => {
    const trail = buildBreadcrumbs(parseDashboardPath(`/app/acme/${PROJECT_ID}/production`), {
      org: null,
      project: null,
      environment: null,
    });

    expect(trail.map((crumb) => crumb.label)).toEqual(['acme', 'Project', 'production']);
    expect(JSON.stringify(trail.map((crumb) => crumb.label))).not.toContain(PROJECT_ID);
  });

  it('shows an old address’s slug for the moment before it is replaced', () => {
    const trail = buildBreadcrumbs(parseDashboardPath('/app/acme/payments-api'), {
      org: null,
      project: null,
      environment: null,
    });

    expect(trail.map((crumb) => crumb.label)).toEqual(['acme', 'payments-api']);
  });

  it('stops at the deepest resource in the URL', () => {
    expect(buildBreadcrumbs(parseDashboardPath(`/app/acme/${PROJECT_ID}`), NAMES)).toEqual([
      { label: 'Acme', href: '/app/acme' },
      { label: 'Payments API', href: `/app/acme/${PROJECT_ID}` },
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
    // Nor one organisation's or account's page beneath it: never a project
    // called "organizations" in an organisation called "admin".
    for (const page of [
      `/app/admin/organizations/${PROJECT_ID}`,
      `/app/admin/users/${PROJECT_ID}`,
    ]) {
      expect(buildBreadcrumbs(parseDashboardPath(page), NAMES), page).toEqual([{ label: 'Admin' }]);
    }
  });
});

describe('what the trail reads its names from', () => {
  const unlocked = { configured: true, unlocked: true, unlockedUntil: null, autoLockMinutes: 0 };
  const locked = { ...unlocked, unlocked: false };
  const inProject = parseDashboardPath(`/app/acme/${PROJECT_ID}/production`);

  it('is the project the URL is inside, by the id the URL names it by', () => {
    expect(trailPath(inProject, unlocked)).toBe(`/api/orgs/acme/projects/${PROJECT_ID}`);
  });

  it('is the same project on an old address, which the API still resolves by slug', () => {
    expect(trailPath(parseDashboardPath('/app/acme/payments-api'), unlocked)).toBe(
      '/api/orgs/acme/projects/payments-api',
    );
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

/**
 * Where the trail's read carries the mode pins this browser filed under a
 * project's slug: to the id the pages read under — the URL's — and from the
 * slug this browser itself held wherever it has one.
 */
describe('where the trail carries slug-filed mode pins', () => {
  it('copies to the id in the URL, never to an id the response chose', () => {
    const answered = { id: '0193f2a1-0000-7000-8000-000000000bad', slug: 'api' };
    expect(trailCarry(PROJECT_ID, answered)).toEqual({ projectId: PROJECT_ID, slugs: ['api'] });
  });

  it('copies from the URL’s own slug first on an old address, to the id it is going to', () => {
    expect(trailCarry('API', { id: PROJECT_ID, slug: 'api' })).toEqual({
      projectId: PROJECT_ID,
      slugs: ['API', 'api'],
    });
  });
});
