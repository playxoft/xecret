import { OrganizationSettingsLayout } from '../../../_components/organization-settings-screen';

/**
 * The frame every organisation settings section shares — General at this
 * folder's own page, then `roles`, `single-sign-on`, `policies`, `webhooks`,
 * `billing`, `plans` and `danger` — with the list of them beside whichever is
 * open. See `settings-sections.ts`.
 *
 * Keyed on the id, like every screen under an organisation: switching
 * organisations remounts the frame rather than re-rendering it, so nothing of
 * the previous organisation's — its list, its gates — lingers under the new
 * one's heading.
 */
export default async function OrganizationSettingsAreaLayout({
  children,
  params,
}: LayoutProps<'/app/[orgId]/settings'>) {
  const { orgId } = await params;
  return (
    <OrganizationSettingsLayout key={orgId} orgId={orgId}>
      {children}
    </OrganizationSettingsLayout>
  );
}
