import { describe, expect, it } from 'vitest';

import { apiPath, appPath, parseDashboardPath, withQuery } from './paths';

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
 * The plans page sits where a project slug would, at `/app/{org}/upgrade`.
 *
 * Read as a project, the shell would ask the API for a project called
 * `upgrade`, draw it in the breadcrumb trail and light "Projects" in the
 * sidebar — on a page that has nothing to do with any project. `upgrade` is on
 * the reserved slug list for the same reason (`slug.test.ts` pins that half).
 */
describe('the plans page is an organisation page', () => {
  it('lives at /app/{org}/upgrade', () => {
    expect(appPath.upgrade('acme')).toBe('/app/acme/upgrade');
  });

  it('is not read as a project', () => {
    expect(parseDashboardPath(appPath.upgrade('acme'))).toEqual({
      orgSlug: 'acme',
      projectSlug: null,
      envSlug: null,
      isAccountArea: false,
    });
  });
});
