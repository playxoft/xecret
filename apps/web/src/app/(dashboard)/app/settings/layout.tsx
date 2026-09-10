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
    // A centred column, matching the organisation and environment settings
    // screens. Settings are one reading column of fields — nothing here is a
    // table or a grid that wants the width — and on a wide display a form
    // pinned to the left margin leaves the eye travelling to a corner. The cap
    // lives on the whole frame rather than on the children, so the heading and
    // the tab bar stay the same width as the cards beneath them.
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Your account, its security controls, and the actions that cannot be undone."
      />
      <SettingsTabs />
      {children}
    </div>
  );
}
