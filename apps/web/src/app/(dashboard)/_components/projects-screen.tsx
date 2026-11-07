'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { PageHeader } from '@/components/layout';
import {
  BookIcon,
  BoxIcon,
  Button,
  EmptyState,
  GridIcon,
  Input,
  ListIcon,
  SearchIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TerminalIcon,
  Tooltip,
} from '@/components/ui';
import { CreateProjectDialog } from '@/components/projects/create-project-dialog';
import { ProjectCards, ProjectRows } from '@/components/projects/project-cards';
import {
  arrangeProjects,
  DEFAULT_PROJECT_SORT,
  describeLoadWindow,
  describeProjectCount,
  isFiltering,
  isProjectSort,
  PROJECT_SORT_LABELS,
  PROJECT_SORTS,
  projectViewStore,
} from '@/components/projects/project-listing';
import type { ProjectSort, ProjectView } from '@/components/projects/project-listing';
import type { ProjectListResponse } from '@/components/projects/types';
import { apiPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { CardGridSkeleton, ErrorState, RowListSkeleton } from './resource-states';
import { canAdminister, useOrganization } from './session';

/** The listing is clamped to 200 by the API, which is far more than a person scrolls. */
const PAGE_SIZE = 200;

export function ProjectsScreen({ orgSlug }: { orgSlug: string }) {
  const organization = useOrganization(orgSlug);
  const [creating, setCreating] = useState(false);
  // What somebody is looking for right now, so neither outlives the visit. The
  // layout is a preference, and is remembered — see `project-listing.ts`.
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>(DEFAULT_PROJECT_SORT);
  const view = useSyncExternalStore(
    projectViewStore.subscribe,
    projectViewStore.getSnapshot,
    projectViewStore.getServerSnapshot,
  );
  const searchRef = useRef<HTMLInputElement>(null);

  const projects = useApiResource<ProjectListResponse>(
    withQuery(apiPath.projects(orgSlug), { pageSize: PAGE_SIZE }),
  );

  const visible = useMemo(
    () => arrangeProjects(projects.data?.projects ?? [], query, sort),
    [projects.data, query, sort],
  );
  const filtering = isFiltering(query);

  // Drawn for an owner or admin whose authority includes `project.create`.
  // Hiding the button for anyone else is a courtesy that keeps the screen
  // honest; the server refuses the request regardless of what this browser
  // decided to render.
  const canCreate = canAdminister(organization, 'project.create');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Projects"
        description={
          organization === null
            ? undefined
            : `Every project in ${organization.name}. Each one holds its own environments and secrets.`
        }
        actions={
          canCreate && projects.data !== null && projects.data.projects.length > 0 ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New project
            </Button>
          ) : undefined
        }
      />

      {projects.loading && projects.data === null ? (
        // The skeleton takes the shape the listing is about to, so a list
        // reader does not watch cards collapse into rows when it arrives.
        view === 'list' ? (
          <RowListSkeleton />
        ) : (
          <CardGridSkeleton />
        )
      ) : projects.error !== null ? (
        <ErrorState subject="these projects" error={projects.error} onRetry={projects.reload} />
      ) : projects.data !== null && projects.data.projects.length === 0 ? (
        // An empty state that gets somebody started, rather than one that
        // states the obvious. A new user's next question is "what is a project
        // and what do I put in it?", and the answer is two sentences long.
        <EmptyState
          icon={<BoxIcon />}
          title="Start with your first project"
          description="A project is one application or service. It comes with development, staging and production environments, each holding its own secrets under its own encryption key."
          action={
            canCreate ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create a project
              </Button>
            ) : undefined
          }
          secondaryAction={
            <Button variant="ghost" asChild>
              {/* `rel="noreferrer"` as well as `noopener`: without it the target
                  site is told which dashboard URL the user came from, and these
                  paths carry organisation and project slugs. */}
              <a
                href="https://github.com/playxoft/xecret#how-it-works"
                target="_blank"
                rel="noreferrer noopener"
              >
                <BookIcon className="size-4" />
                How xecret works
              </a>
            </Button>
          }
        />
      ) : projects.data !== null ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 sm:max-w-xs">
              <Input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by name, slug or description"
                aria-label="Filter projects"
                autoComplete="off"
                startIcon={<SearchIcon className="size-4" />}
              />
            </div>

            <Select
              value={sort}
              onValueChange={(next) => {
                if (isProjectSort(next)) setSort(next);
              }}
            >
              <SelectTrigger className="w-48" aria-label="Sort projects">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_SORTS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {PROJECT_SORT_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span className="hidden flex-1 sm:block" />

            <ViewToggle view={view} onChange={projectViewStore.set} />
          </div>

          <ProjectCount
            text={describeProjectCount({
              shown: visible.length,
              total: projects.data.projects.length,
              hasMore: projects.data.hasMore,
              filtering,
            })}
          />

          {visible.length === 0 ? (
            <EmptyState
              icon={<SearchIcon />}
              title={`Nothing matches “${query.trim()}”`}
              description={
                projects.data.hasMore
                  ? 'Only the most recently created projects are loaded, so an older one is not searched.'
                  : undefined
              }
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery('');
                    // This button is about to disappear with the empty state;
                    // focus goes back to the field rather than to the page.
                    searchRef.current?.focus();
                  }}
                >
                  Clear the search
                </Button>
              }
            />
          ) : view === 'list' ? (
            <ProjectRows orgSlug={orgSlug} projects={visible} revealDescriptions={filtering} />
          ) : (
            <ProjectCards orgSlug={orgSlug} projects={visible} />
          )}

          {projects.data.hasMore ? (
            // "The first 200" stopped meaning anything once the listing could
            // be re-sorted: first by name? This names the API's own order,
            // which is what decides which projects arrived — and leaves the
            // counting to the line above, which knows how many did.
            <p className="text-fg-subtle text-sm">{describeLoadWindow(PAGE_SIZE)}</p>
          ) : null}
        </>
      ) : null}

      {projects.data !== null && projects.data.projects.length > 0 ? (
        <p className="text-fg-subtle flex items-center gap-2 text-sm">
          <TerminalIcon className="size-3.5 shrink-0" />
          Run <code className="text-fg-muted font-mono">xecret init</code> in a repository to link
          it to one of these.
        </p>
      ) : null}

      <CreateProjectDialog orgSlug={orgSlug} open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/**
 * How long the count must hold still before a screen reader hears it — the
 * conventional pause, long enough to span the gap between keystrokes.
 */
