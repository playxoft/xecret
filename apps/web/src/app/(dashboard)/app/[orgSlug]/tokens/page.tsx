import type { Metadata } from 'next';
import { TokensScreen } from '../../../_components/tokens-screen';

export const metadata: Metadata = { title: 'Tokens' };

export default async function TokensPage({ params }: PageProps<'/app/[orgSlug]/tokens'>) {
  const { orgSlug } = await params;
  return <TokensScreen key={orgSlug} orgSlug={orgSlug} />;
}
