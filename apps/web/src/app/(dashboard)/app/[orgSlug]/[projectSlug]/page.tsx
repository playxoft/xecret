import type { Metadata } from 'next';

import { ProjectScreen } from '../../../_components/project-screen';

/**
 * Titled with the slug rather than the display name: the name lives behind an
 * authenticated request this Server Component cannot make, and a tab that says
 * "Loading…" for the first second is worse than one that says `payments-api`.
 */
export async function generateMetadata({
  params,
}: PageProps<'/app/[orgSlug]/[projectSlug]'>): Promise<Metadata> {
  const { projectSlug } = await params;
  return { title: projectSlug };
}

export default async function ProjectPage({ params }: PageProps<'/app/[orgSlug]/[projectSlug]'>) {
  const { orgSlug, projectSlug } = await params;
  return <ProjectScreen orgSlug={orgSlug} projectSlug={projectSlug} />;
}
