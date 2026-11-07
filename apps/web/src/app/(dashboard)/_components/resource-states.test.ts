import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ApiError } from '@/lib/api';

/**
 * What a screen shows for a request the server refused, rendered to static
 * markup. The case that matters here is the vault having locked under it: the
 * shell is already on its way to the lock screen, and the moment before it gets
 * there used to read "Could not load this project" with a request id to quote.
 */

vi.mock('next/navigation', () => ({
  useParams: () => ({ orgSlug: 'acme' }),
  usePathname: () => '/app/acme/api',
}));

const { ErrorState } = await import('./resource-states');

function apiError(code: string, status = 403): ApiError {
  return new ApiError({
    code: code as never,
    message: 'A sentence from the server.',
    status,
    requestId: 'req-locked-1',
  });
}

function render(error: unknown): string {
  return renderToStaticMarkup(
    createElement(ErrorState, { subject: 'this project', error, onRetry: () => {} }),
  );
}

describe('ErrorState', () => {
  it('says the vault is locked when the refusal was session_locked', () => {
    const html = render(apiError('session_locked'));

    expect(html).toContain('Your vault is locked');
    expect(html).toContain('Unlock your vault to continue.');
    expect(html).toContain('role="status"');
  });

  it('shows a locked vault nothing that reads as a failure', () => {
    const html = render(apiError('session_locked'));

    expect(html).not.toContain('Could not load');
    expect(html).not.toContain('Something went wrong');
    // Nothing to report, and nothing a retry could fix before the unlock.
    expect(html).not.toContain('req-locked-1');
    expect(html).not.toContain('Try again');
    expect(html).not.toContain('border-danger-line');
  });

  it('keeps the failure screen, request id and retry for every other refusal', () => {
    const html = render(apiError('internal_error', 500));

    expect(html).toContain('Could not load this project');
    expect(html).toContain('req-locked-1');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Your vault is locked');
  });

  it('still says "no access" for forbidden, which is not a lock', () => {
    const html = render(apiError('forbidden'));

    expect(html).toContain('You do not have access to this project');
    expect(html).not.toContain('Your vault is locked');
  });
});
