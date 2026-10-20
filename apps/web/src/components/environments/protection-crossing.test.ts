import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { protectionCrossingWarning } from './protection-crossing';

function apiError(code: 'conflict' | 'forbidden', message: string): ApiError {
  return new ApiError({ code, message, status: code === 'conflict' ? 409 : 403, requestId: null });
}

describe('protectionCrossingWarning', () => {
  it('reads the server’s consequence warning out of a link_crosses_protection conflict', () => {
    const warning = protectionCrossingWarning(
      apiError(
        'conflict',
        'link_crosses_protection: This would make the production environment api/production inherit values from api/staging.',
      ),
    );
    expect(warning).toBe(
      'This would make the production environment api/production inherit values from api/staging.',
    );
  });

  it('is null for every other failure, a bare Error included', () => {
    expect(
      protectionCrossingWarning(apiError('conflict', 'version_conflict: changed.')),
    ).toBeNull();
    expect(
      protectionCrossingWarning(apiError('forbidden', 'link_crosses_protection: not a conflict')),
    ).toBeNull();
    expect(protectionCrossingWarning(new Error('link_crosses_protection: x'))).toBeNull();
  });
});
