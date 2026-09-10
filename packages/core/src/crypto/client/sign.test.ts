import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../ids/uuid-v7';
import { edkGrantAad, ehkGrantAad } from '../aad';
import { fromBase64Url, randomBytes, toBase64Url, utf8Encode } from '../encoding';
import { toHex, u32be } from './bytes';
import { generateEncryptionKeyPair, generateSigningKeyPair } from './keypair';
import { sealToPublicKey } from './sealed-box';
import {
  GRANT_SIGNATURE_DOMAIN,
  grantSigningPayload,
  signGrant,
  verifyGrantSignature,
} from './sign';
import type { GrantSignatureFields } from './sign';

const environmentId = uuidv7();
const recipientId = uuidv7();
const recipient = generateEncryptionKeyPair();
const signer = generateSigningKeyPair();

const edkSealedBlob = await sealToPublicKey({
  recipientPublicKey: recipient.publicKey,
  plaintext: randomBytes(32),
  aad: edkGrantAad({ environmentId, edkVersion: 1, recipientKind: 'member', recipientId }),
});

const ehkSealedBlob = await sealToPublicKey({
  recipientPublicKey: recipient.publicKey,
  plaintext: randomBytes(32),
  aad: ehkGrantAad({ environmentId, recipientKind: 'member', recipientId }),
});

const fields: GrantSignatureFields = {
  environmentId,
  edkVersion: 1,
  recipientKind: 'member',
  recipientId,
  recipientPublicKey: recipient.publicKey,
  edkSealedBlob,
  ehkSealedBlob,
};

describe('the canonical signing payload', () => {
  it('opens with the length-prefixed domain separation tag', () => {
    const payload = grantSigningPayload(fields);
    const domain = utf8Encode(GRANT_SIGNATURE_DOMAIN);

    expect(GRANT_SIGNATURE_DOMAIN).toBe('xecret.v2.grant-sig');
    expect([...payload.slice(0, 4)]).toEqual([...u32be(domain.length)]);
    expect([...payload.slice(4, 4 + domain.length)]).toEqual([...domain]);
  });

  it('is exactly the concatenation the spec describes', () => {
    const lp = (bytes: Uint8Array) => [...u32be(bytes.length), ...bytes];

    expect([...grantSigningPayload(fields)]).toEqual([
      ...lp(utf8Encode(GRANT_SIGNATURE_DOMAIN)),
      ...lp(utf8Encode(environmentId)),
      ...lp(u32be(1)),
      ...lp(utf8Encode('member')),
      ...lp(utf8Encode(recipientId)),
      ...lp(recipient.publicKey),
      ...lp(utf8Encode(edkSealedBlob)),
      ...lp(utf8Encode(ehkSealedBlob)),
    ]);
  });

  it('is stable across calls', () => {
    expect(toHex(grantSigningPayload(fields))).toBe(toHex(grantSigningPayload({ ...fields })));
  });

  // Every field is in the signature, so changing any of them must change the
  // bytes. This is the test that catches a field being dropped in a refactor.
  it('changes when any single field changes', () => {
    const baseline = toHex(grantSigningPayload(fields));
    const other = generateEncryptionKeyPair();

    const variants: GrantSignatureFields[] = [
      { ...fields, environmentId: uuidv7() },
      { ...fields, edkVersion: 2 },
      { ...fields, recipientKind: 'token' },
      { ...fields, recipientId: uuidv7() },
      { ...fields, recipientPublicKey: other.publicKey },
      { ...fields, edkSealedBlob: ehkSealedBlob },
      { ...fields, ehkSealedBlob: edkSealedBlob },
    ];

    for (const variant of variants) {
      expect(toHex(grantSigningPayload(variant))).not.toBe(baseline);
    }
  });

  // The uniform length prefixes exist precisely so no reshuffling of field
  // boundaries can collide.
  it('cannot be forged by moving a boundary between two fields', () => {
    const a = grantSigningPayload({ ...fields, recipientKind: 'member' });
    const b = grantSigningPayload({ ...fields, recipientKind: 'token' });
    expect(toHex(a)).not.toBe(toHex(b));
    expect(a.length).not.toBe(b.length);
  });

  // Signing the blob string covers its version prefix, so a downgrade to a
  // future weaker algorithm cannot reuse a signature.
  it('covers the version prefix of each sealed blob', () => {
    expect(toHex(grantSigningPayload(fields))).toContain(toHex(utf8Encode('xk2.x25519.')));
  });

  it('rejects malformed fields', () => {
    expect(() => grantSigningPayload({ ...fields, environmentId: 'nope' })).toThrow(TypeError);
    expect(() => grantSigningPayload({ ...fields, recipientId: 'NOT-LOWERCASE' })).toThrow(
      TypeError,
    );
    expect(() =>
      grantSigningPayload({
        ...fields,
        recipientKind: 'server' as unknown as GrantSignatureFields['recipientKind'],
      }),
    ).toThrow(TypeError);
    expect(() => grantSigningPayload({ ...fields, recipientPublicKey: randomBytes(31) })).toThrow(
      TypeError,
    );
    expect(() => grantSigningPayload({ ...fields, edkVersion: -1 })).toThrow(TypeError);
    expect(() => grantSigningPayload({ ...fields, edkVersion: 1.5 })).toThrow(TypeError);
  });

  // A signature over a string that is not a sealed box would authenticate
  // something no reader can open.
  it('rejects a sealed blob that is not one', () => {
    expect(() => grantSigningPayload({ ...fields, edkSealedBlob: 'xk2.gcm.AAAA' })).toThrow();
    expect(() =>
      grantSigningPayload({ ...fields, ehkSealedBlob: edkSealedBlob.replace('xk2', 'xk9') }),
    ).toThrow();
  });
});

