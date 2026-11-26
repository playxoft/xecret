'use client';

import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { PageHeader } from '@/components/layout';
import { useSession } from './session';
import { SettingsLayout } from './settings-layout';
import { accountSettingsSections } from './settings-sections';

/**
 * The account area's frame: `/app/settings/*`, the settings that belong to the
 * person rather than to an organisation.
 *
 * A Client Component under the route's Server Component layout because the
 * list depends on the session — Unlock & auto-lock waits for a vault — and the
 * session is a client-side context (`session.tsx`).
 */
export function AccountSettingsLayout({ children }: { children: ReactNode }) {
  const { vault } = useSession();
  const groups = useMemo(
    () => accountSettingsSections({ vaultConfigured: vault.configured }),
    [vault.configured],
  );

  return (
    <SettingsLayout
      label="Account settings"
      groups={groups}
      header={
        <PageHeader
          size="lg"
          title="Settings"
          description="Your account, its security controls, and the actions that cannot be undone."
        />
      }
    >
      {children}
    </SettingsLayout>
  );
}
