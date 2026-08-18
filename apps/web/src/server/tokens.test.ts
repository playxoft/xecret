import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@xecret/core/ids';
import { ApiError } from './errors';
import {
  decodeAuditCursor,
  encodeAuditCursor,
  resolveExpiry,
  serviceTokenCreateSchema,
} from './schemas/tokens';

/**
 * The token and audit schemas, tested where they are pure. Route wiring is the
 * wrapper's tests; the repository behaviour is the integration pass.
 */

describe('the audit cursor', () => {
  it('round-trips exactly', () => {
    const cursor = { createdAt: new Date('2026-08-14T09:30:00.123Z'), id: uuidv7() };

    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it('refuses anything it did not issue, as a 400 rather than a crash', () => {
    for (const junk of [
      '',
      'not-base64!',
      'YWJj',
      encodeAuditCursor({ createdAt: new Date(), id: uuidv7() }).slice(4),
    ]) {
      try {
        decodeAuditCursor(junk);
        expect.unreachable(`expected ${JSON.stringify(junk)} to be refused`);
      } catch (cause) {
        expect(cause, junk).toBeInstanceOf(ApiError);
        expect((cause as ApiError).code, junk).toBe('bad_request');
      }
    }
  });
});

describe('service token creation schema', () => {
  const NOW = new Date('2026-08-14T12:00:00Z');

  it('accepts the minimal body and leaves the default level to the repository', () => {
    const parsed = serviceTokenCreateSchema.parse({
      name: 'deploy',
      projectSlug: 'backend',
      environmentSlug: 'production',
    });
    expect(parsed.accessLevel).toBeUndefined();
  });

  it('refuses admin — a level no service-token action can spend', () => {
    expect(
      serviceTokenCreateSchema.safeParse({
        name: 'deploy',
        projectSlug: 'backend',
        environmentSlug: 'production',
        accessLevel: 'admin',
      }).success,
    ).toBe(false);
  });

  it('bounds the allowlist and shapes its entries', () => {
    expect(
      serviceTokenCreateSchema.safeParse({
        name: 'deploy',
        projectSlug: 'backend',
        environmentSlug: 'production',
        ipAllowlist: ['203.0.113.0/24', '2001:db8::1'],
      }).success,
    ).toBe(true);
    expect(
      serviceTokenCreateSchema.safeParse({
        name: 'deploy',
        projectSlug: 'backend',
        environmentSlug: 'production',
        ipAllowlist: ['not an address'],
      }).success,
    ).toBe(false);
  });

  it('refuses a token born expired', () => {
    expect(resolveExpiry(undefined, NOW)).toBeNull();
    expect(resolveExpiry('2026-08-15T12:00:00Z', NOW)).toEqual(new Date('2026-08-15T12:00:00Z'));
    expect(() => resolveExpiry('2026-08-14T12:00:00Z', NOW)).toThrow(ApiError);
  });
});
