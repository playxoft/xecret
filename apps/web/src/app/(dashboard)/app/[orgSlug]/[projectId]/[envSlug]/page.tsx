import type { Metadata } from 'next';

import { isUuid } from '@xecret/core/ids';

import { EnvironmentScreen } from '../../../../_components/environment-screen';
import { LegacyProjectAddress } from '../../../../_components/legacy-project-address';

/**
 * The environment's slug alone: the project segment is an id, which no tab
 * should be titled with, and the project's name needs a request this Server
 * Component cannot make.
 */
export async function generateMetadata({
  params,
}: PageProps<'/app/[orgSlug]/[projectId]/[envSlug]'>): Promise<Metadata> {
  const { envSlug } = await params;
  return { title: envSlug };
}

export default async function EnvironmentPage({
  params,
}: PageProps<'/app/[orgSlug]/[projectId]/[envSlug]'>) {
  const { orgSlug, projectId, envSlug } = await params;
  if (!isUuid(projectId)) return <LegacyProjectAddress orgSlug={orgSlug} projectSlug={projectId} />;
  return (
    <EnvironmentScreen
      // Remounts when the environment changes, so no state that describes one
      // environment — a filter, a selection, an open dialog — can survive into
      // the next. In this product that is a correctness property, not tidiness.
      key={`${orgSlug}/${projectId}/${envSlug}`}
      orgSlug={orgSlug}
      projectId={projectId}
      envSlug={envSlug}
    />
  );
}
