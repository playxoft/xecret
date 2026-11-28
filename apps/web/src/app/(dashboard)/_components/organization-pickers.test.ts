import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Two organisations may share a name, and one person may belong to both. Every
 * picker that lists organisations has to let them tell the two apart: the end
 * of each id beside a name that collides, and always on the CLI consent
 * screen, where choosing the wrong one approves a device for somebody else's
 * secrets.
 */

const session = vi.hoisted(() => ({
  organizations: [] as {
    id: string;
    name: string;
    slug: string;
    role: string;
    authority: { customRole: null };
  }[],
}));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useSession: () => ({ organizations: session.organizations, createOrganization: () => {} }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => '/app',
}));

const { OrganizationsScreen } = await import('./organizations-screen');
const { OrgSwitcher } = await import('@/components/layout/org-switcher');

const membership = (id: string, name: string) => ({
  id,
  name,
  slug: `legacy-${id.slice(-4)}`,
  role: 'owner',
  authority: { customRole: null },
});

const ACME_ONE = membership('0192f0a1-7c3e-7d2a-9b1f-2a3b4c5d6e7f', 'Acme');
const ACME_TWO = membership('0192f0a1-7c3f-7a10-8c2e-9d8c7b6a5f4e', 'Acme');
const ZEBRA = membership('0192f0b4-1d2e-7f30-8a41-5b6c7d8e9f01', 'Zebra');

describe('the organisation picker at /app', () => {
  it('shows the end of each id beside a name two organisations share, and nowhere else', () => {
    session.organizations = [ACME_ONE, ACME_TWO, ZEBRA];
    const html = renderToStaticMarkup(createElement(OrganizationsScreen));

    expect(html).toContain('ID …4c5d6e7f');
    expect(html).toContain('ID …7b6a5f4e');
    expect(html).not.toContain('ID …7d8e9f01');
    // Never the slug.
    expect(html).not.toContain('legacy-');
  });

  it('shows names alone when every name is different', () => {
    session.organizations = [ACME_ONE, ZEBRA];
    const html = renderToStaticMarkup(createElement(OrganizationsScreen));

    expect(html).not.toContain('ID …');
  });
});

describe('the sidebar’s organisation switcher', () => {
  const shell = (organization: typeof ACME_ONE) => ({
    id: organization.id,
    name: organization.name,
    role: organization.role,
    href: `/app/${organization.id}`,
  });

  it('says which of two organisations of one name is the current one', () => {
    const html = renderToStaticMarkup(
      createElement(OrgSwitcher, {
        organizations: [shell(ACME_ONE), shell(ACME_TWO), shell(ZEBRA)],
        currentOrgId: ACME_TWO.id,
      }),
    );

    expect(html).toContain('7b6a5f4e');
    expect(html).toContain('ID ending 7b6a5f4e');
  });

  it('names a unique one by its name alone', () => {
    const html = renderToStaticMarkup(
      createElement(OrgSwitcher, {
        organizations: [shell(ACME_ONE), shell(ZEBRA)],
        currentOrgId: ZEBRA.id,
      }),
    );

    expect(html).not.toContain('7d8e9f01');
    expect(html).not.toContain('ID ending');
  });
});

/**
 * The consent screen draws its picker inside a vault gate that a static render
 * cannot open, so the label it uses for an organisation is rendered on its
 * own here; that the picker uses it is `screen-wiring.test.ts`'s.
 */
describe('the CLI consent screen', () => {
  it('draws the name with the end of the id, and the whole id on hover', async () => {
    const { OrganizationLabel } = await import('../../(auth)/cli/authorize/authorize-screen');
    const html = renderToStaticMarkup(
      createElement(OrganizationLabel, { name: 'Acme', id: ACME_ONE.id }),
    );

    expect(html).toContain('Acme');
    expect(html).toContain('ID …4c5d6e7f');
    expect(html).toContain(`title="${ACME_ONE.id}"`);
  });
});
