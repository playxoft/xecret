import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { DecryptionError } from '../../types';
import { BlobFormatError, parseBlob, parseGcmBlob } from '../blob';
import { fromHex, normalizedUtf8, toHex } from '../bytes';
import { decryptGcm, encryptGcmWithIv } from '../gcm';
import { deriveKey } from '../hkdf';
import { nobleArgon2idProvider } from '../kdf';
import type { Argon2idParams } from '../kdf';
import { encryptionPublicKey, signingPublicKey } from '../keypair';
import {
  deriveRecoveryKey,
  encodeRecoveryCode,
  parseRecoveryCode,
  RecoveryCodeError,
  recoveryLookupHash,
} from '../recovery';
import { openSealedBox, sealToPublicKeyWithRandomness } from '../sealed-box';
import { computeValueHmac, decryptSecret } from '../secret';
import type { SecretContext } from '../secret';
import { grantSigningPayload, signGrant, verifyGrantSignature } from '../sign';
import type { GrantSignatureFields } from '../sign';
import { buildVectors } from './build';
import type { Vector } from './build';
import schema from './e2ee-vectors.schema.json';
import file from './e2ee-vectors.json';

/**
 * The vectors are the mechanism by which the specification is enforced rather
 * than merely written. Two things happen here:
 *
 * 1. Every value in the committed file is **recomputed** from this
 *    implementation and compared. That is what the Go suite will do in Phase 4,
 *    against the same bytes, which is what makes the two implementations agree
 *    about the spec rather than about each other.
 * 2. The file is compared against a fresh build, so a change in the format that
 *    nobody regenerated fails here instead of in production.
 */

const vectors = file.vectors as unknown as Vector[];

const hex = (vector: Vector, key: string, from: 'input' | 'expected' = 'input'): string =>
  vector[from][key] as string;

const bytes = (vector: Vector, key: string, from: 'input' | 'expected' = 'input') =>
  fromHex(hex(vector, key, from));

const of = (kind: string): Vector[] => vectors.filter((vector) => vector.kind === kind);

describe('the vector file', () => {
  it('validates against its schema', () => {
    // strictRequired is relaxed for the reason the README gives: the schema uses
    // if/then to require lookupHashHex on recovery wraps, which that lint flags
    // and the specification permits.
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });

    // The one format the schema uses, defined here rather than pulling in
    // ajv-formats for a single regular expression.
    ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

    const validate = ajv.compile(schema);
    const valid = validate(file);

    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(valid).toBe(true);
  });

  it('declares the spec revision and blob version it was generated against', () => {
    expect(file.specVersion).toBe('2.0');
    expect(file.blobVersion).toBe('xk2');
    expect(file.generator).toMatch(/^packages\/core\/scripts\/generate-vectors\.ts@/);
  });

  it('covers all nine kinds', () => {
    expect(new Set(vectors.map((vector) => vector.kind))).toEqual(
      new Set([
        'argon2id',
        'hkdf',
        'uk-wrap',
        'sealed-box',
        'grant-signature',
        'secret-value',
        'value-hmac',
        'recovery-code',
        'blob-parse',
      ]),
    );
  });

  // A test failure names the id, so ids must be unique and stable.
  it('has unique ids', () => {
    expect(new Set(vectors.map((vector) => vector.id)).size).toBe(vectors.length);
  });

  /**
   * The staleness guard. Regeneration rewrites every value, so if the committed
   * file and a fresh build disagree, either the format changed without the file
   * being regenerated or the build is not deterministic — and both are bugs
   * worth failing a test run over.
   */
  it('is what the generator produces today', async () => {
    expect(await buildVectors()).toEqual(vectors);
  });
});

