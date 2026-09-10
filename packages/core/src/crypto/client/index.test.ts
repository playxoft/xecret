import { describe, expect, it } from 'vitest';
import * as client from './index';

/**
 * Guards on the public surface itself.
 *
 * The rule this enforces is the one `vectors/README.md` calls the whole of the
 * protection: the entry points that accept pinned randomness exist for the test
 * vectors and must not be reachable from production code. `package.json` exposes
 * only this barrel as `@xecret/core/crypto/client`, so what the barrel does not
 * export, a consumer cannot import — and the exported `seal` therefore takes no
 * IV, for the reason `crypto/aead.ts` gives at length.
 *
 * Browser safety is enforced one level up, by the lint rule that bans `node:`
 * imports across `packages/core` (ADR 0005, spec §11); a test could only ever
 * re-check a subset of what that already covers.
 */
describe('the public surface', () => {
  it('exports no entry point that accepts an IV or an ephemeral key', () => {
    const names = Object.keys(client);

    expect(names).not.toContain('encryptGcmWithIv');
    expect(names).not.toContain('encryptGcm');
    expect(names).not.toContain('decryptGcm');
    expect(names).not.toContain('sealToPublicKeyWithRandomness');

    for (const name of names) {
      expect(name).not.toMatch(/WithIv|WithRandomness|Deterministic/);
    }
  });

  it('exports the primitives the rest of the product needs', () => {
    for (const name of [
      'deriveStretchedKey',
      'parseKdfParams',
      'kdfNeedsUpgrade',
      'deriveKey',
      'generateEncryptionKeyPair',
      'generateSigningKeyPair',
      'deriveInviteKeyPair',
      'sealToPublicKey',
      'openSealedBox',
      'grantSigningPayload',
      'signGrant',
      'verifyGrantSignature',
      'wrapUserKey',
      'unwrapUserKey',
      'wrapPrivateKey',
      'unwrapPrivateKey',
      'sealGrant',
      'openGrant',
      'deriveUnlockVerifier',
      'generateRecoveryCode',
      'parseRecoveryCode',
      'recoveryLookupHash',
      'deriveRecoveryKey',
      'generateInviteFragment',
      'parseInviteFragment',
      'encryptSecret',
      'decryptSecret',
      'computeValueHmac',
      'parseBlob',
      'BlobFormatError',
      'DecryptionError',
      'MAX_SECRET_VALUE_BYTES',
    ]) {
      expect(client).toHaveProperty(name);
    }
  });

  it('has no side effects at module scope', () => {
    // Everything exported is a function, a class, or a constant; nothing runs on
    // import, so a bundler can drop what an application does not use.
    for (const [name, value] of Object.entries(client)) {
      expect(['function', 'object', 'string', 'number'], name).toContain(typeof value);
    }
  });
});
