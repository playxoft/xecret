import { redirect } from 'next/navigation';

/** `/app/settings` is the area, not a page — land on its first tab. */
export default function SettingsIndexPage() {
  redirect('/app/settings/account');
}
