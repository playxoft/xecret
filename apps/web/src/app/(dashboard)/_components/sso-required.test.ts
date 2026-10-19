import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api';
import { ssoRequiredRemedy } from './sso-required';

/**
 * An organisation that requires its single sign-on answers `sso_required` to
 * a session that came some other way (review round 2, L9). The dashboard used
 * to show that as "Could not load …" — a dead end for somebody who can fix it
 * in one step. These pin the step.
 */

function apiError(code: string): ApiError {
  return new ApiError({
    code: code as never,
    message: 'This organisation requires its single sign-on.',
    status: 403,
    requestId: 'req-1',
  });
}

describe('ssoRequiredRemedy', () => {
  it('offers the organisation’s single sign-on, back to the page the person was on', () => {
    const remedy = ssoRequiredRemedy(apiError('sso_required'), 'acme', '/app/acme/api/production');

    expect(remedy?.title).toMatch(/requires single sign-on/);
    expect(remedy?.body).toMatch(/other organisations are not affected/);
    const href = new URL(remedy?.href ?? '', 'https://xecret.test');
    expect(href.pathname).toBe('/api/auth/login');
    expect(href.searchParams.get('org')).toBe('acme');
    expect(href.searchParams.get('next')).toBe('/app/acme/api/production');
    // No continue token: the login route sends the person to the warning page
    // first, which is the only place a deep link is followed from.
    expect(href.searchParams.has('continue')).toBe(false);
  });

  it('says the same without a link when the organisation is not known', () => {
    expect(ssoRequiredRemedy(apiError('sso_required'), undefined, '/app')?.href).toBeNull();
  });

  it('is nothing for any other error, which keeps its ordinary screen', () => {
    for (const code of ['forbidden', 'not_found', 'internal_error', 'session_locked']) {
      expect(ssoRequiredRemedy(apiError(code), 'acme', '/app/acme')).toBeNull();
    }
    expect(ssoRequiredRemedy(new Error('x'), 'acme', '/app/acme')).toBeNull();
  });
});
