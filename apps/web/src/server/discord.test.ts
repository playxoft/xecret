import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContactDeliveryError, DiscordContactSink } from './discord';

/**
 * The contact sink, which is the one place in this product where a string a
 * stranger typed leaves it for a third party that renders markdown, resolves
 * mentions and unfurls links for a human inclined to trust their own channel.
 *
 * Everything below is about that boundary. None of it is about Discord's API
 * shape, which is why the assertions read the payload rather than the response.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Captures the one request the sink makes, and reports success. */
function capture(status = 204) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(status === 204 ? null : 'nope', { status });
  }) as typeof fetch;
  return calls;
}

function embed(body: Record<string, unknown>) {
  const embeds = body['embeds'] as {
    description?: string;
    fields: { name: string; value: string }[];
  }[];
  return embeds[0]!;
}

function valueOf(body: Record<string, unknown>, name: string): string {
  // The enquiry itself is the embed's description rather than a field: a field
  // value is capped at 1,024 by Discord and a real message does not fit.
  if (name === 'Message') return embed(body).description ?? '';
  return embed(body).fields.find((f) => f.name === name)?.value ?? '';
}

/**
 * Drops every backslash-escaped pair, leaving only characters Discord would act
 * on. Anything markup-significant still present after this is live.
 */
function stripEscapes(value: string): string {
  return value.replaceAll(/\\./g, '');
}

const sink = () => new DiscordContactSink('https://discord.example/webhook/secret-token');

const base = {
  reason: 'Sales or an Enterprise agreement',
  name: 'Ada',
  email: 'ada@example.com',
  message: 'We are moving off Vault and need to talk about residency.',
};

