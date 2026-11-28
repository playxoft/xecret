import type { Metadata } from 'next';

import { MembersScreen } from '../../../_components/members-screen';

export const metadata: Metadata = { title: 'Members' };

export default async function MembersPage({ params }: PageProps<'/app/[orgId]/members'>) {
  const { orgId } = await params;
  // Keyed on the id so switching organisations remounts rather than
  // re-rendering: the member list of the previous organisation must not linger
  // on screen under the new one's heading while its request is in flight.
  return <MembersScreen key={orgId} orgId={orgId} />;
}
