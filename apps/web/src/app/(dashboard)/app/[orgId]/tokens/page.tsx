import type { Metadata } from 'next';
import { TokensScreen } from '../../../_components/tokens-screen';

export const metadata: Metadata = { title: 'Tokens' };

export default async function TokensPage({ params }: PageProps<'/app/[orgId]/tokens'>) {
  const { orgId } = await params;
  return <TokensScreen key={orgId} orgId={orgId} />;
}
