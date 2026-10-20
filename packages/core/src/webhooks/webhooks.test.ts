import { describe, expect, it } from 'vitest';
import {
  buildWebhookPayload,
  checkWebhookUrl,
  generateWebhookSecret,
  isWebhookEventType,
  isWebhookSecret,
  nextAttemptAt,
  shouldDisableWebhook,
  signWebhook,
  verifyWebhook,
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WEBHOOK_DISABLE_AFTER_MS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SECONDS,
} from './index';
import type { WebhookEventData } from './index';

/**
 * The vector published with the Standard Webhooks specification (and the Svix
 * libraries that implement it). Pinned so that the signer is checked against
 * the scheme rather than against itself.
 */
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

describe('signing', () => {
  it('reproduces the published Standard Webhooks vector', async () => {
    expect(await signWebhook(VECTOR)).toBe(VECTOR.signature);
  });

  it('verifies a genuine delivery and any of several signatures in the header', async () => {
    const base = { ...VECTOR, now: VECTOR.timestamp + 10 };
    expect(await verifyWebhook({ ...base, signatureHeader: VECTOR.signature })).toBe(true);
    expect(await verifyWebhook({ ...base, signatureHeader: `v1,AAAA ${VECTOR.signature}` })).toBe(
      true,
    );
  });

  it('refuses a stale timestamp, a changed body, and the wrong secret', async () => {
    expect(
      await verifyWebhook({
        ...VECTOR,
        signatureHeader: VECTOR.signature,
        now: VECTOR.timestamp + 301,
      }),
    ).toBe(false);
    expect(
      await verifyWebhook({
        ...VECTOR,
        body: '{"test": 1}',
        signatureHeader: VECTOR.signature,
        now: VECTOR.timestamp,
      }),
    ).toBe(false);
    expect(
      await verifyWebhook({
        ...VECTOR,
        secret: generateWebhookSecret(),
        signatureHeader: VECTOR.signature,
        now: VECTOR.timestamp,
      }),
    ).toBe(false);
  });

  it('mints secrets of the documented shape, never the same twice', () => {
    const first = generateWebhookSecret();
    expect(first).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(isWebhookSecret(first)).toBe(true);
    expect(generateWebhookSecret()).not.toBe(first);
    expect(isWebhookSecret(VECTOR.secret)).toBe(true);
    expect(isWebhookSecret('whsec_short')).toBe(false);
    expect(isWebhookSecret('sk_live_nope')).toBe(false);
  });

  it('refuses to sign with something that is not a signing secret', async () => {
    await expect(signWebhook({ ...VECTOR, secret: 'not-a-secret' })).rejects.toThrow(TypeError);
  });
});

describe('payloads', () => {
  const data: WebhookEventData = {
    organization: { id: 'org-1', slug: 'acme' },
    project: { id: 'p-1', slug: 'api' },
    environment: { id: 'e-1', slug: 'production' },
    secret: { name: 'DATABASE_URL', version: 4 },
    actor: { type: 'user', id: 'u-1', label: 'ops@acme.test' },
  };

  it('carries names, slugs, versions and the actor', () => {
    const payload = buildWebhookPayload('secret.updated', new Date('2026-10-20T00:00:00Z'), data);
    expect(payload).toEqual({
      type: 'secret.updated',
      timestamp: '2026-10-20T00:00:00.000Z',
      data,
    });
  });

  it('drops any field the allowlist does not name — a value smuggled through a cast included', () => {
    const smuggled = {
      ...data,
      value: 'postgres://user:hunter2@db',
      secret: { ...data.secret, value: 'hunter2', plaintext: 'hunter2' },
      environment: { ...data.environment, ciphertext: 'xk2.gcm.AAAA' },
    } as unknown as WebhookEventData;

    const serialised = JSON.stringify(buildWebhookPayload('secret.updated', new Date(), smuggled));
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('xk2.');
    expect(serialised).not.toContain('"value"');
    expect(serialised).not.toContain('plaintext');
  });

  it('keeps only whole, non-negative counts and a parseable restore point', () => {
    const payload = buildWebhookPayload('environment.restored', new Date(), {
      ...data,
      counts: { created: 2, updated: -1, deleted: 1.5, unchanged: 7 },
      restoredTo: '2026-10-19T14:30:00Z',
    });
    expect(payload.data.counts).toEqual({ created: 2, unchanged: 7 });
    expect(payload.data.restoredTo).toBe('2026-10-19T14:30:00.000Z');

    const garbled = buildWebhookPayload('environment.restored', new Date(), {
      ...data,
      restoredTo: 'yesterday',
    });
    expect(garbled.data.restoredTo).toBeUndefined();
  });

  it('bounds every free-text field', () => {
    const long = buildWebhookPayload('secret.created', new Date(), {
      ...data,
      secret: { name: 'A'.repeat(10_000) },
      actor: { ...data.actor, label: 'x'.repeat(10_000) },
    });
    expect(long.data.secret?.name.length).toBe(256);
    expect(long.data.actor.label?.length).toBe(320);
  });

  it('knows its event types', () => {
    for (const type of WEBHOOK_EVENT_TYPES) expect(isWebhookEventType(type)).toBe(true);
    expect(isWebhookEventType('webhook.test')).toBe(false);
    expect(isWebhookEventType('secret.read')).toBe(false);
  });
});

