import { pluralize } from '@/lib/format';
import type { ProjectListItem } from './types';

/**
 * How the projects listing is searched, ordered and laid out.
 *
 * ── Why all of it happens in the browser ──
 * `GET …/projects` takes a page and a page size and nothing else: no search
 * term, no sort key, one fixed order (newest first by creation). The screen asks
 * for the largest page the API allows, 200, so filtering and ordering what
 * arrived is instant and costs no request per keystroke. The caveat is stated
 * where it applies: when the response says `hasMore`, a search covers what
 * arrived — the projects the viewer can open among the organisation's 200 most
 * recently created — and no others, and the screen says so rather than letting
 * "nothing matches" pass for a fact about the whole organisation.
 *
 * Kept free of React so the rules are tested as functions, not through markup.
 */

export type ProjectSort = 'updated' | 'name' | 'created' | 'environments';

/** The order the sort menu offers them in. */
export const PROJECT_SORTS: readonly ProjectSort[] = ['updated', 'name', 'created', 'environments'];

export const PROJECT_SORT_LABELS: Readonly<Record<ProjectSort, string>> = {
  updated: 'Last updated',
  name: 'Name (A–Z)',
  created: 'Newest',
  environments: 'Most environments',
};

/**
 * Last updated, rather than the API's creation order.
 *
 * Every card and row ends in "Updated …", so this is the one order whose
 * reason is on the screen: the timestamps read top to bottom as a sequence.
 * Under creation order a project renamed this morning sits wherever it was
 * created, beside an "Updated just now" that looks like a sorting bug. A new
 * project's two timestamps are the same `now()`, so until one is edited the
 * two orders agree and nobody's list reshuffles the day this ships.
 *
 * Note what "updated" means: the project's own name or description changed,
 * or it was restored (`packages/db` `repositories/projects.ts`). A secret
 * written inside it does not move it.
 */
export const DEFAULT_PROJECT_SORT: ProjectSort = 'updated';

export function isProjectSort(value: unknown): value is ProjectSort {
  return PROJECT_SORTS.includes(value as ProjectSort);
}

/**
 * Whether a project matches what was typed: case-insensitive, anywhere in the
 * name, the slug or the description. Surrounding whitespace is ignored, and an
 * empty query matches everything.
 */
export function matchesProjectQuery(project: ProjectListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    project.name.toLowerCase().includes(needle) ||
    project.slug.toLowerCase().includes(needle) ||
    (project.description ?? '').toLowerCase().includes(needle)
  );
}

/**
 * Names compare the way people read them: case and accents aside, and digits
 * as numbers, so `service-9` comes before `service-10`. `'en'` rather than the
 * browser's locale for the same reason `lib/format.ts` pins it: one input, one
 * order, everywhere.
 */
const names = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * A timestamp as milliseconds, with anything unparseable sorting as the oldest
 * thing there is. A malformed date is a server bug, and it should sink to the
 * bottom of a newest-first list rather than throw or land at random.
 */
