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

const { Dialog, Toaster } = await import('@/components/ui');
const {
  DESCRIPTION_MAX_LENGTH,
  descriptionToSend,
  EditDescriptionForm,
  NAME_MAX_LENGTH,
  ProjectActions,
  projectMenuItems,
  projectPatch,
  RenameProjectForm,
} = await import('./project-actions');
const server = await import('@/server/schemas/resources');

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
        orgId: 'acme',
        project: {
          id: '018f3f6a-0000-7000-8000-000000000a01',
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
  it('is offered to whoever may read, create and update secrets, administrator or not', () => {
    expect(projectMenuItems(organization('owner'), [STAGING]).canImportArchive).toBe(true);
    expect(projectMenuItems(organization('admin'), [STAGING]).canImportArchive).toBe(true);
    expect(projectMenuItems(organization('developer'), [STAGING])).toEqual({
      canManageMembers: false,
      canInvite: false,
      canImportArchive: true,
      canRename: false,
      canEditDescription: false,
      canDelete: false,
    });
  });

  it('is not offered without every one of the actions the import asks', () => {
    // The import route authorises `secret.create` and `secret.update` up
    // front; before it is sent, the dialog reads each target's keys and its
    // complete listing, which ask `secret.read`. `can()` refuses a role
    // without any one of them before any grant counts.
    expect(projectMenuItems(organization('viewer'), [STAGING]).canImportArchive).toBe(false);
    for (const withheld of ['secret.read', 'secret.create', 'secret.update'] as const) {
      const narrowed = actionsOf('developer').filter((action) => action !== withheld);
      expect(
        projectMenuItems(organization('developer', narrowed), [STAGING]).canImportArchive,
        `a developer without ${withheld}`,
      ).toBe(false);
      // An admin narrowed the same way keeps the items that need none of them.
      const admin = projectMenuItems(
        organization(
          'admin',
          actionsOf('admin').filter((action) => action !== withheld),
        ),
        [STAGING],
      );
      expect(admin.canImportArchive, `an admin without ${withheld}`).toBe(false);
      expect(admin.canRename, `an admin without ${withheld}`).toBe(true);
    }
    // …and with all three back, a narrowed role is offered it again.
    expect(
      projectMenuItems(
        organization('developer', [
          ...CUSTOM_ROLE_FLOOR,
          'secret.read',
          'secret.create',
          'secret.update',
        ]),
        [STAGING],
      ).canImportArchive,
    ).toBe(true);
  });

  it('draws no menu for a developer whose only item needs a read they lack', () => {
    const narrowed = actionsOf('developer').filter((action) => action !== 'secret.read');
    expect(render(organization('developer', narrowed), [STAGING])).not.toContain('Manage API');
  });

  it('is not offered in a project with no environment to import into', () => {
    expect(projectMenuItems(organization('owner'), []).canImportArchive).toBe(false);
  });
});

describe('the Edit description item', () => {
  // Both items are `PATCH …/projects/{slug}`, which asks `project.update` and
  // nothing else — so whoever is offered one is offered the other.
  it('is offered on exactly the authority Rename is', () => {
    const cases: [string, SessionOrganization][] = [
      ['an owner', organization('owner')],
      ['an admin', organization('admin')],
      ['a developer', organization('developer')],
      ['a viewer', organization('viewer')],
      [
        'an admin without project.update',
        organization(
          'admin',
          actionsOf('admin').filter((action) => action !== 'project.update'),
        ),
      ],
      [
        'an admin with only project.update',
        organization('admin', ['project.read', 'project.update']),
      ],
    ];
    for (const [who, org] of cases) {
      const items = projectMenuItems(org, [STAGING]);
      expect(items.canEditDescription, who).toBe(items.canRename);
    }

    expect(projectMenuItems(organization('admin'), []).canEditDescription).toBe(true);
    expect(projectMenuItems(organization('developer'), []).canEditDescription).toBe(false);
    expect(
      projectMenuItems(
        organization(
          'admin',
          actionsOf('admin').filter((action) => action !== 'project.update'),
        ),
        [],
      ).canEditDescription,
    ).toBe(false);
  });

  it('holds the menu up on its own', () => {
    // An admin narrowed to project.update: neither members item, no import,
    // no delete — Rename and Edit description are all there is.
    const org = organization('admin', [...CUSTOM_ROLE_FLOOR, 'project.read', 'project.update']);
    expect(projectMenuItems(org, [])).toMatchObject({
      canManageMembers: false,
      canInvite: false,
      canImportArchive: false,
      canDelete: false,
      canEditDescription: true,
    });
    expect(render(org)).toContain('aria-label="Manage API"');
  });

  // Where it sits in the open menu — directly under Rename — is pinned in
  // `screen-wiring.test.ts`, which may read the source: the menu renders into a
  // portal, which static markup never draws.
});

const PROJECT = {
  id: '018f3f6a-0000-7000-8000-000000000a01',
  name: 'API',
  slug: 'api',
  description: 'Everything that talks to Stripe.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * One of the two forms, inside a bare `Dialog` root: the title needs the
 * dialog's context, and the content wrapper would portal it out of the markup.
 */
function renderForm(
  form: typeof RenameProjectForm | typeof EditDescriptionForm,
  description: string | null = PROJECT.description,
): string {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(
        Dialog,
        { open: true },
        createElement(form, {
          orgId: 'acme',
          project: { ...PROJECT, description },
          onOpenChange: () => {},
          onSaved: () => {},
        }),
      ),
    ),
  );
}