describe('retries', () => {
  const failedAt = new Date('2026-10-20T00:00:00Z');

  it('backs off, then gives up after the last scheduled attempt', () => {
    expect(nextAttemptAt(1, failedAt)).toEqual(new Date(failedAt.getTime() + 60_000));
    expect(nextAttemptAt(WEBHOOK_RETRY_DELAYS_SECONDS.length, failedAt)).toEqual(
      new Date(failedAt.getTime() + 86_400_000),
    );
    expect(nextAttemptAt(WEBHOOK_MAX_ATTEMPTS, failedAt)).toBeNull();
  });

  it('disables only after many failures spread across a day', () => {
    const now = new Date(failedAt.getTime() + WEBHOOK_DISABLE_AFTER_MS);
    expect(shouldDisableWebhook(WEBHOOK_DISABLE_AFTER_FAILURES, failedAt, now)).toBe(true);
    expect(shouldDisableWebhook(WEBHOOK_DISABLE_AFTER_FAILURES - 1, failedAt, now)).toBe(false);
    expect(
      shouldDisableWebhook(WEBHOOK_DISABLE_AFTER_FAILURES, new Date(now.getTime() - 1000), now),
    ).toBe(false);
    expect(shouldDisableWebhook(100, null, now)).toBe(false);
  });
});

describe('checkWebhookUrl', () => {
  it.each([
    'https://hooks.example.com/xecret',
    'https://hooks.example.com:8443/path?q=1',
    'https://203.0.114.10/hook',
    'https://[2606:4700::6810:84e5]/hook',
  ])('accepts %s', (url) => {
    expect(checkWebhookUrl(url)).toEqual({ valid: true });
  });

  it.each([
    ['http://hooks.example.com', 'notHttps'],
    ['ftp://hooks.example.com', 'notHttps'],
    ['not a url', 'malformed'],
    ['https://user:pass@hooks.example.com', 'credentials'],
    ['https://localhost/hook', 'localName'],
    ['https://db.internal/hook', 'localName'],
    ['https://printer.local', 'localName'],
    ['https://intranet/hook', 'localName'],
    ['https://127.0.0.1/hook', 'privateAddress'],
    ['https://10.1.2.3', 'privateAddress'],
    ['https://172.16.0.1', 'privateAddress'],
    ['https://192.168.1.1', 'privateAddress'],
    ['https://169.254.169.254/latest/meta-data', 'privateAddress'],
    ['https://100.64.0.1', 'privateAddress'],
    ['https://0.0.0.0', 'privateAddress'],
    ['https://224.0.0.1', 'privateAddress'],
    ['https://203.0.113.5', 'privateAddress'],
    ['https://0x7f000001/', 'privateAddress'],
    ['https://2130706433/', 'privateAddress'],
    ['https://[::1]/', 'privateAddress'],
    ['https://[::ffff:127.0.0.1]/', 'privateAddress'],
    ['https://[fd00::1]/', 'privateAddress'],
    ['https://[fe80::1]/', 'privateAddress'],
    ['https://[64:ff9b::a00:1]/', 'privateAddress'],
    [`https://example.com/${'a'.repeat(2048)}`, 'tooLong'],
  ])('refuses %s as %s', (url, problem) => {
    const check = checkWebhookUrl(url);
    expect(check.valid).toBe(false);
    expect(check.problem).toBe(problem);
    expect(check.message).toBeTypeOf('string');
  });
});
