import { isUuid } from '@xecret/core/ids';

import { EnvironmentSettingsLayout } from '../../../../../_components/environment-settings-screen';
import { LegacyProjectAddress } from '../../../../../_components/legacy-project-address';

/**
 * The frame every environment settings section shares — General at this
 * folder's own page, then `encryption`, `inheritance`, `policy` and `danger` —
 * with the list of them beside whichever is open, and the environment read
 * once for all of them. See `settings-sections.ts`.
 *
 * An address from before projects were named by id is moved to the id here,
 * once for every section: the frame is never drawn on a slug, and the move
 * keeps whichever section the address named.
 *
 * Keyed on the path, so moving to another environment's settings remounts the
 * frame rather than showing the previous environment's name and sections while
 * the next one's request is in flight.
 */
export default async function EnvironmentSettingsAreaLayout({
  children,
  params,
}: LayoutProps<'/app/[orgSlug]/[projectId]/[envSlug]/settings'>) {
  const { orgSlug, projectId, envSlug } = await params;
  if (!isUuid(projectId)) return <LegacyProjectAddress orgSlug={orgSlug} projectSlug={projectId} />;
  return (
    <EnvironmentSettingsLayout
      key={`${orgSlug}/${projectId}/${envSlug}`}
      orgSlug={orgSlug}
      projectId={projectId}
      envSlug={envSlug}
    >
      {children}
    </EnvironmentSettingsLayout>
  );
}
