import type { Metadata } from 'next';

import { MembersScreen } from '../../../_components/members-screen';

export const metadata: Metadata = { title: 'Members' };

export default async function MembersPage({ params }: PageProps<'/app/[orgSlug]/members'>) {
  const { orgSlug } = await params;
  // Keyed on the slug so switching organisations remounts rather than
  // re-rendering: the member list of the previous organisation must not linger
  // on screen under the new one's heading while its request is in flight.
  return <MembersScreen key={orgSlug} orgSlug={orgSlug} />;
}
