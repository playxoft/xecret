import type { Metadata } from 'next';
import { InviteScreen } from './invite-screen';

export const metadata: Metadata = {
  title: 'Join an organisation',
  description: 'Accept an invitation to join an organisation on xecret.',
  // An invitation URL is a credential; no search engine should hold a copy.
  robots: { index: false, follow: false },
};

export default async function InvitePage({ params }: PageProps<'/invite/[token]'>) {
  const { token } = await params;
  return <InviteScreen token={decodeURIComponent(token)} />;
}
