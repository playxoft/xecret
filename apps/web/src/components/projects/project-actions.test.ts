import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary, CUSTOM_ROLE_FLOOR, ROLE_CAPABILITIES } from '@xecret/core/authz';
import type { Action, CustomRole, OrgRole } from '@xecret/core/authz';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';

/**
 * The project's Manage menu, rendered to static markup: drawn whenever the
 * viewer may do any one thing in it — an inviter with nothing else included.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const { Toaster } = await import('@/components/ui');
const { ProjectActions } = await import('./project-actions');

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

function render(org: SessionOrganization): string {
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
        environments: [],
        organization: org,
        onChanged: () => {},
      }),
    ),
  );
}

describe('ProjectActions', () => {
  it('is drawn for an admin whose role may only invite', () => {
    // Everything a viewer holds, so there is a role to invite at, and
    // `member.invite` — but not `member.update`, `project.update` or
    // `project.delete`, the other three items' actions.
    const viewerActions = (Object.keys(ROLE_CAPABILITIES.viewer) as Action[]).filter(
      (action) => ROLE_CAPABILITIES.viewer[action],
    );
    const html = render(organization('admin', [...viewerActions, 'member.invite']));

    expect(html).toContain('aria-label="Manage API"');
  });

  it('is not drawn for an inviter with no role to invite at', () => {
    // As on the Members page the Invite item links to: `member.invite`
    // alone hands out nothing.
    const html = render(organization('admin', [...CUSTOM_ROLE_FLOOR, 'member.invite']));

    expect(html).not.toContain('Manage API');
  });

  it('is drawn for a plain admin', () => {
    expect(render(organization('admin'))).toContain('aria-label="Manage API"');
  });

  it('is not drawn for a role that may do none of it', () => {
    expect(render(organization('developer'))).not.toContain('Manage API');
    expect(render(organization('admin', [...CUSTOM_ROLE_FLOOR, 'project.read']))).not.toContain(
      'Manage API',
    );
  });
});
