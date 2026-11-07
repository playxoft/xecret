import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  arrangeProjects,
  createProjectViewStore,
  DEFAULT_PROJECT_SORT,
  DEFAULT_PROJECT_VIEW,
  describeProjectCount,
  isProjectSort,
  isProjectView,
  matchesProjectQuery,
  PROJECT_SORT_LABELS,
  PROJECT_SORTS,
  PROJECT_VIEW_STORAGE_KEY,
  sortProjects,
} from './project-listing';
import type { ViewStorage } from './project-listing';
import type { ProjectListItem } from './types';

function project(fields: Partial<ProjectListItem> & { slug: string }): ProjectListItem {
  return {
    name: fields.slug,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    environmentCount: 3,
    ...fields,
  };
}

const slugs = (projects: readonly ProjectListItem[]) => projects.map((p) => p.slug);

describe('matchesProjectQuery', () => {
  const api = project({
    slug: 'billing-api',
    name: 'Billing API',
    description: 'Invoices and Stripe webhooks',
  });

  it('matches the name, the slug or the description, ignoring case', () => {
    expect(matchesProjectQuery(api, 'billing')).toBe(true);
    expect(matchesProjectQuery(api, 'BILLING-API')).toBe(true);
    expect(matchesProjectQuery(api, 'stripe')).toBe(true);
    expect(matchesProjectQuery(api, 'Invoices AND')).toBe(true);
  });

  it('matches anywhere in a field, not only at the start', () => {
    expect(matchesProjectQuery(api, 'ing-a')).toBe(true);
    expect(matchesProjectQuery(api, 'hooks')).toBe(true);
  });

  it('ignores surrounding whitespace, and an empty query matches everything', () => {
    expect(matchesProjectQuery(api, '  api  ')).toBe(true);
    expect(matchesProjectQuery(api, '')).toBe(true);
    expect(matchesProjectQuery(api, '   ')).toBe(true);
  });

  it('rejects what is in none of the three', () => {
    expect(matchesProjectQuery(api, 'frontend')).toBe(false);
  });

  it('does not search the placeholder drawn for a missing description', () => {
    // The card says "No description." where there is none; that is chrome, and
    // typing "description" should not match every undescribed project.
    const bare = project({ slug: 'worker', name: 'Worker', description: null });
    expect(matchesProjectQuery(bare, 'description')).toBe(false);
    expect(matchesProjectQuery(bare, 'null')).toBe(false);
  });
});