describe('the contact sink', () => {
  /**
   * The control, and the reason it is the first test in the file.
   *
   * Without `allowed_mentions`, `@everyone` in a message body pings an entire
   * Discord server — which turns a public, unauthenticated form into a free
   * notification cannon aimed at our own team. No amount of escaping the text
   * substitutes for it, because Discord resolves mentions from the rendered
   * message and not from what we thought we escaped.
   */
  it('tells Discord to resolve no mention of any kind', async () => {
    const calls = capture();
    await sink().deliver({ ...base, message: 'Hello @everyone and @here, see <@1234>' });

    expect(calls[0]!.body['allowed_mentions']).toEqual({ parse: [] });
  });

  it('keeps the untrusted text in embed fields rather than in content', async () => {
    const calls = capture();
    await sink().deliver(base);

    // No top-level `content`, so nothing a sender wrote is concatenated into a
    // message where markdown could forge the labels around it.
    expect(calls[0]!.body['content']).toBeUndefined();
    expect(valueOf(calls[0]!.body, 'Message')).toContain('moving off Vault');
  });

  /**
   * People paste API keys into contact forms — usually while asking why one does
   * not work. A channel full of other people's live credentials is a breach we
   * invited, so the same redaction the logs use runs before anything is sent.
   */
  it('masks a credential in the message body', async () => {
    const calls = capture();
    await sink().deliver({
      ...base,
      message: 'token: xec_live_abcdefghijklmnop and it still 401s',
    });

    expect(valueOf(calls[0]!.body, 'Message')).not.toContain('xec_live_abcdefghijklmnop');
  });

  /**
   * The regression that made `plain` and `scrubbed` two functions.
   *
   * `scrubText` replaces an email address with `[redacted-email]`, which is
   * right for a log line and catastrophic here: the address is the entire point
   * of the enquiry. Running every field through it delivered a perfectly
   * sanitised message that nobody could reply to.
   */
  it('delivers the sender’s address intact', async () => {
    const calls = capture();
    await sink().deliver(base);

    expect(valueOf(calls[0]!.body, 'Email')).toBe('ada@example.com');
  });

  /**
   * `U+202E` reverses the rendering of everything after it, which is how a
   * value forges the label beside it in a channel somebody already trusts.
   */
  it('strips bidirectional overrides and control characters', async () => {
    const calls = capture();
    await sink().deliver({
      ...base,
      name: 'Ada\u202Bevil\u202E',
      company: 'a\u0000b',
    });

    expect(valueOf(calls[0]!.body, 'Name')).not.toMatch(/[\u202a-\u202e]/);
    expect(valueOf(calls[0]!.body, 'Company')).toBe('a b');
  });

  /**
   * The defect this file's header used to argue could not happen.
   *
   * Discord suppresses masked links in plain `content` and renders them inside
   * embeds — so putting values in embed fields, which this sink does *for*
   * safety, is the one arrangement where `[label](url)` becomes a clickable link
   * wearing a label of the sender's choosing. In a channel whose only writer is
   * our own contact form, read by somebody with every reason to trust it.
   */
  it('renders a masked link as text rather than as a link', async () => {
    const calls = capture();
    await sink().deliver({
      ...base,
      message:
        'See [https://xecret.playxoft.com/admin](https://evil.example/harvest) for the error',
    });

    const value = valueOf(calls[0]!.body, 'Message');
    expect(value).toContain('evil.example');
    // Every bracket and parenthesis carries a backslash, so Discord renders the
    // literal characters and there is no link to click. Asserted as "no bare
    // one survives" rather than by counting escapes, because one unescaped
    // bracket is all a masked link needs.
    expect(stripEscapes(value)).not.toMatch(/[[\]()]/);
  });

  it('escapes the rest of the markup a value could forge a label with', async () => {
    const calls = capture();
    await sink().deliver({ ...base, name: '**Verified** _customer_ ~~not~~ `x` > # |' });

    const value = valueOf(calls[0]!.body, 'Name');
    for (const character of ['*', '_', '~', '`', '>', '#', '|']) {
      expect(value.includes(`\\${character}`), `${character} is not escaped`).toBe(true);
    }
    expect(stripEscapes(value)).not.toMatch(/[*_~`>#|]/);
  });

  /**
   * The email field goes through the same escaping. `EMAIL_PATTERN` allows
   * brackets and parentheses in a local part, so this was a second way in.
   */
  it('escapes a masked link smuggled through the address', async () => {
    const calls = capture();
    await sink().deliver({ ...base, email: '[x](https://evil.example)@e.co' });

    expect(stripEscapes(valueOf(calls[0]!.body, 'Email'))).not.toMatch(/[[\]()]/);
  });

  /**
   * An oversized payload is rejected by Discord with a 400 that explains
   * nothing — and an attacker who can make our request fail can make every
   * other enquiry fail with it.
   */
  /**
   * The old version of this test passed vacuously and hid a real defect. It
   * asserted `length <= 1_800`, which was satisfied by a far smaller number: the
   * sanitiser then in use capped its own output at 512, so 87% of a
   * maximum-length enquiry was dropped under an ellipsis that made it look
   * deliberate. The lower bound is the half that matters.
   */
  it('truncates a long message at its own limit, not at a hidden one', async () => {
    const calls = capture();
    await sink().deliver({ ...base, message: 'x'.repeat(5_000) });

    const value = valueOf(calls[0]!.body, 'Message');
    expect(value.length).toBeGreaterThan(3_000);
    expect(value.length).toBeLessThanOrEqual(3_900);
    expect(value.endsWith('…')).toBe(true);
  });

  /**
   * Discord's own caps, asserted because getting one wrong is a 400 with no
   * explanation and a lost enquiry — which is how the field-versus-description
   * mistake was found, by the live smoke test rather than by anything here.
   * 1,024 per field value, 4,096 for the description, 6,000 across the embed.
   */
  it.each([
    ['plain text', 'x'],
    // The input class the first version of this test could not fail on: `x` is
    // not escaped, so it never exercised the pass that *grows* the string. Every
    // character here does, which doubles the length — and doubling 3,900 clears
    // the 4,096 description cap, which is a 400 from Discord and a lost enquiry.
    ['markup', '*'],
    ['masked links', '[a](b)'],
    // Ordinary prose is not safe either. A pasted stack trace sits at roughly
    // this density of parentheses and underscores.
    ['prose with punctuation', 'at foo_bar (file.ts:12) '],
  ])('stays inside every limit Discord enforces, for %s', async (_label, unit) => {
    const fill = (length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    const calls = capture();
    await sink().deliver({
      reason: fill(200),
      name: fill(500),
      email: fill(500),
      company: fill(500),
      message: fill(10_000),
      source: fill(500),
    });

    const only = embed(calls[0]!.body);
    for (const entry of only.fields) {
      expect(entry.value.length, `${entry.name} exceeds Discord's field cap`).toBeLessThanOrEqual(
        1_024,
      );
    }
    expect((only.description ?? '').length).toBeLessThanOrEqual(4_096);

    const total =
      (only.description ?? '').length +
      only.fields.reduce((sum, entry) => sum + entry.name.length + entry.value.length, 0);
    expect(total).toBeLessThanOrEqual(6_000);
  });

  it('renders an absent optional field as a dash rather than "undefined"', async () => {
    const calls = capture();
    await sink().deliver(base);

    expect(valueOf(calls[0]!.body, 'Company')).toBe('—');
  });

  /**
   * The webhook URL *is* the credential — the token is a path segment. An error
   * carrying it would put it in a log line, which is the one place a secret
   * should never reach.
   */
  it('never puts the webhook URL in the error it throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network down');
    }) as typeof fetch;

    const error = await sink()
      .deliver(base)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ContactDeliveryError);
    expect(JSON.stringify(error)).not.toContain('secret-token');
    expect((error as Error).message).not.toContain('secret-token');
  });

  /**
   * The reason is in the title so the channel is scannable without opening
   * anything: a security questionnaire and a feature request must not look
   * identical in a list.
   */
  it('puts the reason in the title', async () => {
    const calls = capture();
    await sink().deliver({ ...base, reason: 'A security review or questionnaire' });

    const embeds = calls[0]!.body['embeds'] as { title: string }[];
    expect(embeds[0]!.title).toContain('A security review or questionnaire');
  });

  it('reports a rejected delivery with its status', async () => {
    capture(500);

    const error = await sink()
      .deliver(base)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ContactDeliveryError);
    expect((error as ContactDeliveryError).status).toBe(500);
  });
});