describe('argon2id vectors', () => {
  it.each(of('argon2id'))('$id', async (vector) => {
    const sk = await nobleArgon2idProvider(
      normalizedUtf8(vector.input['passphrase'] as string),
      bytes(vector, 'saltHex'),
      vector.input['params'] as Argon2idParams,
    );

    expect(toHex(sk)).toBe(hex(vector, 'skHex', 'expected'));
  });

  // The case an implementation silently gets wrong: the stored passphrase is the
  // NFC form, and the raw bytes it came from are not the same bytes.
  it('carries a vector whose NFC form differs from the input it records', () => {
    const withRaw = of('argon2id').filter((vector) => vector.input['passphraseRawHex']);
    expect(withRaw.length).toBeGreaterThan(0);

    for (const vector of withRaw) {
      const raw = new TextDecoder().decode(bytes(vector, 'passphraseRawHex'));

      expect(raw).not.toBe(vector.input['passphrase']);
      expect(raw.normalize('NFC')).toBe(vector.input['passphrase']);
    }
  });
});

describe('hkdf vectors', () => {
  it.each(of('hkdf'))('$id', async (vector) => {
    const saltHex = hex(vector, 'saltHex');

    const okm = await deriveKey({
      ikm: bytes(vector, 'ikmHex'),
      info: vector.input['info'] as string,
      ...(saltHex === '' ? {} : { salt: fromHex(saltHex) }),
    });

    expect(vector.input['length']).toBe(32);
    expect(toHex(okm)).toBe(hex(vector, 'okmHex', 'expected'));
  });

  it('covers every info string in the derivation table', () => {
    expect(new Set(of('hkdf').map((vector) => vector.input['info'] as string)).size).toBe(
      of('hkdf').length,
    );
    expect(of('hkdf').length).toBeGreaterThanOrEqual(6);
  });
});

describe('uk-wrap vectors', () => {
  it.each(of('uk-wrap'))('$id', async (vector) => {
    const aad = vector.expected['aad'] as string;

    const sealed = await encryptGcmWithIv(
      bytes(vector, 'wrapKeyHex'),
      bytes(vector, 'ivHex'),
      bytes(vector, 'ukHex'),
      aad,
    );

    const blob = vector.expected['blob'] as string;
    expect(`xk2.gcm.${toHex(sealed.iv)}`).toBe(`xk2.gcm.${toHex(parseGcmBlob(blob).iv)}`);
    expect(toHex(sealed.ciphertext)).toBe(toHex(parseGcmBlob(blob).ciphertext));

    // And it opens again.
    expect(toHex(await decryptGcm(bytes(vector, 'wrapKeyHex'), parseGcmBlob(blob), aad))).toBe(
      hex(vector, 'ukHex'),
    );
  });

  it('covers all three wrap kinds', () => {
    expect(new Set(of('uk-wrap').map((vector) => vector.input['wrapKind']))).toEqual(
      new Set(['passphrase', 'recovery', 'prf']),
    );
  });
});

describe('sealed-box vectors', () => {
  it.each(of('sealed-box'))('$id', async (vector) => {
    const recipientPrivateKey = bytes(vector, 'recipientPrivateKeyHex');
    const recipientPublicKey = encryptionPublicKey(recipientPrivateKey);
    const aad = vector.expected['aad'] as string;

    expect(toHex(recipientPublicKey)).toBe(hex(vector, 'recipientPublicKeyHex'));
    expect(toHex(encryptionPublicKey(bytes(vector, 'ephemeralPrivateKeyHex')))).toBe(
      hex(vector, 'ephemeralPublicKeyHex', 'expected'),
    );

    const blob = await sealToPublicKeyWithRandomness({
      recipientPublicKey,
      plaintext: bytes(vector, 'plaintextHex'),
      aad,
      ephemeralPrivateKey: bytes(vector, 'ephemeralPrivateKeyHex'),
      iv: bytes(vector, 'ivHex'),
    });

    expect(blob).toBe(vector.expected['blob']);

    // The vector carries the intermediate values so a mismatch can be localised
    // to the ECDH rather than to the HKDF or the AEAD.
    const salt = fromHex(
      hex(vector, 'ephemeralPublicKeyHex', 'expected') + hex(vector, 'recipientPublicKeyHex'),
    );
    expect(
      toHex(
        await deriveKey({ ikm: bytes(vector, 'sharedSecretHex', 'expected'), salt, info: aad }),
      ),
    ).toBe(hex(vector, 'derivedKeyHex', 'expected'));

    expect(toHex(await openSealedBox({ recipientPrivateKey, blob, aad }))).toBe(
      hex(vector, 'plaintextHex'),
    );
  });

  it('covers a member, a service token, an invitation, and a rotation pair', () => {
    expect(new Set(of('sealed-box').map((vector) => vector.input['recipientKind']))).toEqual(
      new Set(['member', 'token', 'invite']),
    );

    const versions = of('sealed-box')
      .filter((vector) => vector.input['purpose'] === 'edk-grant')
      .filter((vector) => vector.input['recipientKind'] === 'member')
      .map((vector) => vector.input['edkVersion']);

    expect(versions).toContain(1);
    expect(versions).toContain(2);
  });
});

