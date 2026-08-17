import { describe, expect, it } from 'vitest';

import { MailDeliveryError, describeMailFailure } from './mail';

/**
 * What a delivery failure is allowed to say in a log.
 *
 * These are the tests for a redaction boundary rather than for a formatter. The
 * PIN reset route logs the provider's own rejection body — it has to, because
 * "MailDeliveryError" does not distinguish an exhausted quota from a token
 * issued in the wrong Zoho region — and ZeptoMail echoes the recipient address
 * back inside that body. `describeMailFailure` is the only thing standing
 * between the two, so a regression here is a PII leak rather than a cosmetic
 * one, and it should fail a build.
 */
describe('describeMailFailure', () => {
  // Zoho's shape, abbreviated: a code, a human sentence, and the submitted
  // address quoted back at you.
  const rejection =
    '{"error":{"code":"TM_3201","details":[{"code":"SERR_156",' +
    '"message":"Invalid email address","target":"to.address",' +
    '"value":"alice.smith+reset@example.co.uk"}],"message":"Invalid Request"}}';

  it('keeps the status and the explanation, and drops the address', () => {
    const described = describeMailFailure(new MailDeliveryError(400, rejection));

    expect(described.error).toBe('MailDeliveryError');
    expect(described.status).toBe(400);

    // The two halves of the point, asserted separately so a regression in
    // either one names itself.
    expect(described.detail).not.toContain('alice.smith');
    expect(described.detail).not.toContain('example.co.uk');
    expect(described.detail).toContain('SERR_156');
    expect(described.detail).toContain('Invalid Request');
  });

  it('distinguishes the faults that have different fixes', () => {
    // Two of the faults an operator has to tell apart — no credit left, and a
    // token issued in a Zoho region this host has never heard of. Both arrive
    // as a 401, so the status alone cannot separate them and the sentence is
    // the whole signal. Logging the class name reduced these to one line.
    const quota = describeMailFailure(
      new MailDeliveryError(401, '{"error":{"code":"TM_8001","message":"Credits Exhausted"}}'),
    );
    const region = describeMailFailure(
      new MailDeliveryError(
        401,
        '{"error":{"code":"TM_3201","message":"Invalid API Token found"}}',
      ),
    );

    expect(quota.status).toBe(401);
    expect(quota.detail).toContain('Credits Exhausted');
    expect(region.detail).toContain('Invalid API Token found');
    expect(quota.detail).not.toBe(region.detail);
  });

  it('says only the name when the throw is not a delivery failure', () => {
    // A network error, an abort, a bug in the mailer — anything whose message
    // was written by something other than the provider. `errorName` and not
    // `describeError` for the same reason the whole module exists: a message
    // this code did not shape may carry the address it was sending to.
    const network = describeMailFailure(new TypeError('fetch failed for bob@example.com'));

    expect(network).toEqual({ error: 'TypeError' });
    expect(JSON.stringify(network)).not.toContain('bob@example.com');
  });

  it('names a thrown non-error rather than serialising it', () => {
    expect(describeMailFailure('alice@example.com')).toEqual({ error: 'unknown' });
    expect(describeMailFailure(undefined)).toEqual({ error: 'unknown' });
  });

  it('bounds a rejection body that is a proxy error page', () => {
    // An error from a proxy in front of the API is HTML, and the send path
    // already truncates at 500 characters. `scrubText`'s own 512-character
    // ceiling is the backstop, and this pins that the two agree rather than
    // one silently undoing the other.
    const html = `<html><body>${'x'.repeat(2000)}</body></html>`;
    const described = describeMailFailure(new MailDeliveryError(502, html.slice(0, 500)));

    expect(described.detail).toHaveLength(500);
  });
});
