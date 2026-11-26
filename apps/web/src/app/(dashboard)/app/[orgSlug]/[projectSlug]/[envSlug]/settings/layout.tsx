import { EnvironmentSettingsLayout } from '../../../../../_components/environment-settings-screen';

/**
 * The frame every environment settings section shares — General at this
 * folder's own page, then `encryption`, `inheritance`, `policy` and `danger` —
 * with the list of them beside whichever is open, and the environment read
 * once for all of them. See `settings-sections.ts`.
 *
 * Keyed on the path, so moving to another environment's settings remounts the
 * frame rather than showing the previous environment's name and sections while
 * the next one's request is in flight.
 */
export default async function EnvironmentSettingsAreaLayout({
  children,
  params,
}: LayoutProps<'/app/[orgSlug]/[projectSlug]/[envSlug]/settings'>) {
  const { orgSlug, projectSlug, envSlug } = await params;
  return (
    <EnvironmentSettingsLayout
      key={`${orgSlug}/${projectSlug}/${envSlug}`}
      orgSlug={orgSlug}
      projectSlug={projectSlug}
      envSlug={envSlug}
    >
      {children}
    </EnvironmentSettingsLayout>
  );
}
