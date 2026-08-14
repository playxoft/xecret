'use client';

import { useMemo } from 'react';

import { apiPath, appPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import {
  BoxIcon,
  FileTextIcon,
  KeyIcon,
  SettingsIcon,
  TerminalIcon,
  UsersIcon,
} from '@/components/ui';
import type { OrgRole } from '@xecret/core/authz';
import type { NavSection } from '@/components/layout';
import type { ProjectListResponse, ProjectResponse } from '@/components/projects/types';
import { isOrgAdmin } from './session';

/**
 * The sidebar's contents.
 *
 * ── This one does fetch ──
 * The nav used to be derived from the URL alone, which made it correct on the
 * first paint of a cold navigation and cost nothing. It also meant the sidebar
 * could only ever show where you *are*, never where you could go — you had to
 * land on the projects page to discover a project existed, and the environments
 * of the project you were in were invisible until you visited one.
 *
 * So it reads two lists now. The trade is real and is paid for deliberately:
 *
 *  - **Two requests, both cached by the shell.** The project list is fetched
 *    once per organisation; the environment list once per project, and only for
 *    the project currently open. Not one request per project — a sidebar that
 *    fanned out over ten projects to fill in triangles nobody has clicked would
 *    spend ten round trips on decoration.
 *  - **The URL still wins on first paint.** Every item the URL implies is in the
 *    nav before either request resolves, so navigating never leaves the sidebar
 *    momentarily empty; the lists fill in around what is already there.
 *
 * ── Why environments are lazy ──
 * A project's environments load when that project is the one you are in. A user
 * expanding a *different* project's triangle sees its environments the moment
 * they navigate into it, which is one click later than ideal and the honest cost
 * of not issuing N requests on every page load. Nothing is hidden by it: the
 * project's own page lists every environment it has.
 */

export interface DashboardNavParams {
  orgSlug: string | null;
  projectSlug: string | null;
  envSlug: string | null;
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
  envSlug,
  viewerRole,
}: DashboardNavParams): readonly NavSection[] {
  const projects = useApiResource<ProjectListResponse>(
    orgSlug === null ? null : withQuery(apiPath.projects(orgSlug), { limit: PROJECT_LIMIT }),
  );

  // Only the open project. See the note above about not fanning out.
  const openProject = useApiResource<ProjectResponse>(
    orgSlug === null || projectSlug === null ? null : apiPath.project(orgSlug, projectSlug),
  );

  // Tokens and the audit log are rendered only for roles that can open them —
  // the usual rule: role decides what is drawn, the server decides what is
  // permitted. (The tokens page has a "your devices" half everyone could use,
  // but it lives with account-adjacent things for non-admins in a later pass.)
  const showAdminPages = viewerRole !== null && isOrgAdmin(viewerRole);

  return useMemo(() => {
    if (orgSlug === null) {
      return [{ label: 'You', items: [{ href: appPath.account(), label: 'Account' }] }];
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

    const environmentsOf = (slug: string): { slug: string; name: string }[] => {
      if (slug !== projectSlug) return [];

      const loaded = openProject.data?.environments;
      if (loaded !== undefined) {
        return loaded.map((environment) => ({
          slug: environment.slug,
          name: environment.name,
        }));
      }

      // Before the request lands: the environment in the URL, so the row you
      // clicked is highlighted immediately rather than a beat later.
      return envSlug === null ? [] : [{ slug: envSlug, name: envSlug }];
    };

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
            children: slugs.map((project) => ({
              href: appPath.project(orgSlug, project.slug),
              label: project.name,
              exact: true,
              children: environmentsOf(project.slug).map((environment) => ({
                href: appPath.environment(orgSlug, project.slug, environment.slug),
                label: environment.name,
                icon: <KeyIcon />,
              })),
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
            label: 'Settings',
            icon: <SettingsIcon />,
          },
        ],
      },
    ];
  }, [orgSlug, projectSlug, envSlug, projects.data, openProject.data, showAdminPages]);
}
