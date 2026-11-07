import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary, CUSTOM_ROLE_FLOOR, ROLE_CAPABILITIES } from '@xecret/core/authz';
import type { Action, CustomRole, OrgRole } from '@xecret/core/authz';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';
import type { Environment } from './types';

/**
 * The project's Manage menu, rendered to static markup: drawn whenever the
 * viewer may do any one thing in it — an inviter with nothing else included,
 * and a developer who may only import an archive.
 *
 * The menu's items render into a portal only once it is open, which static
 * markup never is, so which items are drawn is asked of `projectMenuItems`.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const { Toaster } = await import('@/components/ui');
const { ProjectActions, projectMenuItems } = await import('./project-actions');

function organization(role: OrgRole, allowedActions?: readonly Action[]): SessionOrganization {
  const customRole: CustomRole | undefined =
    allowedActions === undefined
      ? undefined
      : { id: 'role-1', name: 'Narrowed', baseRole: role, allowedActions: [...allowedActions] };
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: {
      role,
      customRole:
        customRole === undefined
          ? null
          : { id: customRole.id, name: customRole.name, baseRole: customRole.baseRole },
      ...authoritySummary({ role, customRole }),
    },
  };
}

const STAGING: Environment = {
  name: 'Staging',
  slug: 'staging',
  isProduction: false,
  sortOrder: 0,
  encryptionMode: 'e2ee',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function render(org: SessionOrganization, environments: readonly Environment[] = []): string {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(ProjectActions, {
        orgSlug: 'acme',
        project: {
          name: 'API',
          slug: 'api',
          description: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        environments,
        organization: org,
        onChanged: () => {},
      }),
    ),
  );
}

/** Every action a built-in role holds. */
function actionsOf(role: OrgRole): Action[] {
  return (Object.keys(ROLE_CAPABILITIES[role]) as Action[]).filter(
    (action) => ROLE_CAPABILITIES[role][action],
  );
}

describe('ProjectActions', () => {
  it('is drawn for an admin whose role may only invite', () => {
    // Everything a viewer holds, so there is a role to invite at, and
    // `member.invite` — but not `member.update`, `project.update` or
    // `project.delete`, the other three items' actions.
    const html = render(organization('admin', [...actionsOf('viewer'), 'member.invite']));

    expect(html).toContain('aria-label="Manage API"');
  });

  it('is drawn for an inviter even with no role to invite at', () => {
    // The Invite item is a link to the Members page, which is where "there is
    // no role you may invite at" is explained — hiding the whole menu here
    // left an invite-only role with no way in at all (PR #104 item 8).
    const html = render(organization('admin', [...CUSTOM_ROLE_FLOOR, 'member.invite']));

    expect(html).toContain('aria-label="Manage API"');
  });

  it('is drawn for a plain admin', () => {
    expect(render(organization('admin'))).toContain('aria-label="Manage API"');
  });

  it('is drawn for a developer once there is an environment to import an archive into', () => {
    // A developer administers nothing here, so the import alone holds the
    // menu up.
    expect(render(organization('developer'), [STAGING])).toContain('aria-label="Manage API"');
  });

  it('is not drawn for a role that may do none of it', () => {
    // A developer, with nothing to import into.
    expect(render(organization('developer'))).not.toContain('Manage API');
    // A viewer, with somewhere to import into but no right to write there.
    expect(render(organization('viewer'), [STAGING])).not.toContain('Manage API');
    expect(
      render(organization('admin', [...CUSTOM_ROLE_FLOOR, 'project.read']), [STAGING]),
    ).not.toContain('Manage API');
  });
});

describe('the Import archive item', () => {
  it('is offered to whoever may create and update secrets, administrator or not', () => {
    expect(projectMenuItems(organization('owner'), [STAGING]).canImportArchive).toBe(true);
    expect(projectMenuItems(organization('admin'), [STAGING]).canImportArchive).toBe(true);
    expect(projectMenuItems(organization('developer'), [STAGING])).toEqual({
      canManageMembers: false,
      canInvite: false,
      canImportArchive: true,
      canRename: false,
      canDelete: false,
    });
  });

  it('is not offered without both of the actions the import request asks', () => {
    // The import route authorises `secret.create` and `secret.update` up
    // front, and `can()` refuses a role without them before any grant counts.
    expect(projectMenuItems(organization('viewer'), [STAGING]).canImportArchive).toBe(false);
    const withoutUpdate = actionsOf('developer').filter((action) => action !== 'secret.update');
    const withoutCreate = actionsOf('developer').filter((action) => action !== 'secret.create');
    expect(
      projectMenuItems(organization('developer', withoutUpdate), [STAGING]).canImportArchive,
    ).toBe(false);
    expect(
      projectMenuItems(organization('developer', withoutCreate), [STAGING]).canImportArchive,
    ).toBe(false);
    // An admin narrowed the same way keeps the items that need neither.
    const admin = projectMenuItems(
      organization(
        'admin',
        actionsOf('admin').filter((action) => action !== 'secret.update'),
      ),
      [STAGING],
    );
    expect(admin.canImportArchive).toBe(false);
    expect(admin.canRename).toBe(true);
  });

  it('is not offered in a project with no environment to import into', () => {
    expect(projectMenuItems(organization('owner'), []).canImportArchive).toBe(false);
  });
});
