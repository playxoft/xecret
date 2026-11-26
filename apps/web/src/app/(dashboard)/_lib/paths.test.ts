import { describe, expect, it } from 'vitest';

import { apiPath, appPath, canonicalProjectAddress, parseDashboardPath, withQuery } from './paths';

/**
 * The query builder every paginated screen composes its requests with.
 *
 * The case these exist for: a path that already carries a query string. The
 * audit log builds its filters once and then asks for the next page of *those*
 * filters, which used to append a second `?` and send
 * `…?action=secret.read?cursor=…` — read by the server as an `action` of
 * `secret.read?cursor=…`, so every filtered log 400'd the moment somebody
 * scrolled past the first page.
 */
describe('withQuery', () => {
  it('appends to a path with no query string', () => {
    expect(withQuery('/api/orgs/acme/audit', { limit: 50 })).toBe('/api/orgs/acme/audit?limit=50');
  });

  it('returns the path untouched when every value is absent', () => {
    expect(withQuery('/api/orgs/acme/audit', { action: undefined })).toBe('/api/orgs/acme/audit');
  });

  it('merges into a path that already has one', () => {
    const filtered = withQuery(apiPath.audit('acme'), { action: 'secret.read' });
    const paged = withQuery(filtered, { cursor: 'abc' });

    expect(paged).toBe('/api/orgs/acme/audit?action=secret.read&cursor=abc');
    // The shape of the bug, stated directly: one `?`, not two.
    expect(paged.split('?')).toHaveLength(2);
  });

  it('keeps every existing parameter, not just the first', () => {
    const paged = withQuery('/api/orgs/acme/audit?action=secret.read&outcome=denied', {
      cursor: 'abc',
    });

    const params = new URLSearchParams(paged.slice(paged.indexOf('?') + 1));
    expect(params.get('action')).toBe('secret.read');
    expect(params.get('outcome')).toBe('denied');
    expect(params.get('cursor')).toBe('abc');
  });

  it('lets a new value replace one already in the path', () => {
    // Paging is "the same query, one page on", and the cursor is the part that
    // moves. Two `cursor=` parameters would be a query the server reads the
    // wrong half of.
    expect(withQuery('/api/orgs/acme/audit?cursor=one', { cursor: 'two' })).toBe(
      '/api/orgs/acme/audit?cursor=two',
    );
  });

  it('drops a query string that held nothing', () => {
    expect(withQuery('/api/orgs/acme/audit?', {})).toBe('/api/orgs/acme/audit');
  });

  it('encodes what it merges', () => {
    expect(withQuery('/api/orgs/acme/audit?action=secret.read', { cursor: 'a b&c' })).toBe(
      '/api/orgs/acme/audit?action=secret.read&cursor=a+b%26c',
    );
  });
});

/**
 * The plans page lives under the organisation's `settings`, which is already
 * reserved — so it shadows no project, whatever projects already exist.
 */
describe('the plans page', () => {
  it('sits under settings, beside billing', () => {
    expect(appPath.orgPlans('acme')).toBe('/app/acme/settings/plans');
  });

  it('is read as an organisation page, not a project', () => {
    expect(parseDashboardPath(appPath.orgPlans('acme'))).toEqual({
      orgSlug: 'acme',
      projectId: null,
      envSlug: null,
      isAccountArea: false,
      isAdminArea: false,
    });
  });
});

const PROJECT_ID = '0193f2a1-7c3e-7d2a-9b1f-2a3b4c5d6e7f';

/**
 * A project's pages are named by its id, so an address never says what a
 * project is called. The organisation and the environment stay named by slug.
 */
describe('a project address', () => {
  it('names the project by id, and the organisation and environment by slug', () => {
    expect(appPath.project('acme', PROJECT_ID)).toBe(`/app/acme/${PROJECT_ID}`);
    expect(appPath.environment('acme', PROJECT_ID, 'production')).toBe(
      `/app/acme/${PROJECT_ID}/production`,
    );
    expect(appPath.environmentSettings('acme', PROJECT_ID, 'production')).toBe(
      `/app/acme/${PROJECT_ID}/production/settings`,
    );
  });

  it('is read back into the same three parts', () => {
    expect(parseDashboardPath(`/app/acme/${PROJECT_ID}`)).toEqual({
      orgSlug: 'acme',
      projectId: PROJECT_ID,
      envSlug: null,
      isAccountArea: false,
      isAdminArea: false,
    });
    expect(parseDashboardPath(`/app/acme/${PROJECT_ID}/production/settings`)).toEqual({
      orgSlug: 'acme',
      projectId: PROJECT_ID,
      envSlug: 'production',
      isAccountArea: false,
      isAdminArea: false,
    });
  });

  it('still reads an organisation page in the project slot as the organisation’s', () => {
    for (const page of ['settings', 'members', 'tokens', 'audit']) {
      expect(parseDashboardPath(`/app/acme/${page}`).projectId, page).toBeNull();
    }
  });

  it('talks to the API with the same segment its URL holds', () => {
    // The API takes the id or the slug, so the screens hand it whichever their
    // own address carries — and the two halves of this module still agree.
    expect(apiPath.environment('acme', PROJECT_ID, 'production')).toBe(
      `/api/orgs/acme/projects/${PROJECT_ID}/environments/production`,
    );
  });
});

/**
 * An address from before project pages were named by id: a bookmark, a chat
 * link, an old read-alert digest. It must arrive, at the same page.
 */
