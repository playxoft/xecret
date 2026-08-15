'use client';

import { useMemo } from 'react';

import { apiPath, appPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { BoxIcon, FileTextIcon, SettingsIcon, TerminalIcon, UsersIcon } from '@/components/ui';
import type { OrgRole } from '@xecret/core/authz';
import type { NavSection } from '@/components/layout';
import type { ProjectListResponse } from '@/components/projects/types';
import { isOrgAdmin } from './session';

/**
 * The sidebar's contents.
 *
 * ── This one does fetch ──
 * The nav used to be derived from the URL alone, which made it correct on the
 * first paint of a cold navigation and cost nothing. It also meant the sidebar
 * could only ever show where you *are*, never where you could go — you had to
 * land on the projects page to discover a project existed.
 *
 * So it reads the project list. The trade is paid for deliberately:
 *
 *  - **One request, cached by the shell**, made once per organisation. Not one
 *    per project: a sidebar that fanned out over ten projects to fill in
 *    triangles nobody has clicked would spend ten round trips on decoration.
 *  - **The URL still wins on first paint.** Every item the URL implies is in the
 *    nav before the request resolves, so navigating never leaves the sidebar
 *    momentarily empty; the list fills in around what is already there.
 *
 * ── Where environments went ──
 * The tree stops at projects. Environments were a third level that only ever
 * populated for the project you already had open, so the sidebar spent a request
 * and a nesting level restating what the screen in front of you was showing —
 * and a three-deep tree in a 240px column pushes every label into a truncation.
 * The project's own page lists its environments as cards, and the environment
 * screen carries a switcher for moving between them, which is where comparing
 * two environments actually happens.
 */

export interface DashboardNavParams {
  orgSlug: string | null;
  projectSlug: string | null;
  /**
   * The viewer's role in the current organisation, or `null` while the
   * session is still resolving. Passed in rather than read from `useSession`,
   * because this hook runs in the chrome — *above* the `SessionProvider` the
   * chrome renders — where the session is a resource, not yet a context.
   */
  viewerRole: OrgRole | null;
}

/** Enough projects for the sidebar; the projects page pages properly. */
const PROJECT_LIMIT = 50;

export function useDashboardNav({
  orgSlug,
  projectSlug,
  viewerRole,
}: DashboardNavParams): readonly NavSection[] {
  const projects = useApiResource<ProjectListResponse>(
    orgSlug === null ? null : withQuery(apiPath.projects(orgSlug), { limit: PROJECT_LIMIT }),
  );

  // Tokens and the audit log are rendered only for roles that can open them —
  // the usual rule: role decides what is drawn, the server decides what is
  // permitted. (The tokens page has a "your devices" half everyone could use,
  // but it lives with account-adjacent things for non-admins in a later pass.)
  const showAdminPages = viewerRole !== null && isOrgAdmin(viewerRole);

  return useMemo(() => {
    if (orgSlug === null) {
      return [
        {
          label: 'You',
          items: [
            { href: appPath.account(), label: 'General' },
            { href: appPath.settingsSecurity(), label: 'Security' },
            { href: appPath.settingsDanger(), label: 'Danger zone' },
          ],
        },
      ];
    }

    const known = projects.data?.projects ?? [];

    // The project in the URL, even when the list has not arrived — or does not
    // contain it, which happens for a project created in another tab. Without
    // this the sidebar would drop the project you are looking at.
    const slugs = known.some((project) => project.slug === projectSlug)
      ? known.map((project) => ({ slug: project.slug, name: project.name }))
      : [
          ...known.map((project) => ({ slug: project.slug, name: project.name })),
          ...(projectSlug === null ? [] : [{ slug: projectSlug, name: projectSlug }]),
        ];

    return [
      {
        items: [
          {
            href: appPath.org(orgSlug),
            label: 'Projects',
            icon: <BoxIcon />,
            // Without this every page beneath `/app/{org}` would highlight
            // "Projects", because they all share its prefix.
            exact: true,
            // `exact` is dropped with the third level: a project row is now the
            // deepest thing under it, so it should stay highlighted while you
            // are inside one of its environments.
            children: slugs.map((project) => ({
              href: appPath.project(orgSlug, project.slug),
              label: project.name,
            })),
          },
          {
            href: appPath.members(orgSlug),
            label: 'Members',
            icon: <UsersIcon />,
          },
          ...(showAdminPages
            ? [
                {
                  href: appPath.tokens(orgSlug),
                  label: 'Tokens',
                  icon: <TerminalIcon />,
                },
                {
                  href: appPath.audit(orgSlug),
                  label: 'Audit',
                  icon: <FileTextIcon />,
                },
              ]
            : []),
          {
            href: appPath.orgSettings(orgSlug),
            // Named in full, because another "Settings" exists: the account
            // area behind the avatar menu. Two entries that differ only by
            // where they sit is how someone changes the wrong one.
            label: 'Organisation settings',
            icon: <SettingsIcon />,
          },
        ],
      },
    ];
  }, [orgSlug, projectSlug, projects.data, showAdminPages]);
}
