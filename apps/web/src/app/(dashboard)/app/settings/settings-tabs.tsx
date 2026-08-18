'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { appPath } from '../../_lib/paths';

/**
 * The settings area's tab bar.
 *
 * Links styled as tabs rather than a client-side `<Tabs>`: each tab is a
 * route, so a security question ("where do I change my PIN?") has an address
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
      <ul className="flex items-center gap-1 overflow-x-auto">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative -mb-px block shrink-0 rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm font-medium',
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
