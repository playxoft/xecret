import type { Metadata } from 'next';
import { MemberAccessScreen } from '../../../../_components/member-access-screen';

export const metadata: Metadata = { title: 'Member access' };

export default async function MemberAccessPage({
  params,
}: PageProps<'/app/[orgSlug]/members/[memberId]'>) {
  const { orgSlug, memberId } = await params;
  return (
    <MemberAccessScreen key={`${orgSlug}/${memberId}`} orgSlug={orgSlug} memberId={memberId} />
  );
}
