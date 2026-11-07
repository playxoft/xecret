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
 * handed to the data hook. What the search and the sort *do* is pinned in
 * `project-listing.test.ts`; this pins what is drawn: the toolbar, which layout
 * is lit, the order the cards arrive in, the count, and the notice when the API
 * held projects back.
 *
 * ── The gap, stated ──
 * Nothing can be typed into the search here. A server render runs no effects
 * and fires no events, and this suite has no DOM (no jsdom, no testing
 * library), so the screen is only ever seen with an empty query. What a query
 * changes is covered one level down instead: whether the screen counts as
 * filtering is `isFiltering`, which the screen calls rather than restating and
 * which is tested there, and what a filtering list row draws is rendered below
 * through `ProjectRows` directly with `revealDescriptions`, the prop the screen
 * passes `filtering` to.
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
const { ProjectRows } = await import('@/components/projects/project-cards');

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
    // Three readable projects with `hasMore`: the route pages, then drops what
    // the viewer cannot open, so far fewer than 200 can arrive. The count and
    // the note must agree — the count says how many, the note how they were
    // chosen — where they once read "The 3 most recently created projects"
    // above "Showing the 200 most recently created projects".
    listing.current = { ...LISTING, hasMore: true };
    const html = render();

    expect(html).toContain('3 projects — only the most recently created are loaded');
    expect(html).toContain(
      'Only the organisation’s 200 most recently created projects are loaded, and of those, the ones you can open are listed. Search and sort cover only these.',
    );
    expect(html).not.toContain('The 3 most recently created');
    expect(html).not.toContain('Showing the');
  });

  it('draws the count at once and hands screen readers the same words in a live region', () => {
    const html = render();

    // Visible, and hidden from assistive technology so it is not read twice…
    expect(html).toContain('<p aria-hidden="true" class="text-fg-subtle text-sm">3 projects</p>');
    // …while the polite region — debounced while typing — starts out holding it.
    expect(html).toContain('<p role="status" aria-live="polite" class="sr-only">3 projects</p>');
  });

  it('keeps the list rows to name and slug below `xl` while nothing is searched', () => {
    remembered.view = 'list';
    listing.current = {
      ...LISTING,
      projects: [{ ...project('web', '2026-03-01T00:00:00.000Z'), description: 'Storefront' }],
    };
    const html = render();

    // The `xl` column only; no line under the slug with no search to explain.
    expect(html.match(/Storefront/g)).toHaveLength(1);
    expect(html).not.toContain('xl:hidden');
  });

  it('keeps the first-project welcome, and no toolbar, for an empty organisation', () => {
    listing.current = { ...LISTING, projects: [] };
    const html = render();

    expect(html).toContain('Start with your first project');
    expect(html).not.toContain('aria-label="Filter projects"');
    expect(html).not.toContain('aria-label="Layout"');
  });
});

describe('ProjectRows while a search is narrowing the list', () => {
  // What the screen draws in the list once `isFiltering(query)` is true — the
  // value it passes as `revealDescriptions`.
  function rows(revealDescriptions: boolean): string {
    return renderToStaticMarkup(
      createElement(ProjectRows, {
        orgSlug: 'acme',
        revealDescriptions,
        projects: [
          { ...project('web', '2026-03-01T00:00:00.000Z'), description: 'Storefront and checkout' },
          project('api', '2026-02-01T00:00:00.000Z'),
        ],
      }),
    );
  }

  it('shows each description under its slug below `xl`, so a description-only match has a visible reason', () => {
    const html = rows(true);

    expect(html).toContain(
      '<span class="text-fg-muted block truncate text-sm xl:hidden">Storefront and checkout</span>',
    );
  });

  it('adds nothing for a project with no description — the placeholder explains no match', () => {
    const html = rows(true);

    // One line under a slug, for the one project that has a description.
    expect(html.match(/xl:hidden/g)).toHaveLength(1);
  });

  it('leaves the rows alone when nothing is searched', () => {
    expect(rows(false)).not.toContain('xl:hidden');
  });
});
