'use client';

import { useState } from 'react';

import { PageHeader } from '@/components/layout';
import { BookIcon, BoxIcon, Button, EmptyState, TerminalIcon } from '@/components/ui';
import { CreateProjectDialog } from '@/components/projects/create-project-dialog';
import { ProjectCards } from '@/components/projects/project-cards';
import type { ProjectListResponse } from '@/components/projects/types';
import { apiPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { CardGridSkeleton, ErrorState } from './resource-states';
import { isOrgAdmin, useOrganization } from './session';

/** The listing is clamped to 200 by the API, which is far more than a person scrolls. */
const PAGE_SIZE = 200;

export function ProjectsScreen({ orgSlug }: { orgSlug: string }) {
  const organization = useOrganization(orgSlug);
  const [creating, setCreating] = useState(false);

  const projects = useApiResource<ProjectListResponse>(
    withQuery(apiPath.projects(orgSlug), { pageSize: PAGE_SIZE }),
  );

  // `project.create` needs admin or owner. Hiding the button for anyone else is
  // a courtesy that keeps the screen honest; the server refuses the request
  // regardless of what this browser decided to render.
  const canCreate = organization !== null && isOrgAdmin(organization.role);

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
        <CardGridSkeleton />
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
          <ProjectCards orgSlug={orgSlug} projects={projects.data.projects} />
          {projects.data.hasMore ? (
            <p className="text-fg-subtle text-[0.8125rem]">
              Showing the first {PAGE_SIZE} projects.
            </p>
          ) : null}
        </>
      ) : null}

      {projects.data !== null && projects.data.projects.length > 0 ? (
        <p className="text-fg-subtle flex items-center gap-2 text-[0.8125rem]">
          <TerminalIcon className="size-3.5 shrink-0" />
          Run <code className="text-fg-muted font-mono">xecret init</code> in a repository to link
          it to one of these.
        </p>
      ) : null}

      <CreateProjectDialog orgSlug={orgSlug} open={creating} onOpenChange={setCreating} />
    </div>
  );
}