describe('sortProjects', () => {
  const alpha = project({
    slug: 'alpha',
    name: 'alpha',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    environmentCount: 3,
  });
  const beta = project({
    slug: 'beta',
    name: 'Beta',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    environmentCount: 5,
  });
  const gamma = project({
    slug: 'gamma',
    name: 'gamma',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    environmentCount: 1,
  });
  // The API's own order: newest first by creation.
  const fromApi = [gamma, beta, alpha];

  it('orders by last update, newest first', () => {
    expect(slugs(sortProjects(fromApi, 'updated'))).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('orders by name A–Z regardless of case', () => {
    expect(slugs(sortProjects(fromApi, 'name'))).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('orders numbered names by their numbers', () => {
    const nine = project({ slug: 's9', name: 'service-9' });
    const ten = project({ slug: 's10', name: 'service-10' });
    expect(slugs(sortProjects([ten, nine], 'name'))).toEqual(['s9', 's10']);
  });

  it('orders by creation, newest first — the API order', () => {
    expect(slugs(sortProjects([alpha, beta, gamma], 'created'))).toEqual(slugs(fromApi));
  });

  it('orders by environment count, most first', () => {
    expect(slugs(sortProjects(fromApi, 'environments'))).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('breaks an environment-count tie by name', () => {
    const zed = project({ slug: 'zed', name: 'Zed', environmentCount: 2 });
    const abe = project({ slug: 'abe', name: 'Abe', environmentCount: 2 });
    expect(slugs(sortProjects([zed, abe], 'environments'))).toEqual(['abe', 'zed']);
  });

  it.each([...PROJECT_SORTS])(
    'breaks a full tie on %s by slug, in either arrival order',
    (sort) => {
      // Same name, same timestamps, same count: only the slug differs.
      const one = project({ slug: 'one', name: 'Same' });
      const two = project({ slug: 'two', name: 'Same' });
      expect(slugs(sortProjects([two, one], sort))).toEqual(['one', 'two']);
      expect(slugs(sortProjects([one, two], sort))).toEqual(['one', 'two']);
    },
  );

  it('sinks an unparseable timestamp to the bottom instead of throwing', () => {
    const broken = project({ slug: 'broken', updatedAt: 'not a date', createdAt: 'nope' });
    expect(slugs(sortProjects([broken, alpha, beta], 'updated'))).toEqual([
      'alpha',
      'beta',
      'broken',
    ]);
    expect(slugs(sortProjects([broken, alpha], 'created'))).toEqual(['alpha', 'broken']);
  });

  it('returns a copy and leaves the response alone', () => {
    const input = [...fromApi];
    const sorted = sortProjects(input, 'name');
    expect(sorted).not.toBe(input);
    expect(slugs(input)).toEqual(slugs(fromApi));
  });
});

describe('arrangeProjects', () => {
  const projects = [
    project({ slug: 'web', name: 'Web', updatedAt: '2026-01-03T00:00:00.000Z' }),
    project({
      slug: 'api',
      name: 'API',
      description: 'The web backend',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
    project({ slug: 'cli', name: 'CLI', updatedAt: '2026-01-04T00:00:00.000Z' }),
  ];

  it('filters, then orders what is left', () => {
    expect(slugs(arrangeProjects(projects, 'web', 'name'))).toEqual(['api', 'web']);
    expect(slugs(arrangeProjects(projects, 'web', 'updated'))).toEqual(['web', 'api']);
  });

  it('with no query, is the whole list in order', () => {
    expect(slugs(arrangeProjects(projects, '', 'updated'))).toEqual(['cli', 'web', 'api']);
  });

  it('can come back empty', () => {
    expect(arrangeProjects(projects, 'nothing like this', 'name')).toEqual([]);
  });
});

describe('the sort options', () => {
  it('defaults to last updated', () => {
    expect(DEFAULT_PROJECT_SORT).toBe('updated');
  });

  it('labels every option it offers, once each', () => {
    for (const sort of PROJECT_SORTS) {
      expect(PROJECT_SORT_LABELS[sort]).toBeTruthy();
    }
    expect(new Set(PROJECT_SORTS).size).toBe(PROJECT_SORTS.length);
  });

  it('accepts only its own keys back from the menu', () => {
    for (const sort of PROJECT_SORTS) expect(isProjectSort(sort)).toBe(true);
    expect(isProjectSort('createdAt')).toBe(false);
    expect(isProjectSort('')).toBe(false);
    expect(isProjectSort(undefined)).toBe(false);
  });
});

describe('describeProjectCount', () => {
  it('states the total when nothing is being searched', () => {
    expect(describeProjectCount({ shown: 12, total: 12, hasMore: false, filtering: false })).toBe(
      '12 projects',
    );
    expect(describeProjectCount({ shown: 1, total: 1, hasMore: false, filtering: false })).toBe(
      '1 project',
    );
  });

  it('states how many of them a search left', () => {
    expect(describeProjectCount({ shown: 3, total: 12, hasMore: false, filtering: true })).toBe(
      '3 of 12 projects shown',
    );
    expect(describeProjectCount({ shown: 0, total: 12, hasMore: false, filtering: true })).toBe(
      '0 of 12 projects shown',
    );
  });

  it('says which projects arrived when the API held some back', () => {
    // Never "200 projects": there are more, and a search covers only these.
    expect(describeProjectCount({ shown: 200, total: 200, hasMore: true, filtering: false })).toBe(
      'The 200 most recently created projects',
    );
    expect(describeProjectCount({ shown: 3, total: 200, hasMore: true, filtering: true })).toBe(
      '3 of the 200 most recently created projects shown',
    );
  });
});

/* ── The remembered layout ───────────────────────────────────────────────── */

/** A `Storage` that can be inspected, or made to refuse. */
function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const faults = { reads: false, writes: false };
  const storage: ViewStorage = {
    getItem: (key) => {
      if (faults.reads) throw new Error('SecurityError');
      return values.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (faults.writes) throw new Error('QuotaExceededError');
      values.set(key, value);
    },
  };
  return { storage, values, faults };
}

/** What another tab's write looks like from this one. */
function storageEvent(key: string | null): Event {
  const event = new Event('storage');
  Object.defineProperty(event, 'key', { value: key });
  return event;
}

describe('the layout preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('knows its two layouts and nothing else', () => {
    expect(isProjectView('grid')).toBe(true);
    expect(isProjectView('list')).toBe(true);
    expect(isProjectView('table')).toBe(false);
    expect(isProjectView(null)).toBe(false);
  });

  it('is the grid on a first visit', () => {
    expect(DEFAULT_PROJECT_VIEW).toBe('grid');
    const { storage } = fakeStorage();
    expect(createProjectViewStore(() => storage).getSnapshot()).toBe('grid');
  });

  it('reads what was chosen last time', () => {
    const { storage } = fakeStorage({ [PROJECT_VIEW_STORAGE_KEY]: 'list' });
    expect(createProjectViewStore(() => storage).getSnapshot()).toBe('list');
  });

  it('treats a value it does not recognise as no choice at all', () => {
    const { storage } = fakeStorage({ [PROJECT_VIEW_STORAGE_KEY]: 'cards' });
    expect(createProjectViewStore(() => storage).getSnapshot()).toBe('grid');
  });

  it('renders the grid on the server, whatever this browser chose', () => {
    // The server has no storage, and hydration has to match what it sent.
    const { storage } = fakeStorage({ [PROJECT_VIEW_STORAGE_KEY]: 'list' });
    expect(createProjectViewStore(() => storage).getServerSnapshot()).toBe('grid');
  });

  it('remembers a choice under its one key, and tells its subscribers', () => {
    const { storage, values } = fakeStorage();
    const store = createProjectViewStore(() => storage);
    const listener = vi.fn();
    store.subscribe(listener);

    store.set('list');

    expect(store.getSnapshot()).toBe('list');
    // The layout and nothing else: the search and the sort are never written.
    expect([...values]).toEqual([[PROJECT_VIEW_STORAGE_KEY, 'list']]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('re-reads storage, so coming back to the page is never stale', () => {
    // Nobody was subscribed — this tab was on another screen — while a second
    // tab switched to the list. A copy read once would still say grid.
    const { storage, values } = fakeStorage();
    const store = createProjectViewStore(() => storage);
    expect(store.getSnapshot()).toBe('grid');

    values.set(PROJECT_VIEW_STORAGE_KEY, 'list');

    expect(store.getSnapshot()).toBe('list');
  });

  it('holds a choice storage did not keep only until another tab saves one', () => {
    const tab = new EventTarget();
    vi.stubGlobal('window', tab);
    const { storage, values, faults } = fakeStorage();
    const store = createProjectViewStore(() => storage);
    store.subscribe(() => {});

    faults.writes = true;
    store.set('list');
    expect(store.getSnapshot()).toBe('list');

    // A tab whose storage works wrote grid; that is the answer now.
    faults.writes = false;
    values.set(PROJECT_VIEW_STORAGE_KEY, 'grid');
    tab.dispatchEvent(storageEvent(PROJECT_VIEW_STORAGE_KEY));
    expect(store.getSnapshot()).toBe('grid');
  });

  it('still switches, for this page, where storage refuses to read', () => {
    const { storage, faults } = fakeStorage();
    faults.reads = true;
    const store = createProjectViewStore(() => storage);

    expect(store.getSnapshot()).toBe('grid');
    store.set('list');
    expect(store.getSnapshot()).toBe('list');
  });

  it('still switches, for this page, where storage refuses to write', () => {
    const { storage, faults } = fakeStorage();
    faults.writes = true;
    const store = createProjectViewStore(() => storage);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(() => store.set('list')).not.toThrow();
    expect(store.getSnapshot()).toBe('list');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('still switches, for this page, where there is no storage at all', () => {
    const store = createProjectViewStore(() => null);
    expect(store.getSnapshot()).toBe('grid');
    store.set('list');
    expect(store.getSnapshot()).toBe('list');
  });

  it('follows a choice made in another tab', () => {
    const tab = new EventTarget();
    vi.stubGlobal('window', tab);
    const { storage, values } = fakeStorage();
    const store = createProjectViewStore(() => storage);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.getSnapshot()).toBe('grid');

    // Another tab writes the key; this one hears about it.
    values.set(PROJECT_VIEW_STORAGE_KEY, 'list');
    tab.dispatchEvent(storageEvent(PROJECT_VIEW_STORAGE_KEY));
    expect(store.getSnapshot()).toBe('list');
    expect(listener).toHaveBeenCalledTimes(1);

    // Somebody else's key is not this preference.
    tab.dispatchEvent(storageEvent('xecret.theme'));
    expect(listener).toHaveBeenCalledTimes(1);

    // `localStorage.clear()` elsewhere: back to the default.
    values.clear();
    tab.dispatchEvent(storageEvent(null));
    expect(store.getSnapshot()).toBe('grid');
    expect(listener).toHaveBeenCalledTimes(2);

    // And deaf once nobody is listening.
    unsubscribe();
    values.set(PROJECT_VIEW_STORAGE_KEY, 'list');
    tab.dispatchEvent(storageEvent(PROJECT_VIEW_STORAGE_KEY));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
