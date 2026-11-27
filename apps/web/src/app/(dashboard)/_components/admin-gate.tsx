'use client';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { Button, EmptyState, ShieldIcon } from '@/components/ui';
import { appPath } from '../_lib/paths';
import { useSession } from './session';

/**
 * Who is shown an admin page at all — the tabs at `/app/admin`, and the pages
 * for one organisation or one account beneath it.
 *
 * Whoever `/api/auth/me` says is an admin — an account listed in
 * `platform_admins` (`server/admin.ts`). Everybody else gets a 404, the same
 * answer the admin API gives a signed-in caller who is not an admin, thrown
 * before anything inside is rendered — so before any request is made. That
 * hides nothing (the routes are in a public repository); it is simply the
 * answer for something they cannot see. The API is the boundary: a browser
 * that talked itself past this check would draw a page of 404s.
 *
 * ── Somebody who stops being an admin while the page is open ──
 * Removing yourself on the Admins tab, or being removed by another admin and
 * then re-reading the session. The page they were using does not turn into a
 * 404 under them — that is the answer for a stranger — but says what happened
 * and where to go. Only a page that has never been an admin's is the 404.
 */

/** What the page draws: its content, the notice for an admin who just stopped being one, or a 404. */
export function adminPageState(admin: boolean, wasAdmin: boolean): 'admin' | 'left' | 'not-found' {
  if (admin) return 'admin';
  return wasAdmin ? 'left' : 'not-found';
}

export function AdminGate({ children }: { children: ReactNode }) {
  const { admin } = useSession();
  // Whether this page has been an admin's since it mounted. Adjusted during
  // render, React's documented way to follow a prop, so the session flipping
  // to `admin: true` is remembered on the same render that shows it.
  const [wasAdmin, setWasAdmin] = useState(admin);
  if (admin && !wasAdmin) setWasAdmin(true);

  const state = adminPageState(admin, wasAdmin);
  // Thrown during render, so the nearest not-found boundary draws the page an
  // unknown address would have — before any request is made.
  if (state === 'not-found') notFound();
  if (state === 'left') return <NoLongerAdmin />;
  return <>{children}</>;
}

function NoLongerAdmin() {
  return (
    <div className="mx-auto w-full max-w-xl py-6">
      <EmptyState
        icon={<ShieldIcon />}
        title="You are no longer an admin"
        description="This account was taken off xecret’s admins, so this page is closed to it. Only an admin can add it again."
        action={
          <Button variant="primary" asChild>
            <Link href={appPath.root()}>Go to your organisations</Link>
          </Button>
        }
      />
    </div>
  );
}
