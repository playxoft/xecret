'use client';

import Link from 'next/link';

import { appPath } from '@/app/(dashboard)/_lib/paths';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
import { ArrowRightIcon, LayersIcon } from '@/components/ui';
import type { ProjectListItem } from './types';

export interface ProjectCardsProps {
  orgSlug: string;
  projects: readonly ProjectListItem[];
}

/**
 * The organisation's projects, in the two layouts the listing offers.
 *
 * Neither is a table, though the list looks like one at a distance. A project
 * has four attributes, and the target of the click is the whole card or row
 * rather than a link inside a cell — a materially bigger hit area on a phone,
 * and one tab stop per project. Sorting lives in the toolbar above
 * (`project-listing.ts`) rather than in column headers, so the two layouts
 * share one control and the list needs no header row to carry it.
 *
 *  - `ProjectCards`, the grid: the default, with room for two lines of
 *    description.
 *  - `ProjectRows`, the list: one row per project, for scanning a long listing
 *    by name. Same links, same order, same facts.
 */
export function ProjectCards({ orgSlug, projects }: ProjectCardsProps) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <li key={project.slug}>
          <Link
            href={appPath.project(orgSlug, project.slug)}
            className="border-line bg-surface shadow-raised hover:border-line-strong hover:bg-surface-hover flex h-full flex-col rounded-xl border p-5 transition-colors"
          >
            <span className="text-fg truncate text-[0.9375rem] font-semibold tracking-tight">
              {project.name}
            </span>
            <span className="text-fg-subtle mt-0.5 truncate font-mono text-sm">{project.slug}</span>

            <span className="text-fg-muted mt-3 line-clamp-2 min-h-[2.5rem] text-sm leading-5">
              {project.description ?? 'No description.'}
            </span>

            <span className="border-line-subtle text-fg-subtle mt-4 flex items-center gap-2 border-t pt-3 text-sm">
              <LayersIcon className="size-3.5 shrink-0" />
              {pluralize(project.environmentCount, 'environment')}
              <span aria-hidden="true">·</span>
              <UpdatedTime value={project.updatedAt} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The list.
 *
 * Below `lg` a row is the card without its description: name, slug, and the
 * footer line beneath. From `lg` the facts move into columns of fixed width, so
 * they line up down the list the way a table's would — `lg` and not `md`
 * because the sidebar arrives at `md` and leaves too little room beside it.
 * The description joins at `xl`, on one line, where it has room to say
 * something before it is cut off.
 *
 * Except while a search is narrowing the list (`revealDescriptions`): the
 * search matches descriptions, and a row that matched on its description alone
 * would otherwise stand there with no visible reason for being in the results.
 * So below `xl` the description, where there is one, comes back under the slug
 * — one line, cut off like the column it stands in for.
 */
export function ProjectRows({
  orgSlug,
  projects,
  revealDescriptions = false,
}: ProjectCardsProps & { revealDescriptions?: boolean }) {
  return (
    <ul className="flex flex-col gap-2">
      {projects.map((project) => (
        <li key={project.slug}>
          <Link
            href={appPath.project(orgSlug, project.slug)}
            className="border-line bg-surface hover:border-line-strong hover:bg-surface-hover flex flex-col gap-1.5 rounded-xl border px-4 py-3 transition-colors lg:flex-row lg:items-center lg:gap-4"
          >
            <span className="min-w-0 lg:flex-1 xl:w-64 xl:flex-none">
              <span className="text-fg block truncate text-sm font-medium">{project.name}</span>
              <span className="text-fg-subtle block truncate font-mono text-sm">
                {project.slug}
              </span>
              {revealDescriptions && project.description !== null ? (
                <span className="text-fg-muted block truncate text-sm xl:hidden">
                  {project.description}
                </span>
              ) : null}
            </span>

            <span className="text-fg-muted hidden min-w-0 flex-1 truncate text-sm xl:block">
              {project.description ?? 'No description.'}
            </span>

            <span className="text-fg-subtle flex flex-wrap items-center gap-x-2 text-sm lg:flex-nowrap lg:gap-4">
              <span className="flex items-center gap-2 whitespace-nowrap lg:w-36">
                <LayersIcon className="size-3.5 shrink-0" />
                {pluralize(project.environmentCount, 'environment')}
              </span>
              <span aria-hidden="true" className="lg:hidden">
                ·
              </span>
              <UpdatedTime
                value={project.updatedAt}
                className="whitespace-nowrap lg:w-52 lg:text-right"
              />
            </span>

            <ArrowRightIcon className="text-fg-subtle hidden size-4 shrink-0 lg:block" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Updated 3 days ago", with the exact time behind it.
 *
 * The absolute timestamp is the accessible one: "3 days ago" is useless when
 * you are deciding whether a change predates an incident, and a `title` alone
 * is unreachable by keyboard.
 */
function UpdatedTime({ value, className }: { value: string; className?: string }) {
  return (
    <time dateTime={toIsoString(value)} title={formatAbsoluteTime(value)} className={className}>
      Updated {formatRelativeTime(value)}
    </time>
  );
}
