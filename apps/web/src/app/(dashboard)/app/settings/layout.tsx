import type { ReactNode } from 'react';

import { PageHeader } from '@/components/layout';
import { SettingsTabs } from './settings-tabs';

/**
 * The frame every settings tab shares: one header, one tab bar. The tabs are
 * routes (`account`, `security`, `danger`), so each keeps an address — see
 * `settings-tabs.tsx`.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Your account, its security controls, and the actions that cannot be undone."
      />
      <SettingsTabs />
      <div className="max-w-2xl">{children}</div>
    </div>
  );
}
