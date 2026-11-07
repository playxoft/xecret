import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import type { ProjectView } from '@/components/projects/project-listing';
import type { ProjectListResponse } from '@/components/projects/types';
import type { SessionOrganization } from './session';

/**
 * The Projects page, rendered to static markup with what the API would answer
 * handed to the data hook — a server render runs no effects, so nothing can be
 * typed into the search here. What the search and the sort *do* is pinned in
 * `project-listing.test.ts`; this pins what is drawn: the toolbar, which layout
 * is lit, the order the cards arrive in, and the notice when the API held
 * projects back.
 */

const viewer = vi.hoisted(() => ({ organization: null as SessionOrganization | null }));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useOrganization: () => viewer.organization,
}));

const listing = vi.hoisted(() => ({ current: null as ProjectListResponse | null }));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: () => ({
    data: listing.current,
    error: null,
    loading: false,
    reload: async () => {},
  }),
}));

// A server render reads the server snapshot, which is always the grid; this
// stands in for a browser that remembered the list.
const remembered = vi.hoisted(() => ({ view: 'grid' as ProjectView }));

vi.mock('@/components/projects/project-listing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/projects/project-listing')>();
  return {
    ...actual,
    projectViewStore: {
      ...actual.projectViewStore,
      getSnapshot: () => remembered.view,
      getServerSnapshot: () => remembered.view,
    },
  };
});

const { Toaster, TooltipProvider } = await import('@/components/ui');
const { ProjectsScreen } = await import('./projects-screen');

function organization(role: OrgRole): SessionOrganization {
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: { role, customRole: null, ...authoritySummary({ role }) },
  };
}

function project(slug: string, updatedAt: string, createdAt = '2026-01-01T00:00:00.000Z') {
  return { name: slug, slug, description: null, createdAt, updatedAt, environmentCount: 3 };
}

function render(): string {
  viewer.organization = organization('developer');
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(Toaster, null, createElement(ProjectsScreen, { orgSlug: 'acme' })),
    ),
  );
}

/** The project hrefs, in the order they are drawn. */
function order(html: string): string[] {
  return [...html.matchAll(/href="\/app\/acme\/([a-z-]+)"/g)].map((match) => match[1] ?? '');
}

/** The opening tag of the button labelled `label`. */
function button(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html);
  if (match === null) throw new Error(`no button labelled ${label}`);
  return match[0];
}

const LISTING: ProjectListResponse = {
  // The API's order: newest first by creation. `renamed` is the oldest, but was
  // edited last.
  projects: [
    project('web', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
    project('api', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
    project('renamed', '2026-04-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ],
  page: 1,
  pageSize: 200,
  hasMore: false,
};

beforeEach(() => {
  remembered.view = 'grid';
  listing.current = LISTING;
});

describe('ProjectsScreen', () => {
  it('draws the search, the sort and the layout toggle above the projects', () => {
    const html = render();

    expect(html).toContain('aria-label="Filter projects"');
    expect(html).toContain('placeholder="Filter by name, slug or description"');
    expect(html).toContain('aria-label="Sort projects"');
    expect(html).toContain('role="group" aria-label="Layout"');
    expect(html).toContain('3 projects');
  });

  it('opens on the grid, most recently updated first', () => {
    const html = render();

    expect(button(html, 'Grid view')).toContain('aria-pressed="true"');
    expect(button(html, 'List view')).toContain('aria-pressed="false"');
    // Not the API's creation order (web, api, renamed): the last edited first.
    expect(order(html)).toEqual(['renamed', 'web', 'api']);
    expect(html).toContain('sm:grid-cols-2');
  });

  it('draws rows, with the same links in the same order, when the list was chosen', () => {
    remembered.view = 'list';
    const html = render();

    expect(button(html, 'List view')).toContain('aria-pressed="true"');
    expect(button(html, 'Grid view')).toContain('aria-pressed="false"');
    expect(order(html)).toEqual(['renamed', 'web', 'api']);
    expect(html).toContain('<ul class="flex flex-col gap-2">');
    expect(html).not.toContain('sm:grid-cols-2');
  });

  it('says which projects arrived, and what a search covers, when the API held some back', () => {
    listing.current = { ...LISTING, hasMore: true };
    const html = render();

    expect(html).toContain('The 3 most recently created projects');
    expect(html).toContain('Showing the 200 most recently created projects.');
    expect(html).toContain('Search and sort cover these only.');
    expect(html).not.toContain('Showing the first 200');
  });

  it('keeps the first-project welcome, and no toolbar, for an empty organisation', () => {
    listing.current = { ...LISTING, projects: [] };
    const html = render();

    expect(html).toContain('Start with your first project');
    expect(html).not.toContain('aria-label="Filter projects"');
    expect(html).not.toContain('aria-label="Layout"');
  });
});
