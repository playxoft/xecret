import type { Metadata } from 'next';

import { EnvironmentScreen } from '../../../../_components/environment-screen';

export async function generateMetadata({
  params,
}: PageProps<'/app/[orgSlug]/[projectSlug]/[envSlug]'>): Promise<Metadata> {
  const { projectSlug, envSlug } = await params;
  return { title: `${envSlug} · ${projectSlug}` };
}

export default async function EnvironmentPage({
  params,
}: PageProps<'/app/[orgSlug]/[projectSlug]/[envSlug]'>) {
  const { orgSlug, projectSlug, envSlug } = await params;
  return (
    <EnvironmentScreen
      // Remounts when the environment changes, so no state that describes one
      // environment — a filter, a selection, an open dialog — can survive into
      // the next. In this product that is a correctness property, not tidiness.
      key={`${orgSlug}/${projectSlug}/${envSlug}`}
      orgSlug={orgSlug}
      projectSlug={projectSlug}
      envSlug={envSlug}
    />
  );
}
