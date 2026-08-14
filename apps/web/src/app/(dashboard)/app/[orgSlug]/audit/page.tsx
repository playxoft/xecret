import type { Metadata } from 'next';
import { AuditScreen } from '../../../_components/audit-screen';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditPage({ params }: PageProps<'/app/[orgSlug]/audit'>) {
  const { orgSlug } = await params;
  return <AuditScreen key={orgSlug} orgSlug={orgSlug} />;
}