describe('grant-signature vectors', () => {
  const fieldsOf = (vector: Vector): GrantSignatureFields => ({
    environmentId: vector.input['environmentId'] as string,
    edkVersion: vector.input['edkVersion'] as number,
    recipientKind: vector.input['recipientKind'] as GrantSignatureFields['recipientKind'],
    recipientId: vector.input['recipientId'] as string,
    recipientPublicKey: bytes(vector, 'recipientPublicKeyHex'),
    edkSealedBlob: vector.input['edkSealedBlob'] as string,
    ehkSealedBlob: vector.input['ehkSealedBlob'] as string,
  });

  it.each(of('grant-signature'))('$id', (vector) => {
    const signerPrivateSeed = bytes(vector, 'signerPrivateSeedHex');
    const fields = fieldsOf(vector);

    expect(toHex(signingPublicKey(signerPrivateSeed))).toBe(
      hex(vector, 'signerPublicKeyHex', 'expected'),
    );
    expect(toHex(grantSigningPayload(fields))).toBe(hex(vector, 'signingPayloadHex', 'expected'));

    const signature = signGrant({ signerPrivateSeed, fields });
    expect(signature).toBe(vector.expected['signatureBlob']);

    expect(
      verifyGrantSignature({
        signerPublicKey: signingPublicKey(signerPrivateSeed),
        fields,
        signature,
      }),
    ).toBe(true);
  });

  // The rotation pair: two grants that differ only in the EDK version must not
  // share a signature.
  it('signs a rotated grant differently', () => {
    const signatures = of('grant-signature').map((vector) => vector.expected['signatureBlob']);
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});

describe('secret-value vectors', () => {
  it.each(of('secret-value'))('$id', async (vector) => {
    const aad = vector.expected['aad'] as string;
    const plaintext = vector.input['plaintext'] as string;

    const sealed = await encryptGcmWithIv(
      bytes(vector, 'edkHex'),
      bytes(vector, 'ivHex'),
      normalizedUtf8(plaintext),
      aad,
    );

    const blob = vector.expected['blob'] as string;
    expect(toHex(sealed.ciphertext)).toBe(toHex(parseGcmBlob(blob).ciphertext));

    const context: SecretContext =
      vector.input['field'] === 'note'
        ? {
            field: 'note',
            orgId: vector.input['orgId'] as string,
            environmentId: vector.input['environmentId'] as string,
            secretId: vector.input['secretId'] as string,
          }
        : {
            field: 'value',
            orgId: vector.input['orgId'] as string,
            environmentId: vector.input['environmentId'] as string,
            secretId: vector.input['secretId'] as string,
            version: vector.input['version'] as number,
          };

    expect(await decryptSecret({ edk: bytes(vector, 'edkHex'), context, blob })).toBe(plaintext);
  });

  it('covers the boundaries the README asks for', () => {
    const plaintexts = of('secret-value').map((vector) => vector.input['plaintext'] as string);

    expect(plaintexts).toContain('');
    expect(plaintexts.some((value) => value.length === 65_536)).toBe(true);
    // eslint-disable-next-line no-control-regex -- deliberately asking for non-ASCII
    expect(plaintexts.some((value) => /[^ -]/.test(value))).toBe(true);
    expect(of('secret-value').some((vector) => vector.input['field'] === 'note')).toBe(true);
  });
});

describe('value-hmac vectors', () => {
  it.each(of('value-hmac'))('$id', async (vector) => {
    const ehk = bytes(vector, 'ehkHex');

    expect(toHex(await deriveKey({ ikm: ehk, info: 'xecret.v2.value-hmac' }))).toBe(
      hex(vector, 'hmacKeyHex', 'expected'),
    );
    expect(
      toHex(await computeValueHmac({ ehk, plaintext: vector.input['plaintext'] as string })),
    ).toBe(hex(vector, 'valueHmacHex', 'expected'));
  });
});

describe('recovery-code vectors', () => {
  it.each(of('recovery-code'))('$id', async (vector) => {
    const codeBytes = bytes(vector, 'codeBytesHex');
    const code = encodeRecoveryCode(codeBytes);

    expect(code.dataChars).toBe(vector.expected['dataChars']);
    expect(code.checkChar).toBe(vector.expected['checkChar']);
    expect(code.displayForm).toBe(vector.expected['displayForm']);

    expect(toHex(await recoveryLookupHash(codeBytes))).toBe(
      hex(vector, 'lookupHashHex', 'expected'),
    );
    expect(toHex(await deriveRecoveryKey(codeBytes))).toBe(hex(vector, 'rckHex', 'expected'));

    // The typed form normalises back to the same code.
    const typedInput = vector.input['typedInput'] as string | undefined;
    if (typedInput !== undefined) {
      expect(toHex(parseRecoveryCode(typedInput).codeBytes)).toBe(hex(vector, 'codeBytesHex'));
    }

    // And every variant one edit away is rejected by the check character.
    for (const invalid of (vector.expected['invalidVariants'] as string[]) ?? []) {
      expect(() => parseRecoveryCode(invalid)).toThrow(RecoveryCodeError);
    }
  });

  it('covers a left-padded code and a typed one', () => {
    expect(
      of('recovery-code').some((vector) =>
        (vector.expected['dataChars'] as string).startsWith('0'),
      ),
    ).toBe(true);
    expect(of('recovery-code').some((vector) => vector.input['typedInput'])).toBe(true);
  });
});

/**
 * The negative cases, and the reason `expected.rejected` exists at all: ADR
 * 0009's definition of done requires every parser to refuse every version it
 * does not know, and that is only tested if a negative case is a first-class
 * vector rather than an ad-hoc unit test on one side.
 */
describe('blob-parse vectors', () => {
  it.each(of('blob-parse'))('$id', async (vector) => {
    const blob = vector.input['blob'] as string;
    expect(vector.expected['rejected']).toBe(true);

    if (vector.expected['errorClass'] === 'format') {
      for (const algorithm of ['gcm', 'x25519', 'ed25519'] as const) {
        expect(() => parseBlob(blob, algorithm)).toThrow(BlobFormatError);
      }
      return;
    }

    // A decryption failure: the blob parses, and then fails to open, with an
    // error carrying no detail about which part of the guess was wrong.
    await expect(
      decryptGcm(bytes(vector, 'keyHex'), parseGcmBlob(blob), vector.input['aad'] as string),
    ).rejects.toThrow(DecryptionError);
  });

  it('covers every rejection reason the schema names', () => {
    expect(new Set(of('blob-parse').map((vector) => vector.input['reason']))).toEqual(
      new Set([
        'unknown-version',
        'unknown-algorithm',
        'payload-too-short',
        'invalid-base64url',
        'aad-mismatch',
        'tampered-ciphertext',
        'wrong-key',
      ]),
    );
  });
});
