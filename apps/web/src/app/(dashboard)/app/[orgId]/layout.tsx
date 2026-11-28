import { isUuid } from '@xecret/core/ids';

import { LegacyOrgAddress } from '../../_components/legacy-org-address';

/**
 * Every page under an organisation, named by its id.
 *
 * A segment not shaped like an id is an address from before organisations were
 * named that way, `/app/acme/…`, from a bookmark, an email or an older CLI. It
 * is sent on to the id here, once for every page beneath, keeping the rest of
 * the address (`canonicalOrgAddress`), and nothing under it is drawn on the
 * slug: no screen addresses the API by one, and nothing this browser files is
 * filed under one. Told apart by shape alone, which no organisation slug can
 * take.
 *
 * An address old enough to carry a project's slug as well arrives at the id
 * with the project's slug still in it, and the project's own pages send that on
 * in turn (`LegacyProjectAddress`).
 */
export default async function OrganizationLayout({
  children,
  params,
}: LayoutProps<'/app/[orgId]'>) {
  const { orgId } = await params;
  if (!isUuid(orgId)) return <LegacyOrgAddress orgSlug={orgId} />;
  return children;
}
