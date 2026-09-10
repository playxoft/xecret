import { describe, expect, it } from 'vitest';

import { passkeyAvailability } from './passkey';

/**
 * Feature detection, and why each answer is separate.
 *
 * The Security screen renders three different things from this, and getting it
 * wrong is not cosmetic: showing an enrol button on a browser with no
 * `PublicKeyCredential` produces a `TypeError` in a click handler, and telling a
 * developer on `http://localhost` that their browser does not support passkeys
 * sends them looking in entirely the wrong place.
 */

describe('passkeyAvailability', () => {
  const supported = {
    isSecureContext: true,
    PublicKeyCredential: class {},
    navigator: { credentials: {} },
  };

  it('is available on a secure context with the API present', () => {
    expect(passkeyAvailability(supported)).toBe('available');
  });

  it('reports an insecure context before it reports anything else', () => {
    // A plain-HTTP origin has no `PublicKeyCredential` either, so the order of
    // these checks is what decides which message a developer reads.
    expect(passkeyAvailability({ isSecureContext: false })).toBe('insecure-context');
  });

  it('is unsupported without PublicKeyCredential', () => {
    expect(passkeyAvailability({ isSecureContext: true, navigator: { credentials: {} } })).toBe(
      'unsupported',
    );
  });

  it('is unsupported without a credentials container', () => {
    expect(
      passkeyAvailability({
        isSecureContext: true,
        PublicKeyCredential: class {},
        navigator: {},
      }),
    ).toBe('unsupported');
  });

  it('is unsupported with no navigator at all', () => {
    expect(passkeyAvailability({ isSecureContext: true, PublicKeyCredential: class {} })).toBe(
      'unsupported',
    );
  });

  it('does not treat an absent isSecureContext as insecure', () => {
    // Only an explicit `false` means insecure. A scope that simply does not
    // report it — a non-browser environment, an older embedded view — is judged
    // on whether the API is there.
    expect(
      passkeyAvailability({ PublicKeyCredential: class {}, navigator: { credentials: {} } }),
    ).toBe('available');
  });
});
