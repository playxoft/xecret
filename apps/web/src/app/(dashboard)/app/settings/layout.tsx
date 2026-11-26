import { AccountSettingsLayout } from '../../_components/account-settings-layout';

/**
 * The frame every account settings section shares: the area's heading, the
 * list of its sections, and the one that is open. Each section is a route —
 * `account`, `appearance`, `sign-in`, `vault`, `unlock`, `devices`, `danger` —
 * so each keeps an address. See `settings-sections.ts` for the list, and
 * `settings-layout.tsx` for the frame, which an organisation's settings and an
 * environment's share.
 */
export default function SettingsLayout({ children }: LayoutProps<'/app/settings'>) {
  return <AccountSettingsLayout>{children}</AccountSettingsLayout>;
}