function timeOf(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function newestFirst(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

/**
 * The slug is unique within an organisation, so ending every comparison on it
 * makes the order total: two projects that tie on the chosen key still come
 * out the same way on every render, instead of trading places as the list
 * re-filters underneath somebody.
 */
function bySlug(a: ProjectListItem, b: ProjectListItem): number {
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

const COMPARATORS: Readonly<
  Record<ProjectSort, (a: ProjectListItem, b: ProjectListItem) => number>
> = {
  updated: (a, b) => newestFirst(timeOf(a.updatedAt), timeOf(b.updatedAt)) || bySlug(a, b),
  name: (a, b) => names.compare(a.name, b.name) || bySlug(a, b),
  created: (a, b) => newestFirst(timeOf(a.createdAt), timeOf(b.createdAt)) || bySlug(a, b),
  // Most first, and alphabetical among equals: "which of my three-environment
  // projects" is answered by reading names, not creation dates.
  environments: (a, b) =>
    b.environmentCount - a.environmentCount || names.compare(a.name, b.name) || bySlug(a, b),
};

/** A sorted copy. The input — the API response — is never reordered in place. */
export function sortProjects(
  projects: readonly ProjectListItem[],
  sort: ProjectSort,
): ProjectListItem[] {
  return [...projects].sort(COMPARATORS[sort]);
}

/** What the listing shows: the matches, in the chosen order. */
export function arrangeProjects(
  projects: readonly ProjectListItem[],
  query: string,
  sort: ProjectSort,
): ProjectListItem[] {
  return sortProjects(
    projects.filter((project) => matchesProjectQuery(project, query)),
    sort,
  );
}

/**
 * Whether the search box is narrowing the list: anything but whitespace.
 *
 * The same rule `matchesProjectQuery` applies, so "filtering" and "something
 * could be hidden" are one fact. The screen asks this rather than restating the
 * expression, which is what lets a test without a DOM pin what it decides.
 */
export function isFiltering(query: string): boolean {
  return query.trim().length > 0;
}

/**
 * The count line above the listing.
 *
 * When the API held some projects back, the line says so in the same breath,
 * so "3 of 12 projects shown" is never read as three matches in the whole
 * organisation. It names no window size: what arrives is the projects the
 * viewer can open *among* the organisation's most recently created
 * ({@link describeLoadWindow}), and how many that is depends on their access,
 * not on the page size — so the count is the only number here, and it is the
 * one that arrived.
 */
export function describeProjectCount({
  shown,
  total,
  hasMore,
  filtering,
}: {
  /** How many match the search. */
  shown: number;
  /** How many arrived from the API. */
  total: number;
  /** Whether the API held more back. */
  hasMore: boolean;
  /** Whether a search is narrowing the list — {@link isFiltering}. */
  filtering: boolean;
}): string {
  const count = filtering
    ? `${shown.toLocaleString('en')} of ${pluralize(total, 'project')} shown`
    : pluralize(total, 'project');
  return hasMore ? `${count} — only the most recently created are loaded` : count;
}

/**
 * The note under a listing the API cut short: which projects the page holds,
 * and what that means for searching it.
 *
 * The server reads the organisation's newest `pageSize` projects and then drops
 * the ones the viewer cannot open (the projects route filters after paging), so
 * the page holds *at most* this many — which is why this says how they were
 * chosen and leaves the counting to {@link describeProjectCount}.
 */
export function describeLoadWindow(pageSize: number): string {
  const newest = pluralize(pageSize, 'most recently created project');
  const are = pageSize === 1 ? 'is' : 'are';
  return `Only the organisation’s ${newest} ${are} loaded, and of those, the ones you can open are listed. Search and sort cover only these.`;
}

/* ───────────────────────────────────────────────────────────────────────────
   The layout, remembered.

   Grid or list is a preference about how somebody likes to read, so it
   survives a reload — in `localStorage`, under the key the privacy policy
   names, and nowhere else: never sent to the server, never part of the URL.
   The search and the sort are not remembered. They are about what somebody is
   looking for right now, and a filter that is still applied next week is a
   project that has "disappeared".

   Read the way `lib/theme.ts` reads the theme — from storage on every
   snapshot, through `useSyncExternalStore`, which gives a server snapshot
   without a hydration mismatch, and across tabs through the `storage` event.
   Storage throws in Safari's private mode and in sandboxed iframes; there the
   choice is held in memory instead, the way `use-last-visited-org.ts` holds
   its slug, and the toggle still works for as long as the page stays open.
   ─────────────────────────────────────────────────────────────────────────── */

export type ProjectView = 'grid' | 'list';

export const PROJECT_VIEW_STORAGE_KEY = 'xecret.projects.view';

/** The cards. What the listing has always been, and what a first visit shows. */
export const DEFAULT_PROJECT_VIEW: ProjectView = 'grid';

export function isProjectView(value: unknown): value is ProjectView {
  return value === 'grid' || value === 'list';
}

/** The subset of `Storage` the preference uses — a seam, because tests have no DOM. */
export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** This browser's `localStorage`, or `null` where there is none or it refuses access. */
export function browserViewStorage(): ViewStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Properties rather than methods, because every one of them is handed around
 * detached — to `useSyncExternalStore`, to an `onChange` — and none uses `this`.
 */
export interface ProjectViewStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ProjectView;
  getServerSnapshot: () => ProjectView;
  set: (view: ProjectView) => void;
}

export function createProjectViewStore(
  storage: () => ViewStorage | null = browserViewStorage,
): ProjectViewStore {
  const listeners = new Set<() => void>();

  /**
   * A choice this page made that storage did not keep, or `null` while storage
   * is doing its job. Storage itself is re-read on every snapshot, as the theme
   * is, rather than once: a mirror read once would go stale while this tab was
   * on another screen and a second tab changed the layout.
   */
  let unsaved: ProjectView | null = null;

  function readStored(): ProjectView {
    try {
      const stored = storage()?.getItem(PROJECT_VIEW_STORAGE_KEY) ?? null;
      return isProjectView(stored) ? stored : DEFAULT_PROJECT_VIEW;
    } catch {
      return DEFAULT_PROJECT_VIEW;
    }
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  /**
   * Another tab chose a layout: follow it, as the theme does. `key === null` is
   * `localStorage.clear()`, after which the stored answer is the default.
   */
  function onStorage(event: Event): void {
    const key = (event as StorageEvent).key;
    if (key !== null && key !== PROJECT_VIEW_STORAGE_KEY) return;
    unsaved = null;
    notify();
  }

  return {
    subscribe: (listener) => {
      if (listeners.size === 0 && typeof window !== 'undefined') {
        window.addEventListener('storage', onStorage);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== 'undefined') {
          window.removeEventListener('storage', onStorage);
        }
      };
    },
    getSnapshot: () => unsaved ?? readStored(),
    getServerSnapshot: () => DEFAULT_PROJECT_VIEW,
    set: (view) => {
      try {
        storage()?.setItem(PROJECT_VIEW_STORAGE_KEY, view);
      } catch {
        // A quota error or a blocked origin. Caught here so the toggle never
        // throws; whether the choice was kept is checked below.
      }
      // Read back rather than trusted: some browsers refuse the write, some
      // the read, some both. Whatever storage cannot answer for is held here,
      // for as long as the page stays open.
      unsaved = readStored() === view ? null : view;
      notify();
    },
  };
}

export const projectViewStore = createProjectViewStore();
