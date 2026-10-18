import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';
import type { SsoStatus, SsoStatusResponse } from './sso-card';

/**
 * The Single sign-on card, rendered to static markup with the status it would
 * fetch handed to it — a server render runs no effects, so the data hook is
 * stubbed with what the API would answer. Each control it cannot offer must
 * say why, and none may be drawn whose only answer is a refusal.
 */

const resource = vi.hoisted(() => ({
  current: { data: null as unknown, error: null as unknown, loading: false },
  paths: [] as (string | null)[],
}));

vi.mock('@/app/(dashboard)/_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    resource.paths.push(path);
    return path === null
      ? { data: null, error: null, loading: false, reload: async () => {} }
      : { ...resource.current, reload: async () => {} };
  },
}));

const { Toaster } = await import('@/components/ui');
const { SingleSignOnCard, connectionLabel, ssoControls } = await import('./sso-card');

function organization(role: OrgRole): SessionOrganization {
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: { role, customRole: null, ...authoritySummary({ role }) },
  };
}

function status(over: Partial<SsoStatus> = {}): SsoStatus {
  return {
    enabled: true,
    ssoRequired: false,
    jitJoinEnabled: false,
    seatLimit: 25,
    addon: { enabled: true },
    connections: [{ id: 'conn_1', type: 'OktaSAML', state: 'active' }],
    domains: [{ domain: 'acme.example', state: 'verified' }],
    providerReachable: true,
    ...over,
  };
}

function shows(sso: SsoStatus): void {
  const data: SsoStatusResponse = { sso };
  resource.current = { data, error: null, loading: false };
}

function render(org: SessionOrganization): string {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(SingleSignOnCard, { orgSlug: 'acme', organization: org }),
    ),
  );
}

/** The `<button role="switch">` for one policy, by its id. */
function switchFor(html: string, id: string): string {
  return new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
}

beforeEach(() => {
  resource.paths = [];
  shows(status());
});

describe('SingleSignOnCard', () => {
  it.each(['developer', 'viewer'] as const)(
    'tells a %s who manages single sign-on, and fetches nothing',
    (role) => {
      const html = render(organization(role));

      expect(html).toContain('managed by the organisation’s owners and admins');
      expect(html).not.toContain('Turn on single sign-on');
      expect(html).not.toContain('Open setup portal');
      expect(resource.paths).toEqual([null]);
    },
  );

  it('offers an admin the switch-on when the add-on is held', () => {
    shows(status({ enabled: false, connections: null, domains: null }));

    const html = render(organization('admin'));

    expect(html).toContain('Turn on single sign-on');
    expect(html).not.toContain('Open setup portal');
    expect(resource.paths).toEqual(['/api/orgs/acme/sso']);
  });

  it('explains the add-on, and offers the way to ask, instead of a switch-on that would fail', () => {
    shows(status({ enabled: false, addon: { enabled: false }, connections: null, domains: null }));

    const html = render(organization('owner'));

    expect(html).toContain('Single sign-on is an add-on');
    expect(html).toContain('href="/contact"');
    expect(html).not.toContain('Turn on single sign-on');
  });

  it('shows the connection, the domains, the portal and both policies once SSO is on', () => {
    shows(
      status({
        connections: [
          { id: 'conn_1', type: 'OktaSAML', state: 'active' },
          { id: 'conn_2', type: 'GenericOIDC', state: 'draft' },
        ],
        domains: [
          { domain: 'acme.example', state: 'verified' },
          { domain: 'acme-labs.example', state: 'pending' },
        ],
      }),
    );

    const html = render(organization('owner'));

    expect(html).toContain('Okta (SAML)');
    expect(html).toContain('OpenID Connect');
    expect(html).toContain('Active');
    expect(html).toContain('Not finished');
    expect(html).toContain('acme.example');
    expect(html).toContain('Awaiting verification');
    expect(html).toContain('Open setup portal');
    expect(html).toContain('Require single sign-on');
    expect(html).toContain('Owners are always exempt');
    expect(html).toContain('Let people join through single sign-on');
    expect(html).toContain('25 seats');
    // Both available: an active connection and the add-on.
    expect(switchFor(html, 'sso-required')).not.toMatch(/\sdisabled=""/);
    expect(switchFor(html, 'sso-jit')).not.toMatch(/\sdisabled=""/);
    // The anchor the portal returns to.
    expect(html).toContain('id="single-sign-on"');
  });

  it('will not offer to require SSO before a connection is active, and says why', () => {
    shows(status({ connections: [{ id: 'conn_1', type: 'OktaSAML', state: 'draft' }] }));

    const html = render(organization('owner'));

    const required = switchFor(html, 'sso-required');
    expect(required).toMatch(/\sdisabled=""/);
    expect(required).toContain('aria-describedby="sso-required-hint"');
    expect(html).toContain('until a connection is active');
    // The opt-in has no such requirement.
    expect(switchFor(html, 'sso-jit')).not.toMatch(/\sdisabled=""/);
  });

  it('always lets a policy that is on be switched off, add-on or not', () => {
    shows(status({ addon: { enabled: false }, ssoRequired: true, jitJoinEnabled: true }));

    const html = render(organization('owner'));

    expect(switchFor(html, 'sso-required')).not.toMatch(/\sdisabled=""/);
    expect(switchFor(html, 'sso-jit')).not.toMatch(/\sdisabled=""/);
    expect(html).not.toContain('Open setup portal');
    expect(html).toContain('no longer holds the single sign-on add-on');
  });

  it('says when WorkOS could not be reached, and does not guess at a connection', () => {
    shows(status({ connections: null, domains: null, providerReachable: false }));

    const html = render(organization('admin'));

    expect(html).toContain('WorkOS could not be reached');
    expect(switchFor(html, 'sso-required')).toMatch(/\sdisabled=""/);
  });
});

describe('ssoControls', () => {
  it('mirrors the server: require needs the add-on and an active connection; join needs the add-on', () => {
    expect(ssoControls(status())).toEqual({
      hasActiveConnection: true,
      requireUnavailable: null,
      joinUnavailable: null,
    });
    expect(ssoControls(status({ connections: [] })).requireUnavailable).toMatch(/active/);
    expect(ssoControls(status({ addon: { enabled: false } }))).toMatchObject({
      requireUnavailable: expect.stringMatching(/add-on/),
      joinUnavailable: expect.stringMatching(/add-on/),
    });
  });
});

describe('connectionLabel', () => {
  it('names the providers people know by name, and spaces anything else', () => {
    expect(connectionLabel('AzureSAML')).toBe('Microsoft Entra ID (SAML)');
    expect(connectionLabel('GoogleSAML')).toBe('Google Workspace (SAML)');
    expect(connectionLabel('KeycloakSAML')).toBe('Keycloak SAML');
  });
});
