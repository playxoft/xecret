import { describe, expect, it } from 'vitest';

import { apiPath, withQuery } from './paths';

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
