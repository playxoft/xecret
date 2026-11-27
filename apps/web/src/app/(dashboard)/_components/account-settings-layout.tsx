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
 *
 * Headed "Account settings" rather than "Settings", for the reason the sidebar
 * names the other area "Organisation settings" in full (`dashboard-nav.tsx`):
 * there are two settings areas, and a page that only says "Settings" leaves
 * somebody to work out from its sections which one they are changing. It is
 * also what the user menu calls the way here, and what Profile's tab says.
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
          title="Account settings"
          description="Your account, its security controls, and the actions that cannot be undone."
        />
      }
    >
      {children}
    </SettingsLayout>
  );
}
