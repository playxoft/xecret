import { describe, expect, it } from 'vitest';
import { toBase64Url } from '@xecret/core/crypto';
import { uuidv7 } from '@xecret/core/ids';
import { ApiError } from './errors';
import {
  assertKeypairMatchesMode,
  decodeAuditCursor,
  decodeTokenPublicKey,
  encodeAuditCursor,
  resolveExpiry,
  serviceTokenCreateSchema,
} from './schemas/tokens';

/** The thrown `ApiError`, so a test can read its code and its details. */
function rejects(run: () => void): ApiError {
  try {
    run();
  } catch (cause) {
    if (cause instanceof ApiError) return cause;
    throw cause;
  }
  throw new Error('expected the call to throw');
}

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

/**
 * The token's X25519 public key (spec §13.1).
 *
 * Only the public half ever reaches this schema. The private half is the token's
 * key half, minted in the browser beside it and never transmitted — so there is
 * nothing here that could accidentally accept one, and that is the property
 * these cases pin.
 */
describe('the service token public key', () => {
  const BODY = { name: 'deploy', projectSlug: 'backend', environmentSlug: 'production' };
  const PUBLIC_KEY = toBase64Url(new Uint8Array(32).fill(3));

  it('accepts a 32-byte key and decodes it to the bytes the column holds', () => {
    const parsed = serviceTokenCreateSchema.parse({ ...BODY, publicKey: PUBLIC_KEY });

    expect(parsed.publicKey).toBe(PUBLIC_KEY);
    expect(decodeTokenPublicKey(PUBLIC_KEY)).toEqual(new Uint8Array(32).fill(3));
  });

  it('stays optional in the schema, because the mode decides — not the shape', () => {
    expect(serviceTokenCreateSchema.parse(BODY).publicKey).toBeUndefined();
  });

  describe('the keypair and the environment mode', () => {
    it('refuses a keypair for a server-mode environment', () => {
      expect(() => assertKeypairMatchesMode(PUBLIC_KEY, 'server')).toThrow(ApiError);
    });

    it('refuses a keyless token for an end-to-end encrypted environment', () => {
      // The mint commits or it does not: a token minted without a public key has
      // nothing an environment key can be sealed to, cannot be given one later,
      // and cannot be un-minted. A stale client reaches this by believing the
      // environment is server-mode.
      const error = rejects(() => assertKeypairMatchesMode(undefined, 'e2ee'));
      expect(error.code).toBe('validation_failed');
      expect(error.fields?.[0]?.field).toBe('publicKey');
    });

    it('accepts each pairing that describes a token which can exist', () => {
      expect(() => assertKeypairMatchesMode(PUBLIC_KEY, 'e2ee')).not.toThrow();
      expect(() => assertKeypairMatchesMode(undefined, 'server')).not.toThrow();
    });
  });

  it.each([
    [toBase64Url(new Uint8Array(31)), 'a key one byte short'],
    [toBase64Url(new Uint8Array(33)), 'a key one byte long'],
    [`${'A'.repeat(42)}=`, 'base64 padding'],
    [`${'A'.repeat(42)}+`, 'the standard base64 alphabet'],
    ['', 'nothing at all'],
  ])('refuses %s (%s)', (publicKey) => {
    expect(serviceTokenCreateSchema.safeParse({ ...BODY, publicKey }).success).toBe(false);
  });

  /**
   * The key half must never arrive. It is 43 more characters on a token string
   * and the scalar that opens every secret in the environment, so a body that
   * tried to send one is a client that has misread the format badly enough that
   * accepting anything from it would be wrong.
   */
  it('has no field a private half could arrive in', () => {
    expect(
      serviceTokenCreateSchema.safeParse({
        ...BODY,
        publicKey: PUBLIC_KEY,
        keyHalf: toBase64Url(new Uint8Array(32).fill(9)),
      }).success,
    ).toBe(false);
    expect(serviceTokenCreateSchema.safeParse({ ...BODY, privateKey: PUBLIC_KEY }).success).toBe(
      false,
    );
  });
});
