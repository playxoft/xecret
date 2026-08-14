import { describe, expect, it } from 'vitest';
import { parseAuthorizeRequest } from './authorize-request';

/**
 * The consent screen's query string is attacker-suppliable in full — these
 * tests are the record of what the page will and will not render from it.
 */

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function valid(): Record<string, string> {
  return {
    challenge: CHALLENGE,
    port: '52310',
    device: "Nitheesh's MacBook Pro",
    state: 'opaque-state-value',
  };
}

describe('parseAuthorizeRequest', () => {
  it('accepts a well-formed request', () => {
    const parsed = parseAuthorizeRequest(valid());
    expect(parsed).toEqual({
      challenge: CHALLENGE,
      port: 52310,
      device: "Nitheesh's MacBook Pro",
      state: 'opaque-state-value',
    });
  });

  it('rejects a missing or malformed challenge', () => {
    expect(parseAuthorizeRequest({ ...valid(), challenge: undefined })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), challenge: 'short' })).toBeNull();
    // 44 chars — an S256 challenge is exactly 43.
    expect(parseAuthorizeRequest({ ...valid(), challenge: `${CHALLENGE}a` })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), challenge: `${CHALLENGE.slice(0, 42)}+` })).toBeNull();
  });

  it('rejects ports outside the ephemeral-plausible range', () => {
    expect(parseAuthorizeRequest({ ...valid(), port: '80' })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), port: '1023' })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), port: '65536' })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), port: '-1' })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), port: '52310x' })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), port: undefined })).toBeNull();
  });

  it('rejects a device name carrying control characters — a spoof vector in the consent UI', () => {
    expect(parseAuthorizeRequest({ ...valid(), device: "line\nbreak" })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), device: 'esc[31m' })).toBeNull();
  });

  it('bounds the device name at 100 characters', () => {
    expect(parseAuthorizeRequest({ ...valid(), device: 'a'.repeat(100) })).not.toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), device: 'a'.repeat(101) })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), device: '' })).toBeNull();
  });

  it('rejects a missing or oversized state', () => {
    expect(parseAuthorizeRequest({ ...valid(), state: undefined })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), state: 'has space' })).toBeNull();
    expect(parseAuthorizeRequest({ ...valid(), state: 'a'.repeat(257) })).toBeNull();
  });

  it('ignores repeated parameters rather than picking one', () => {
    // An array means the query string carried the key twice — ambiguity in
    // exactly the values that decide where the code is sent. Refused whole.
    expect(parseAuthorizeRequest({ ...valid(), port: ['52310', '80'] })).toBeNull();
  });
});