describe('the Rename project dialog', () => {
  it('edits the description beside the name', () => {
    const html = renderForm(RenameProjectForm);

    expect(html).toContain('Rename project');
    expect(html).toContain('value="API"');
    expect(html).toContain('>Description<');
    // Seeded with what the project says now, bounded as the server bounds it.
    expect(html).toMatch(
      /<textarea[^>]*maxLength="500"[^>]*>Everything that talks to Stripe\.<\/textarea>/,
    );
    expect(html).toContain(`32 of ${DESCRIPTION_MAX_LENGTH} characters.`);
    expect(html).toContain('Leave it empty to remove the description.');
  });

  it('opens on an empty box for a project with no description', () => {
    const html = renderForm(RenameProjectForm, null);
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(html).toContain(`0 of ${DESCRIPTION_MAX_LENGTH} characters.`);
  });

  // It opens on the project as it is, which is no change at all: a submit
  // from here would write the row and an audit record for an edit nobody made.
  it('opens with Save disabled', () => {
    for (const description of [PROJECT.description, null]) {
      expect(renderForm(RenameProjectForm, description)).toMatch(
        /<button[^>]*type="submit"[^>]*disabled=""[^>]*>[\s\S]*?Save changes/,
      );
    }
  });
});

/**
 * What the rename dialog sends, from what is in its two boxes. Save is
 * disabled exactly when this is empty (wired in `screen-wiring.test.ts`), so
 * these are also its enabled and disabled states as somebody types — which
 * static markup, rendering only the first, cannot show.
 */
describe('what the rename dialog sends', () => {
  const opened = { name: PROJECT.name, description: PROJECT.description };

  it('nothing, as opened — so Save starts disabled', () => {
    expect(projectPatch(opened, 'API', 'Everything that talks to Stripe.')).toEqual({});
    expect(projectPatch({ name: 'API', description: null }, 'API', '')).toEqual({});
  });

  it('the name alone when only the name changed', () => {
    // Above all, not the description it was opened with: that would revert one
    // saved meanwhile through "Edit description".
    expect(projectPatch(opened, 'Billing API', 'Everything that talks to Stripe.')).toEqual({
      name: 'Billing API',
    });
  });

  it('the description alone when only the description changed', () => {
    expect(projectPatch(opened, 'API', 'Payments, end to end.')).toEqual({
      description: 'Payments, end to end.',
    });
    // Emptied: cleared, as null.
    expect(projectPatch(opened, 'API', '')).toEqual({ description: null });
    expect(projectPatch({ name: 'API', description: null }, 'API', 'New.')).toEqual({
      description: 'New.',
    });
  });

  it('both, when both changed', () => {
    expect(projectPatch(opened, ' Billing ', ' Payments. ')).toEqual({
      name: 'Billing',
      description: 'Payments.',
    });
  });

  it('nothing again once an edit is undone — so Save is disabled again', () => {
    expect(projectPatch(opened, 'Billing API', 'Everything that talks to Stripe.')).not.toEqual({});
    // Typed back, give or take the whitespace the server would trim anyway.
    expect(projectPatch(opened, '  API ', ' Everything that talks to Stripe.\n')).toEqual({});
    // A cleared box on a project with no description is no description still.
    expect(projectPatch({ name: 'API', description: null }, 'API', '   ')).toEqual({});
  });
});

describe('the Edit description dialog', () => {
  it('holds the description alone, seeded and bounded', () => {
    const html = renderForm(EditDescriptionForm);

    expect(html).toContain('Edit description');
    expect(html).toMatch(
      /<textarea[^>]*maxLength="500"[^>]*>Everything that talks to Stripe\.<\/textarea>/,
    );
    // No name field: this form must not be able to rename the project.
    expect(html).not.toContain('value="API"');
    expect(html).not.toContain('>Name<');
  });

  // Saving an unchanged description would still write the row and move
  // "last modified"; the button waits for an edit.
  it('offers Save only once something has changed', () => {
    const html = renderForm(EditDescriptionForm);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>[\s\S]*?Save description/);
  });
});

describe('what a description field sends', () => {
  it('is the text trimmed, or null to clear it', () => {
    expect(descriptionToSend('  Payments, end to end.  ')).toBe('Payments, end to end.');
    // `null`, never `''`: the schema reads null as "clear it", and an empty
    // string would be stored as a description of nothing.
    expect(descriptionToSend('')).toBeNull();
    expect(descriptionToSend('   \n\t ')).toBeNull();
  });
});

describe('the client’s limits are the server’s', () => {
  // The textarea's `maxLength` is the only limit a person meets before they
  // press Save. A client bound above the server's lets them type into a
  // refusal; one below it refuses a description the API would have taken.
  it('for the name and the description', () => {
    expect(NAME_MAX_LENGTH).toBe(server.NAME_MAX_LENGTH);
    expect(DESCRIPTION_MAX_LENGTH).toBe(server.DESCRIPTION_MAX_LENGTH);
  });
});