describe('the address an old project link is replaced with', () => {
  const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

  it('swaps the slug for the id and keeps the environment and the page beneath it', () => {
    expect(canonicalProjectAddress(at('/app/acme/payments-api'), PROJECT_ID)).toBe(
      `/app/acme/${PROJECT_ID}`,
    );
    expect(canonicalProjectAddress(at('/app/acme/payments-api/production'), PROJECT_ID)).toBe(
      `/app/acme/${PROJECT_ID}/production`,
    );
    expect(
      canonicalProjectAddress(at('/app/acme/payments-api/production/settings'), PROJECT_ID),
    ).toBe(`/app/acme/${PROJECT_ID}/production/settings`);
  });

  it('keeps the query string and the fragment exactly as they were', () => {
    expect(
      canonicalProjectAddress(
        at('/app/acme/payments-api/production/settings', '?tab=keys&x=1', '#rotate-key'),
        PROJECT_ID,
      ),
    ).toBe(`/app/acme/${PROJECT_ID}/production/settings?tab=keys&x=1#rotate-key`);
  });

  it('keeps a sub-path it has never heard of, and a trailing slash', () => {
    expect(
      canonicalProjectAddress(at('/app/acme/payments-api/production/some/later/tab/'), PROJECT_ID),
    ).toBe(`/app/acme/${PROJECT_ID}/production/some/later/tab/`);
  });

  it('changes only the project segment — never the organisation, never an environment', () => {
    // An organisation and an environment can share the project's slug; only
    // the fourth segment moves.
    expect(canonicalProjectAddress(at('/app/web/web/web'), PROJECT_ID)).toBe(
      `/app/web/${PROJECT_ID}/web`,
    );
  });

  it('touches nothing that is not a project page', () => {
    for (const pathname of [
      '/app',
      '/app/acme',
      '/app/acme/members',
      '/app/acme/settings/billing',
      '/app/settings/account',
      '/app/admin',
      '/invite/abc',
      '//app/acme/payments-api',
    ]) {
      expect(canonicalProjectAddress(at(pathname), PROJECT_ID), pathname).toBeNull();
    }
  });
});

/**
 * The settings sections' addresses. Under `settings` at both places it
 * appears, so none of them can be shadowed: `settings` is reserved for
 * organisations and projects alike.
 */
describe('the settings sections', () => {
  it('put the organisation’s sections under its settings, General at the area itself', () => {
    expect(appPath.orgSettings('acme')).toBe('/app/acme/settings');
    expect(
      [
        appPath.orgRoles('acme'),
        appPath.orgSingleSignOn('acme'),
        appPath.orgPolicies('acme'),
        appPath.orgWebhooks('acme'),
        appPath.orgBilling('acme'),
        appPath.orgPlans('acme'),
        appPath.orgDanger('acme'),
      ].map((path) => path.replace('/app/acme/settings/', '')),
    ).toEqual(['roles', 'single-sign-on', 'policies', 'webhooks', 'billing', 'plans', 'danger']);
  });

  it('read every one of them as an organisation page, not a project', () => {
    for (const path of [appPath.orgWebhooks('acme'), appPath.orgDanger('acme')]) {
      expect(parseDashboardPath(path), path).toEqual({
        orgSlug: 'acme',
        projectId: null,
        envSlug: null,
        isAccountArea: false,
        isAdminArea: false,
      });
    }
  });

  it('keep the account’s sections in the account area', () => {
    for (const path of [
      appPath.account(),
      appPath.settingsAppearance(),
      appPath.settingsSignIn(),
      appPath.settingsVault(),
      appPath.settingsUnlock(),
      appPath.settingsDevices(),
      appPath.settingsDanger(),
    ]) {
      expect(path.startsWith('/app/settings/'), path).toBe(true);
      expect(parseDashboardPath(path).isAccountArea, path).toBe(true);
    }
  });

  it('read an environment’s sections as that environment', () => {
    expect(
      parseDashboardPath(
        `${appPath.environmentSettings('acme', 'payments-api', 'production')}/policy`,
      ),
    ).toEqual({
      orgSlug: 'acme',
      projectId: 'payments-api',
      envSlug: 'production',
      isAccountArea: false,
      isAdminArea: false,
    });
  });
});

/**
 * The admin page sits where an organisation slug would. `admin` is reserved,
 * so no organisation shadows it — and the shell must not read it as one, or
 * every sidebar link would point into `/app/admin/…`.
 */
describe('the admin page', () => {
  it('is at /app/admin', () => {
    expect(appPath.admin()).toBe('/app/admin');
  });

  it('is read as no organisation at all', () => {
    expect(parseDashboardPath(appPath.admin())).toEqual({
      orgSlug: null,
      projectId: null,
      envSlug: null,
      isAccountArea: false,
      isAdminArea: true,
    });
  });

  it('keys its API by organisation id, and encodes it', () => {
    expect(apiPath.adminGrant('org 1')).toBe('/api/admin/organizations/org%201/grant');
    expect(apiPath.adminGrantEnd('org-1')).toBe('/api/admin/organizations/org-1/grant/end');
    expect(apiPath.adminPromoCodeRevoke('code-1')).toBe('/api/admin/promo-codes/code-1/revoke');
    expect(apiPath.adminAdmins()).toBe('/api/admin/admins');
    expect(apiPath.adminRemoveAdmin('user 1')).toBe('/api/admin/admins/user%201/remove');
  });

  it('leaves an owner’s promo code beside the rest of billing', () => {
    expect(apiPath.billingPromoCode('acme')).toBe('/api/orgs/acme/billing/promo-code');
    expect(apiPath.billingPromoCodeRedeem('acme')).toBe('/api/orgs/acme/billing/promo-code/redeem');
  });
});
