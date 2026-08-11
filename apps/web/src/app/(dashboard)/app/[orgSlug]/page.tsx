import type { Metadata } from 'next';

import { ProjectsScreen } from '../../_components/projects-screen';

export const metadata: Metadata = { title: 'Projects' };

/**
 * `params` is a promise in Next 16, so every page that reads one is async. The
 * page itself stays a Server Component and hands the resolved slugs to a Client
 * Component: the data behind these screens is fetched from the browser with the
 * session cookie, so the interactivity boundary is drawn here, once, rather than
 * at the top of each screen.
 */
export default async function ProjectsPage({ params }: PageProps<'/app/[orgSlug]'>) {
  const { orgSlug } = await params;
  return <ProjectsScreen orgSlug={orgSlug} />;
}
