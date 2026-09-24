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
// `ContactDeliveryError` is part of the module's contract, not an incidental
// export: the route narrows on it to decide what reaches the log. A mock that
// omitted it made `cause instanceof undefined` throw inside the catch, which
// turned a correct 503 into a 500 — a defect in the test that looked exactly
// like a defect in the route.
vi.mock('@/server/discord', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/discord')>()),
  contactSink: discord.contactSink,
}));
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
  context.workerContext.mockResolvedValue({
    env: { XECRET_PUBLIC_URL: 'https://xecret.playxoft.com' },
    ctx: { waitUntil: () => {} },
  });
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

    // The path, not the full URL: once the same-origin check has passed the
    // origin is ours by definition, and repeating it is noise in the channel.
    expect(discord.deliver).toHaveBeenCalledWith(expect.objectContaining({ source: '/pricing' }));
  });

  it('says "direct" when there is no referer', async () => {
    await contact.POST(post(VALID));

    expect(discord.deliver).toHaveBeenCalledWith(expect.objectContaining({ source: 'direct' }));
  });

  /**
   * `Referer` is unforgeable only from a browser. A script sets it to anything,
   * and this value is rendered in a channel where a person reads it as evidence
   * of where somebody was standing — so `…/pricing — verified Enterprise trial`
   * used to land in front of that reader verbatim.
   */
  it('refuses to repeat a referer pointing somewhere else', async () => {
    await contact.POST(post(VALID, { referer: 'https://evil.example/trust-me' }));

    expect(discord.deliver).toHaveBeenCalledWith(expect.objectContaining({ source: 'external' }));
  });

  it('refuses to repeat a referer that is not a URL at all', async () => {
    // An em-dash cannot go in a header value, so the forged-provenance string a
    // script would actually send is spelled in ASCII here. What is under test is
    // the parse failure, not the punctuation.
    await contact.POST(post(VALID, { referer: 'not-a-url - verified Enterprise trial' }));

    expect(discord.deliver).toHaveBeenCalledWith(expect.objectContaining({ source: 'external' }));
  });

  /**
   * The only unauthenticated write in the product, and the rate limit is keyed
   * on the caller's address. Without an origin check, a third-party page posts
   * from every visitor's *own* address with a CORS-safelisted content type and
   * no preflight — and the limit stops bounding anything at all.
   */
  it('refuses a cross-origin submission', async () => {
    const response = await contact.POST(post(VALID, { origin: 'https://evil.example' }));

    expect(response.status).toBe(403);
    expect(discord.deliver).not.toHaveBeenCalled();
  });

  /**
   * A form that silently succeeds while the message goes nowhere is the worst
   * outcome a contact form has. It fails visibly and names the alternative; the
   * provider's own status stays in the log.
   */
  it('reports a delivery failure rather than pretending it arrived', async () => {
    discord.deliver.mockRejectedValue(new Error('discord is down'));

    const response = await contact.POST(post(VALID));
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(503);
    expect(body.error.message).toContain('github.com/playxoft/xecret/issues');
    expect(body.error.message).not.toContain('discord');
  });
});
