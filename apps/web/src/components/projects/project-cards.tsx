'use client';

import Link from 'next/link';

import { appPath } from '@/app/(dashboard)/_lib/paths';
import { formatAbsoluteTime, formatRelativeTime, pluralize } from '@/lib/format';
import { toIsoString } from '@/lib/format';
import { LayersIcon } from '@/components/ui';
import type { ProjectListItem } from './types';

export interface ProjectCardsProps {
  orgSlug: string;
  projects: readonly ProjectListItem[];
}

/**
 * The organisation's projects.
 *
 * Cards rather than a table: a project has four attributes and no columns worth
 * sorting, and the target of the click is the whole card rather than a link
 * inside a cell — which is a materially bigger hit area on a phone.
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
            <span className="text-fg-subtle mt-0.5 truncate font-mono text-xs">{project.slug}</span>

            <span className="text-fg-muted mt-3 line-clamp-2 min-h-[2.5rem] text-sm leading-5">
              {project.description ?? 'No description.'}
            </span>

            <span className="border-line-subtle text-fg-subtle mt-4 flex items-center gap-2 border-t pt-3 text-xs">
              <LayersIcon className="size-3.5 shrink-0" />
              {pluralize(project.environmentCount, 'environment')}
              <span aria-hidden="true">·</span>
              {/* The absolute timestamp is the accessible one: "3 days ago" is
                  useless when you are deciding whether a change predates an
                  incident, and a `title` alone is unreachable by keyboard. */}
              <time
                dateTime={toIsoString(project.updatedAt)}
                title={formatAbsoluteTime(project.updatedAt)}
              >
                Updated {formatRelativeTime(project.updatedAt)}
              </time>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
