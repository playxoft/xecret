import type { ReactNode } from 'react';

import { PageHeader } from '@/components/layout';
import { SettingsHeader } from './settings-header';
import { SETTINGS_CONTENT_ID } from './settings-sections';
import { SettingsTabs } from './settings-tabs';
import { SettingsToc } from './settings-toc';

/**
 * The frame every settings tab shares: one header, one tab bar, and — from `xl`
 * up, in the gutter beside the cards — the contents of the tab you are on. The
 * tabs are routes (`account`, `security`, `danger`), so each keeps an address;
 * the contents list turns each *card* into one too. See `settings-tabs.tsx` and
 * `settings-toc.tsx`.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    // Two measures, one column. The cards keep the reading width they have on
    // the organisation and environment settings screens — settings are a column
    // of fields, and a form stretched across a 27-inch display is a worse form —
    // while the frame widens from `xl` to make room for the contents rail
    // beside them. Below that breakpoint the rail is hidden and this is exactly
    // the centred column it has always been.
    <div className="mx-auto flex w-full max-w-2xl flex-col xl:max-w-[57rem]">
      {/* Pinned, so the heading, the area you are in and the way to the other
          areas are never above the fold you are reading. */}
      <SettingsHeader>
        <PageHeader
          size="lg"
          title="Settings"
          description="Your account, its security controls, and the actions that cannot be undone."
        />
        <SettingsTabs />
      </SettingsHeader>

      <div className="flex gap-8 pt-6">
        <SettingsToc />
        {/* `min-w-0` so a wide child — a table, a long unbroken token — shrinks
            this column instead of pushing the rail off the viewport. */}
        <div id={SETTINGS_CONTENT_ID} className="min-w-0 flex-1 xl:max-w-2xl">
          {children}
        </div>
      </div>
    </div>
  );
}
