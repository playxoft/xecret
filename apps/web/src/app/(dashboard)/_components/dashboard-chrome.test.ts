import { describe, expect, it } from 'vitest';

import { parseDashboardPath } from '../_lib/paths';
import { buildBreadcrumbs, trailCarry, trailPath, urlOrganizationId } from './dashboard-chrome';

/**
 * The breadcrumb trail: every crumb labelled with what the thing is called, and
 * linked by the address the URL uses — the organisation and the project by
 * their ids, the environment by slug.
 */

const NAMES = { org: 'Acme', project: 'Payments API', environment: 'Production' };
const ORG_ID = '0193f2a1-0000-7000-8000-00000000a001';
const PROJECT_ID = '0193f2a1-7c3e-7d2a-9b1f-2a3b4c5d6e7f';

describe('the breadcrumb trail', () => {
  it('names the organisation, the project and the environment by their display names, and links by id', () => {
    const trail = buildBreadcrumbs(
      parseDashboardPath(`/app/${ORG_ID}/${PROJECT_ID}/production`),
      NAMES,
    );

    expect(trail).toEqual([
      { label: 'Acme', href: `/app/${ORG_ID}` },
      { label: 'Payments API', href: `/app/${ORG_ID}/${PROJECT_ID}` },
      { label: 'Production', href: `/app/${ORG_ID}/${PROJECT_ID}/production` },
    ]);
  });

  it('shows the environment’s slug only while a name is not known, and never an id', () => {
    const trail = buildBreadcrumbs(parseDashboardPath(`/app/${ORG_ID}/${PROJECT_ID}/production`), {
      org: null,
      project: null,
      environment: null,
    });

    expect(trail.map((crumb) => crumb.label)).toEqual(['Organisation', 'Project', 'production']);
    const labels = JSON.stringify(trail.map((crumb) => crumb.label));
    expect(labels).not.toContain(PROJECT_ID);
    expect(labels).not.toContain(ORG_ID);
  });

  it('never shows an old address’s organisation slug, even for the moment before it is replaced', () => {
    const trail = buildBreadcrumbs(parseDashboardPath('/app/acme/payments-api'), {
      org: null,
      project: null,
      environment: null,
    });

    // The project's slug is its Project ID, which is fit to show.
    expect(trail.map((crumb) => crumb.label)).toEqual(['Organisation', 'payments-api']);
  });

  it('stops at the deepest resource in the URL', () => {
    expect(buildBreadcrumbs(parseDashboardPath(`/app/${ORG_ID}/${PROJECT_ID}`), NAMES)).toEqual([
      { label: 'Acme', href: `/app/${ORG_ID}` },
      { label: 'Payments API', href: `/app/${ORG_ID}/${PROJECT_ID}` },
    ]);
    // An organisation page holds no project, whatever names are to hand.
    expect(buildBreadcrumbs(parseDashboardPath(`/app/${ORG_ID}/members`), NAMES)).toEqual([
      { label: 'Acme', href: `/app/${ORG_ID}` },
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
  const inProject = parseDashboardPath(`/app/${ORG_ID}/${PROJECT_ID}/production`);

  it('is the project the URL is inside, by the ids the URL names it by', () => {
    expect(trailPath(inProject, unlocked)).toBe(`/api/orgs/${ORG_ID}/projects/${PROJECT_ID}`);
  });

  it('is the same project on an old project address, which the API still resolves by slug', () => {
    expect(trailPath(parseDashboardPath(`/app/${ORG_ID}/payments-api`), unlocked)).toBe(
      `/api/orgs/${ORG_ID}/projects/payments-api`,
    );
  });

  /**
   * An address that names its organisation by slug draws nothing but its own
   * move to the id, and a trail read there would carry this browser's pins to
   * an address no page reads under.
   */
  it('is nothing on an old organisation address', () => {
    expect(
      trailPath(parseDashboardPath(`/app/acme/${PROJECT_ID}/production`), unlocked),
    ).toBeNull();
    expect(trailPath(parseDashboardPath('/app/acme/payments-api'), unlocked)).toBeNull();
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
    expect(trailPath(parseDashboardPath(`/app/${ORG_ID}`), unlocked)).toBeNull();
    expect(trailPath(parseDashboardPath(`/app/${ORG_ID}/members`), unlocked)).toBeNull();
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

/**
 * Which organisation the sidebar's links point at: the URL's, by id — on an
 * old address, the id its slug names, so the links lead where the page is
 * about to go rather than through the redirect again.
 */
describe('the organisation the URL names', () => {
  const memberships = [
    { id: ORG_ID, slug: 'acme' },
    { id: '0193f2a1-0000-7000-8000-00000000b002', slug: 'zebra' },
  ];

  it('is the id itself at an id address, member or not', () => {
    expect(urlOrganizationId(ORG_ID, memberships)).toBe(ORG_ID);
    const stranger = '0193f2a1-0000-7000-8000-00000000c003';
    expect(urlOrganizationId(stranger, memberships)).toBe(stranger);
  });

  it('is the id a legacy slug names, in any case', () => {
    expect(urlOrganizationId('acme', memberships)).toBe(ORG_ID);
    expect(urlOrganizationId('ACME', memberships)).toBe(ORG_ID);
  });

  it('is the segment as it stands for a slug that names no membership, and nothing off an organisation', () => {
    expect(urlOrganizationId('nobody', memberships)).toBe('nobody');
    expect(urlOrganizationId('acme', undefined)).toBe('acme');
    expect(urlOrganizationId(null, memberships)).toBeNull();
  });
});
