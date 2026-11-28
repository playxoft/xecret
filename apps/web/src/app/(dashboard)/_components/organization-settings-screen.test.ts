import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';

import type { Organization } from '@/components/projects/types';
import type { SessionOrganization } from './session';

/**
 * The organisation's General section and its Danger zone, rendered to static
 * markup: the name form offers Save only once the name differs from the saved
 * one, and the deletion is drawn for an owner and explained to anybody else.
 *
 * A server render runs no handlers, so the edits after the first paint are
 * pinned through `organizationNameChanged`, which is what the button's
 * `disabled` is computed from — against a saved name the form moves to what
 * it sent the moment a save succeeds.
 */

const viewer = vi.hoisted(() => ({ organization: null as SessionOrganization | null }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useOrganization: () => viewer.organization,
  useSession: () => ({ refresh: async () => {}, createOrganization: () => {} }),
}));

const ORGANIZATION: Organization = {
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  role: 'owner',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: () => ({
    data: { organization: ORGANIZATION },
    error: null,
    loading: false,
    reload: async () => {},
  }),
}));

const { Toaster } = await import('@/components/ui');
const { OrganizationDangerSettings, OrganizationForm, organizationNameChanged } =
  await import('./organization-settings-screen');

function member(role: OrgRole): SessionOrganization {
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: { role, customRole: null, ...authoritySummary({ role }) },
  };
}

function renderForm(canManage: boolean): string {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(OrganizationForm, {
        orgId: 'acme',
        organization: ORGANIZATION,
        canManage,
        onSaved: () => {},
      }),
    ),
  );
}

/** The opening tag of the button whose label is `label`. */
function buttonLabelled(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  if (at === -1) throw new Error(`no button labelled ${label}`);
  const start = html.lastIndexOf('<button', at);
  return html.slice(start, html.indexOf('>', start) + 1);
}

describe('the organisation name’s Save', () => {
  it('is disabled while the field holds the saved name', () => {
    expect(buttonLabelled(renderForm(true), 'Save changes')).toMatch(/\sdisabled=""/);
  });

  it('is not drawn for somebody who cannot rename the organisation', () => {
    const html = renderForm(false);
    expect(html).not.toContain('Save changes');
    expect(html).toContain('Only an owner or admin can change these.');
  });

  it('turns on for an edit, and off again when the edit is undone', () => {
    expect(organizationNameChanged('Acme', 'Acme')).toBe(false);
    expect(organizationNameChanged('Acme', 'Acme Ltd')).toBe(true);
    expect(organizationNameChanged('Acme', 'Acme')).toBe(false);
    // Trimmed, as the save trims it.
    expect(organizationNameChanged('Acme', ' Acme  ')).toBe(false);
  });

  it('is off again once the name is saved, what was sent being the new baseline', () => {
    const typed = ' Acme Ltd ';
    expect(organizationNameChanged('Acme', typed)).toBe(true);
    expect(organizationNameChanged(typed.trim(), typed.trim())).toBe(false);
  });
});

describe('the organisation’s Danger zone', () => {
  function render(role: OrgRole): string {
    viewer.organization = member(role);
    return renderToStaticMarkup(
      createElement(Toaster, null, createElement(OrganizationDangerSettings, { orgId: 'acme' })),
    );
  }

  it('offers an owner the deletion', () => {
    expect(render('owner')).toContain('Delete this organisation');
  });

  it('tells anybody else who can, rather than showing an empty page', () => {
    for (const role of ['admin', 'developer'] as const) {
      const html = render(role);
      expect(html, role).not.toContain('Delete organisation…');
      expect(html, role).toContain('Only an owner can delete this organisation');
    }
  });
});
