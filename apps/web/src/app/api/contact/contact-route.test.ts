import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestLog } from '@/server/logging';
import { createLogger } from '@/server/logging';

/**
 * The contact route, invoked for real.
 *
 * `discord.test.ts` covers what the sink puts on the wire. This covers the
 * decisions the *route* makes — which are all about what reaches the sink at
 * all, and in what order:
 *
 *  - the rate limit is consumed before the body is parsed, so a flood costs a
 *    counter increment rather than a JSON parse and an outgoing fetch;
 *  - a honeypot submission is answered like a real one and delivered to nobody;
 *  - the provenance line comes from our own header rather than from the body,
 *    so a sender cannot write the sentence a human is about to read.
 *
 * Everything under the handler is stubbed. The database is not simulated
 * because this route does not have one — see `unbackedRoute`.
 */

const context = vi.hoisted(() => ({ workerContext: vi.fn() }));
const discord = vi.hoisted(() => ({ deliver: vi.fn(), contactSink: vi.fn() }));
const rateLimit = vi.hoisted(() => ({ enforce: vi.fn() }));

vi.mock('@/server/context', () => context);
vi.mock('@/server/discord', () => ({ contactSink: discord.contactSink }));
vi.mock('@/server/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/rate-limit')>()),
  ...rateLimit,
}));

function log(base: Record<string, unknown> = {}): RequestLog {
  return createLogger({
    sink: { write: () => {}, flush: () => Promise.resolve() },
    minimum: 'error',
    base,
  });
}

vi.mock('@/server/logging', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/logging')>();
  return {
    ...original,
    createRequestLog: (_env: unknown, base: Record<string, unknown>) => log(base),
  };
});

const contact = await import('./route');

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'We are moving off Vault and need EU data residency.',
};

beforeEach(() => {
  vi.clearAllMocks();
  context.workerContext.mockResolvedValue({ env: {}, ctx: { waitUntil: () => {} } });
  discord.contactSink.mockReturnValue({ deliver: discord.deliver });
  discord.deliver.mockResolvedValue(undefined);
  rateLimit.enforce.mockResolvedValue({ allowed: true, enforced: true });
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://xecret.playxoft.com/api/contact', {
    method: 'POST',
    headers: {
      origin: 'https://xecret.playxoft.com',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/contact', () => {
  it('delivers a valid enquiry and answers 202', async () => {
    const response = await contact.POST(post(VALID));

    expect(response.status).toBe(202);
    expect(discord.deliver).toHaveBeenCalledTimes(1);
    expect(discord.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ada@example.com' }),
    );
  });

  /**
   * Before the body is read, so a flood costs a counter increment rather than a
   * JSON parse and an outgoing connection — of which a Worker invocation has
   * six in total.
   */
  it('consumes the rate limit before anything else', async () => {
    rateLimit.enforce.mockRejectedValue(new Error('rate limited'));

    await contact.POST(post(VALID)).catch(() => undefined);

    expect(discord.deliver).not.toHaveBeenCalled();
  });

  /**
   * Answered exactly like a real submission. A refusal that tells the author
   * which field gave them away is a refusal they route around next time.
   */
  it('accepts a honeypot submission and delivers nothing', async () => {
    const response = await contact.POST(post({ ...VALID, website: 'http://spam.example' }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(discord.deliver).not.toHaveBeenCalled();
  });

  it('is not tripped by an empty honeypot', async () => {
    await contact.POST(post({ ...VALID, website: '   ' }));

    expect(discord.deliver).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed body before reaching the sink', async () => {
    const response = await contact.POST(post({ name: '', email: 'nope', message: 'hi' }));

    expect(response.status).toBe(422);
    expect(discord.deliver).not.toHaveBeenCalled();
  });

  /**
   * From our own header, never from the body. A sender who could set this would
   * be writing the provenance line in a message a human is about to trust.
   */
  it('takes the provenance from the referer rather than the payload', async () => {
    await contact.POST(
      post(
        { ...VALID, source: 'https://evil.example/trust-me' },
        { referer: 'https://xecret.playxoft.com/pricing' },
      ),
    );

    expect(discord.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'https://xecret.playxoft.com/pricing' }),
    );
  });

  it('says "direct" when there is no referer', async () => {
    await contact.POST(post(VALID));

    expect(discord.deliver).toHaveBeenCalledWith(expect.objectContaining({ source: 'direct' }));
  });
});
