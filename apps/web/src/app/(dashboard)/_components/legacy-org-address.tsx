'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { isUuid } from '@xecret/core/ids';
import { carryOrganizationModePinsForward } from '@/components/envkeys';
import type { OrganizationResponse } from '@/components/projects/types';
import { Skeleton } from '@/components/ui';
import { apiPath, canonicalOrgAddress } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { useSession } from './session';

/**
 * An organisation page reached by its slug: an address from before
 * organisations were named by id, on its way to the one they are named by now.
 *
 * The slug is looked up among the viewer's own memberships first, which the
 * shell already holds, so the common case costs no request; and otherwise
 * through `GET /api/orgs/{slug}`, which still takes a slug and resolves it
 * exactly as it resolves an id (`resolveOrg`). The URL is then *replaced* with
 * the id's, keeping everything after the organisation: the project, the
 * environment, the section, the query and the fragment
 * (`canonicalOrgAddress`). Replaced rather than pushed, so Back leads to
 * wherever the old link was clicked, not to a page that only redirects.
 *
 * Drawn by the organisation's layout instead of the page whenever its segment
 * is not shaped like an id, so no screen under it ever addresses the API, or
 * files anything in this browser, by a slug.
 *
 * A slug that names nothing, or an organisation this viewer is not in, is the
 * "not found" the organisation's own screens would give, from the same request.
 */
export function LegacyOrgAddress({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const { organizations } = useSession();

  // citext, so a slug typed in another case reached the same organisation.
  const folded = orgSlug.toLowerCase();
  const member =
    organizations.find((organization) => organization.slug.toLowerCase() === folded) ?? null;
  const lookup = useApiResource<OrganizationResponse>(
    member === null ? apiPath.org(orgSlug) : null,
  );
  const found = member ?? lookup.data?.organization ?? null;

  const foundId = found?.id ?? null;
  const foundSlug = found?.slug ?? null;
  useEffect(() => {
    if (foundId === null || foundSlug === null) return;
    const next = leaveLegacyOrgAddress({
      location: window.location,
      orgSlug,
      found: { id: foundId, slug: foundSlug },
    });
    if (next !== null) router.replace(next);
  }, [foundId, foundSlug, orgSlug, router]);

  if (lookup.error !== null) {
    return <ErrorState subject="this organisation" error={lookup.error} onRetry={lookup.reload} />;
  }

  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      {/* Announced politely: the navigation follows on its own, and a screen
          reader should hear why the page is about to change. */}
      <p role="status" className="sr-only">
        Opening this organisation at its current address…
      </p>
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-80" />
    </div>
  );
}

/**
 * Where an old organisation address is sent once its organisation is known:
 * the same page under the organisation's id, or `null` to stay put.
 *
 * The id is checked before it goes anywhere near the address bar. It is a value
 * from a response, and `router.replace` must only ever be handed a path built
 * from parts whose shape is known — a canonical UUID, segment-encoded, inside
 * `/app/…` — never whatever a server happened to answer.
 */
export function legacyOrgRedirect(
  location: { pathname: string; search: string; hash: string },
  organization: { id: string },
): string | null {
  if (!isUuid(organization.id)) return null;
  return canonicalOrgAddress(location, organization.id);
}

/**
 * What leaving an old organisation address does: carries the mode pins this
 * browser filed under the slug to the id the pages will read under, and answers
 * where to go — or `null`, having carried nothing.
 *
 * The mode pins (`pins.ts`) are the record that an environment was seen
 * end-to-end encrypted, which is what refuses a later `server` answer. Every
 * one filed under the slug, for every project and environment, is copied to the
 * id (`carryOrganizationModePinsForward`), stricter only. Losing one would let
 * the very redirect meant to preserve it turn the next visit into first
 * contact, which is the downgrade the book exists to refuse. The one other
 * thing a browser files under an organisation, the tab's last organisation, is
 * the shell's to carry (`resolveRememberedOrg`), and it remembers the id as
 * soon as the address holds one.
 *
 * ── Which slug ──
 * The one in *this* URL, first: that is the spelling the pins were filed under.
 * The server's own slug follows, which can only add strictness and covers a
 * slug typed here in another case. The id is the one the address is replaced
 * with, which is the one the pages will read under.
 */
export function leaveLegacyOrgAddress(params: {
  location: { pathname: string; search: string; hash: string };
  /** The slug as this browser's URL holds it. */
  orgSlug: string;
  /** What the session or the server answered for it. */
  found: { id: string; slug: string };
  storage?: Storage | null;
}): string | null {
  const next = legacyOrgRedirect(params.location, params.found);
  if (next === null) return null;

  carryOrganizationModePinsForward(
    params.found.id,
    [params.orgSlug, params.found.slug],
    params.storage,
  );
  return next;
}
