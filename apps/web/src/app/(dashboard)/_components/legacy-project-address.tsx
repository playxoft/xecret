'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { isUuid } from '@xecret/core/ids';
import { carryModePinsForward } from '@/components/envkeys';
import type { ProjectResponse } from '@/components/projects/types';
import { Skeleton } from '@/components/ui';
import { apiPath, canonicalProjectAddress } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';

/**
 * A project page reached by its slug: an address from before projects were
 * named by id, on its way to the one they are named by now.
 *
 * The slug is looked up through the same `GET` every project page makes — the
 * API still takes a slug, and resolves it inside the organisation exactly as it
 * resolves an id — and the URL is then *replaced* with the id's, keeping the
 * environment, the page beneath it, the query and the fragment
 * (`canonicalProjectAddress`). Replaced rather than pushed, so Back leads to
 * wherever the old link was clicked, not to a page that only redirects.
 *
 * In the browser rather than on the server because the lookup is an
 * authenticated read, and this dashboard makes those from the client only (see
 * `use-api-resource.ts`); a server redirect could not see the fragment anyway.
 * It is only ever mounted under the shell, so it runs with a session and an
 * unlocked vault, like the screen it stands in for.
 *
 * A slug that names nothing — or a project this viewer cannot read — is the
 * same "not found" the project's own screen would give, from the same request.
 */
export function LegacyProjectAddress({
  orgSlug,
  projectSlug,
}: {
  orgSlug: string;
  projectSlug: string;
}) {
  const router = useRouter();
  const project = useApiResource<ProjectResponse>(apiPath.project(orgSlug, projectSlug));
  const found = project.data?.project ?? null;

  useEffect(() => {
    if (found === null) return;
    const next = legacyProjectRedirect(window.location, found);
    if (next === null) return;

    // The trust-on-first-use mode pins this browser filed under the slug, moved
    // to the address it will read them under from now on — before the page
    // that reads them mounts.
    carryModePinsForward(orgSlug, found);
    router.replace(next);
  }, [found, orgSlug, router]);

  if (project.error !== null) {
    return <ErrorState subject="this project" error={project.error} onRetry={project.reload} />;
  }

  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      {/* Announced politely: the navigation follows on its own, and a screen
          reader should hear why the page is about to change. */}
      <p role="status" className="sr-only">
        Opening this project at its current address…
      </p>
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-80" />
    </div>
  );
}

/**
 * Where an old address is sent once its project has been read: the same page
 * under the project's id, or `null` to stay put.
 *
 * The id is checked before it goes anywhere near the address bar. It is a value
 * from a response, and `router.replace` must only ever be handed a path built
 * from parts whose shape is known — a canonical UUID, segment-encoded, inside
 * `/app/…` — never whatever a server happened to answer.
 */
export function legacyProjectRedirect(
  location: { pathname: string; search: string; hash: string },
  project: { id: string },
): string | null {
  if (!isUuid(project.id)) return null;
  return canonicalProjectAddress(location, project.id);
}
