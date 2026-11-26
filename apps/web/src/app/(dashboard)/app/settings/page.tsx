import { redirect } from 'next/navigation';

import { appPath } from '../../_lib/paths';

/** `/app/settings` is the area, not a page — land on its first section. */
export default function SettingsIndexPage() {
  redirect(appPath.account());
}
