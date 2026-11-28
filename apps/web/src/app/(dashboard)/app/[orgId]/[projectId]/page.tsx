import type { Metadata } from 'next';

import { isUuid } from '@xecret/core/ids';

import { LegacyProjectAddress } from '../../../_components/legacy-project-address';
import { ProjectScreen } from '../../../_components/project-screen';

/**
 * Titled generically. The segment is the project's id, which is no title, and
 * the name lives behind an authenticated request this Server Component cannot
 * make — the screen's own heading says which project this is.
 */
export const metadata: Metadata = { title: 'Project' };

/**
 * A project, named by its id. A slug in the same place is an address from
 * before projects were named that way, and is sent on to the id — see
 * `canonicalProjectAddress`. Told apart by shape alone, which no slug can take.
 */
export default async function ProjectPage({ params }: PageProps<'/app/[orgId]/[projectId]'>) {
  const { orgId, projectId } = await params;
  if (!isUuid(projectId)) return <LegacyProjectAddress orgId={orgId} projectSlug={projectId} />;
  return <ProjectScreen orgId={orgId} projectId={projectId} />;
}
