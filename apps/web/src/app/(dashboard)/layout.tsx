import { DashboardChrome } from './_components/dashboard-chrome';

/**
 * The layout every signed-in screen sits inside.
 *
 * A Server Component that renders one Client Component: the shell needs the
 * browser (it reads the session cookie's answer from `/api/auth/me`, and it
 * derives the sidebar from the current path), but keeping this file on the
 * server means the route group itself costs no JavaScript and the boundary is
 * visible in one line rather than inferred from a `'use client'` at the top of a
 * 200-line file.
 */
export default function DashboardLayout({ children }: LayoutProps<'/'>) {
  return <DashboardChrome>{children}</DashboardChrome>;
}