const ANNOUNCE_AFTER_MS = 500;

/**
 * The count line, drawn at once and announced once typing pauses.
 *
 * Two elements saying one thing, because the two audiences want it at
 * different speeds. The visible line follows every keystroke, as the list
 * under it does. The live region waits for a pause: announced per keystroke,
 * "api" would be read out as three counts, each interrupting the last and the
 * letters being echoed. The visible copy is hidden from assistive technology
 * so that reading the page does not meet the same sentence twice; the region
 * is the one that is read, and it says what the screen says as soon as the
 * typing stops.
 *
 * Mounted only once the projects have arrived, so the region starts out
 * holding the count rather than filling with it — a polite region announces
 * changes, and arriving on the page is not one.
 */
function ProjectCount({ text }: { text: string }) {
  const settled = useDebouncedValue(text, ANNOUNCE_AFTER_MS);
  return (
    <>
      <p aria-hidden="true" className="text-fg-subtle text-sm">
        {text}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {settled}
      </p>
    </>
  );
}

/** `value`, but only after it has held still for `delayMs` — as in `passphrase-fields.tsx`. */
function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

const VIEWS: readonly { value: ProjectView; label: string; Icon: typeof GridIcon }[] = [
  { value: 'grid', label: 'Grid view', Icon: GridIcon },
  { value: 'list', label: 'List view', Icon: ListIcon },
];

/**
 * Grid or list, as two icon buttons in one capsule.
 *
 * `aria-pressed` says which is lit, as on the level capsule (`level-toggle.tsx`).
 * The name is the button's own `aria-label`, and the tooltip only repeats it
 * for the pointer: a tooltip never appears on a touch screen, so a control
 * named nowhere else would be a blank square there. The capsule is the secret
 * table's toolbar group, at the height of the field beside it.
 */
function ViewToggle({
  view,
  onChange,
}: {
  view: ProjectView;
  onChange: (view: ProjectView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Layout"
      className="border-line bg-canvas-inset flex h-9 items-center gap-0.5 rounded-lg border p-0.5"
    >
      {VIEWS.map(({ value, label, Icon }) => (
        <Tooltip key={value} content={label}>
          <Button
            size="icon"
            variant={view === value ? 'secondary' : 'ghost'}
            className="size-7.5"
            aria-label={label}
            aria-pressed={view === value}
            onClick={() => onChange(value)}
          >
            <Icon className="size-4" />
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}
