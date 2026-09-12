'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { appPath } from '../../_lib/paths';

/**
 * The settings area's tab bar.
 *
 * Links styled as tabs rather than a client-side `<Tabs>`: each tab is a
 * route, so a security question ("where do I change my passphrase?") has an address
 * that can be sent to someone, and a reload lands where the user was. The
 * active state is derived from the pathname, which is what makes this a nav,
 * not state.
 */
const TABS = [
  { href: appPath.account(), label: 'General' },
  { href: appPath.settingsSecurity(), label: 'Security' },
  { href: appPath.settingsDanger(), label: 'Danger zone' },
] as const;

export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings sections" className="border-line-subtle -mt-2 border-b">
      {/* ── No `overflow-x-auto` here, and the negative margin is on this
          element rather than on each tab ──
          Both for the same reason. `overflow-x: auto` forces the *other* axis
          out of `visible` and into `auto` too — that is the cascade's rule, not
          a browser quirk — and the tabs each hung a pixel of underline below
          this box to overlap the bar's hairline. One pixel of vertical overflow
          inside a box that now scrolls is a full vertical scrollbar, drawn down
          the side of a 36px-tall tab strip on every platform that reserves room
          for one. Pulling the whole list down by that pixel puts the underline
          where it was with nothing overflowing, and the labels are short enough
          that `flex-wrap` is a kinder answer than a scroll for the narrow
          viewport that cannot fit three of them. */}
      <ul className="-mb-px flex flex-wrap items-center gap-1">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative block shrink-0 rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm font-medium',
                  'transition-colors duration-150',
                  active
                    ? // Underline as well as colour, so the selection survives
                      // greyscale and colour-vision deficiency.
                      'border-accent text-fg'
                    : 'text-fg-muted hover:text-fg',
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
