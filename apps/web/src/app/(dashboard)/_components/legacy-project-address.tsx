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
import { useOrganization } from './session';

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
  orgId,
  projectSlug,
}: {
  orgId: string;
  projectSlug: string;
}) {
  const router = useRouter();
  const project = useApiResource<ProjectResponse>(apiPath.project(orgId, projectSlug));
  const found = project.data?.project ?? null;
  // The organisation's legacy slug, which pins filed before either address
  // moved to an id are filed under too. From the session, which already holds it.
  const orgSlug = useOrganization(orgId)?.slug ?? null;

  useEffect(() => {
    if (found === null) return;
    const next = leaveLegacyAddress({
      location: window.location,
      orgId,
      orgSlugs: orgSlug === null ? [] : [orgSlug],
      projectSlug,
      found,
    });
    if (next !== null) router.replace(next);
  }, [found, orgId, orgSlug, projectSlug, router]);

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

/**
 * What leaving an old address does, once its project has been read: carries
 * the mode pins this browser filed under the slug to the id the page will read
 * them under, and answers where to go — or `null`, having carried nothing.
 *
 * ── Which slug the pins are carried from ──
 * The one in *this* URL, first. That is the spelling the pins were filed
 * under; the server's answer is not, and a server that answered a different
 * slug would otherwise turn the copy into a no-op and the id page into first
 * contact — a downgrade let through by the very redirect meant to preserve the
 * pin. The server's own slug follows: a second source can only add strictness,
 * and it covers a slug typed here in another case. The id is the one the
 * address is replaced with, which is the one the page will read under.
 *
 * The organisation is the id in this URL, which is the one the page reads
 * under too. Its legacy slugs are passed so a pin filed before either address
 * moved to an id (`mode:acme/payments-api/…`) is carried in the same pass.
 */
export function leaveLegacyAddress(params: {
  location: { pathname: string; search: string; hash: string };
  /** The organisation's id, as this browser's URL holds it. */
  orgId: string;
  /** The organisation's legacy slugs, for pins filed under them. */
  orgSlugs?: readonly string[];
  /** The slug as this browser's URL holds it. */
  projectSlug: string;
  /** What the server answered for it. */
  found: { id: string; slug: string };
  storage?: Storage | null;
}): string | null {
  const next = legacyProjectRedirect(params.location, params.found);
  if (next === null) return null;

  carryModePinsForward(
    { orgId: params.orgId, projectId: params.found.id },
    { orgSlugs: params.orgSlugs ?? [], projectSlugs: [params.projectSlug, params.found.slug] },
    params.storage,
  );
  return next;
}