describe('sign and verify', () => {
  it('round-trips', () => {
    const signature = signGrant({ signerPrivateSeed: signer.privateKey, fields });

    expect(signature.startsWith('xk2.ed25519.')).toBe(true);
    expect(verifyGrantSignature({ signerPublicKey: signer.publicKey, fields, signature })).toBe(
      true,
    );
  });

  it('is deterministic — Ed25519 signs the same message the same way', () => {
    expect(signGrant({ signerPrivateSeed: signer.privateKey, fields })).toBe(
      signGrant({ signerPrivateSeed: signer.privateKey, fields }),
    );
  });

  it('rejects a signature by another key', () => {
    const signature = signGrant({ signerPrivateSeed: generateSigningKeyPair().privateKey, fields });
    expect(verifyGrantSignature({ signerPublicKey: signer.publicKey, fields, signature })).toBe(
      false,
    );
  });

  // The rotation case: a grant for version 1 must not verify as one for
  // version 2.
  it('rejects a signature moved to a different grant', () => {
    const signature = signGrant({ signerPrivateSeed: signer.privateKey, fields });

    for (const variant of [
      { ...fields, edkVersion: 2 },
      { ...fields, recipientKind: 'token' as const },
      { ...fields, recipientId: uuidv7() },
      { ...fields, environmentId: uuidv7() },
    ]) {
      expect(
        verifyGrantSignature({ signerPublicKey: signer.publicKey, fields: variant, signature }),
      ).toBe(false);
    }
  });

  it('rejects a tampered signature', () => {
    const signature = signGrant({ signerPrivateSeed: signer.privateKey, fields });

    expect(
      verifyGrantSignature({
        signerPublicKey: signer.publicKey,
        fields,
        signature: `xk2.ed25519.${toBase64Url(randomBytes(64))}`,
      }),
    ).toBe(false);

    for (const index of [0, 31, 63]) {
      const bytes = fromBase64Url(signature.split('.')[2]!);
      bytes[index] = bytes[index]! ^ 0x01;

      expect(
        verifyGrantSignature({
          signerPublicKey: signer.publicKey,
          fields,
          signature: `xk2.ed25519.${toBase64Url(bytes)}`,
        }),
      ).toBe(false);
    }
  });

  // "Unverified" is the same answer in every case, so the verifier returns
  // false rather than throwing for some inputs and not others.
  it('returns false, never throws, for malformed input', () => {
    for (const signature of ['', 'not-a-blob', 'xk2.gcm.AAAA', `xk2.ed25519.${'A'.repeat(80)}`]) {
      expect(verifyGrantSignature({ signerPublicKey: signer.publicKey, fields, signature })).toBe(
        false,
      );
    }

    expect(
      verifyGrantSignature({
        signerPublicKey: randomBytes(31),
        fields,
        signature: signGrant({ signerPrivateSeed: signer.privateKey, fields }),
      }),
    ).toBe(false);
  });

  it('rejects a signer seed of the wrong length', () => {
    expect(() => signGrant({ signerPrivateSeed: randomBytes(31), fields })).toThrow(TypeError);
  });
});
