/**
 * Builds the cross-implementation test vectors from this implementation.
 *
 * Read `README.md` in this directory first: nothing here fabricates an expected
 * value. Every ciphertext, derived key, signature, and digest below is whatever
 * the code in `crypto/client/` actually computes, and the Go implementation is
 * then required to reproduce it independently. A hand-written expected value
 * would encode a guess about the spec into a file that then *validates* the
 * guess.
 *
 * ## Why the randomness is pinned here rather than generated
 *
 * Every construction in the spec generates fresh randomness — IVs, salts,
 * ephemeral keypairs, code entropy. A vector cannot be reproduced unless that
 * randomness is an input, so the constants below are the exact values used, and
 * they are handed to the internal entry points that accept them. Those entry
 * points are absent from `crypto/client/index.ts` and from the package's
 * `exports`, which is what keeps the public API free of an IV parameter. See
 * `gcm.ts`.
 *
 * This module is pure: it returns the vector object and writes nothing.
 * `packages/core/scripts/generate-vectors.ts` is the thin shell that puts it on
 * disk, so that the part with the cryptography in it stays browser-safe and
 * inside the test suite's coverage.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { edkGrantAad, ehkGrantAad, secretNoteAad, secretValueAad, userKeyWrapAad } from '../../aad';
import { MAX_SECRET_VALUE_BYTES } from '../../secrets';
import type { Bytes } from '../../types';
import { toBase64Url } from '../../encoding';
import { formatGcmBlob, parseGcmBlob } from '../blob';
import { fromHex, normalizedUtf8, toHex } from '../bytes';
import { encryptGcmWithIv } from '../gcm';
import { deriveKey, HKDF_INFO } from '../hkdf';
import { nobleArgon2idProvider } from '../kdf';
import type { Argon2idParams } from '../kdf';
import { encryptionPublicKey, signingPublicKey } from '../keypair';
import {
  CROCKFORD_ALPHABET,
  deriveRecoveryKey,
  encodeRecoveryCode,
  isValidLuhnMod32,
  recoveryLookupHash,
} from '../recovery';
import { sealToPublicKeyWithRandomness } from '../sealed-box';
import { computeValueHmac } from '../secret';
import { grantSigningPayload, signGrant } from '../sign';

/** The revision of docs/security/e2ee-crypto-spec.md these are generated against. */
export const SPEC_VERSION = '2.0';

export interface Vector {
  id: string;
  kind: string;
  description: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface VectorFile {
  $schema: string;
  specVersion: string;
  blobVersion: 'xk2';
  generatedAt: string;
  generator: string;
  vectors: Vector[];
}

/* ───────────────────────────── pinned inputs ───────────────────────────── */

const ID = {
  org: '018f3b2c-9c1a-7c3d-8e4f-0a1b2c3d4e5f',
  environment: '018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e5f',
  secret: '018f3b2c-9c1a-7c3d-8e4f-2a1b2c3d4e5f',
  user: '018f3b2c-9c1a-7c3d-8e4f-3a1b2c3d4e5f',
  member: '018f3b2c-9c1a-7c3d-8e4f-4a1b2c3d4e5f',
  token: '018f3b2c-9c1a-7c3d-8e4f-5a1b2c3d4e5f',
  invitation: '018f3b2c-9c1a-7c3d-8e4f-6a1b2c3d4e5f',
} as const;

const KEY = {
  uk: '478d477ad012a2e99fb4611e7c2cdcc453afdc55933c12f76b96f1fd18d1019a',
  edkV1: '46699f903e8ffb25fa0732b7005c2f0ac01e515f867021b611854354ccab0823',
  edkV2: '0cecb4802b6a41a446e023aa624d301b2d525249ebfa00410894bb00f9d97756',
  ehk: '858408ae1b9b4d3b5fa70a45635f8eb65042756ce19fb7b788e975bf7a8492bf',
  stretched: 'ca63374a2f78dbd68a3038ce441cb0852af9d2ff4e582bac9ceadde9f95425ef',
  prfOutput: 'd955c3cae63ce104f628a0976c85dc378d68bd651724a363ae284da69efdaffd',
  memberPrivate: '26a9b87988efc959b7e1179fcb2a4d2d3e9050e6f3a8fb91767af148c6c28c06',
  tokenPrivate: '38ae2e3b9a72f5f27938ccad9cf865a36a275b847cafbef2eaceac12d197bb20',
  invitePrivate: '37d27a16cdf01ee80bc2af40f7eab9f745b6853ee6272bad33bcf1826735f0bb',
  signerSeed: 'd5fea1fab6d7f7c03c55d9fb19e79bdae109b5d0ef54fd4714fc979f38d7afb7',
  otherKey: 'ae772b4d3b0baff8459992407fa084bb379a5490493344d71a79399728804548',
} as const;

const EPHEMERAL = [
  'daff5fec6c29d8d7a061ba1bcd09dca3acec59b14c82b4a8e8f19d1df48a7480',
  '687b88ce9b5382f26097a6c922bb3cd8126449d59d83a169a650c5d553634e76',
  '0397849e4506a983d23921fe35ccd835d0dd8d5b363219e5a2a3d56167e5ed22',
  'cf9867e937df47ee26af6559bc0d2ccf2657a64138eeffb0c0ba0921bfe16996',
  '1385db30aed61130ae387deca4dbbc2e50664e8c6c6bcad7824118c7eb0ade51',
] as const;

const IV = [
  '0df32e4a4990e6f33ca37e17',
  '8c4d7d7a506ba945a414bfd0',
  'd188bebea9c8bbf206b1a2c8',
  '6a27413ce6a07bc98fb73520',
  '4670129d7a5905aa69fb1e97',
  '77443a087e85201b8f171cab',
  '70dbcae5a31071cdd9cb1e03',
  '90261afcae66494613d565f9',
  '9be9cac70f4ab2b91b70e1ad',
  '6e2b88dcaea089da9f6d27ae',
  'ff586009eace7463e8944e24',
  'f66e46eb0acbf79772a1bce7',
] as const;

const SALT = [
  '825db8b7d4bc5b699663d73ff9cbbaaf',
  'bc0133526668d0258561cc5257d7e93c',
  'bd93cf7ccd2a69cd2d48801e92f1fe7e',
] as const;

const CODE_BYTES = {
  typical: '02da44f52d586a4628199aff35676c15',
  /** Small enough that the base32 form needs left-padding with zeros. */
  padded: '000007d3d6ce2ba14cde1eb44d1a5f59',
  /** Chosen to contain both `0` and `1`, so the I/L/O aliasing is exercised. */
  typed: '070bef76a0da01c38d8bfb877a70a261',
} as const;

const INVITE_SEED = '519eeaf678a951999be2bb90f3766ef2';

const CREDENTIAL_ID_B64URL = 'q1w2e3r4t5y6u7i8o9p0';

/**
 * Argon2 parameters for the vectors, and why they are below the OWASP floor.
 *
 * Production parameters are m=64 MiB, t=3 — roughly a second of pure-JS work per
 * derivation (ADR 0009's measurement section). A vector suite that ran several
 * of those would be a suite people skip. These are deliberately cheap: they
 * exercise the same function, the same encoding, and the same normalisation,
 * and the parameter *bounds* are enforced by `parseKdfParams`, which has its own
 * tests. The vector schema carries a matching, clearly-marked carve-out.
 */
const TEST_KDF_PARAMS: Argon2idParams = { alg: 'argon2id', v: 19, m: 8192, t: 1, p: 1, len: 32 };
const TEST_KDF_PARAMS_ALT: Argon2idParams = {
  alg: 'argon2id',
  v: 19,
  m: 16_384,
  t: 2,
  p: 1,
  len: 32,
};

/** A passphrase whose NFC form differs from the bytes a macOS keyboard produces. */
const DECOMPOSED_PASSPHRASE = 'cafe\u0301 au lait, s\u2019il vous pla\u0302it';
const DECOMPOSED_VALUE = 'nai\u0308ve-token-cafe\u0301-2026';
const DECOMPOSED_NOTE = 'Rotate before the de\u0301mo. Owner: Zoe\u0308.';

/* ─────────────────────────────── builders ─────────────────────────────── */

async function argon2idVectors(): Promise<Vector[]> {
  const build = async (
    id: string,
    description: string,
    passphrase: string,
    saltHex: string,
    params: Argon2idParams,
    raw?: string,
  ): Promise<Vector> => {
    const normalized = passphrase.normalize('NFC');
    const sk = await nobleArgon2idProvider(normalizedUtf8(passphrase), fromHex(saltHex), params);

    return {
      id,
      kind: 'argon2id',
      description,
      input: {
        passphrase: normalized,
        ...(raw === undefined ? {} : { passphraseRawHex: toHex(rawUtf8(raw)) }),
        saltHex,
        params,
      },
      expected: { skHex: toHex(sk) },
    };
  };

  return [
    await build(
      'argon2id/ascii-passphrase',
      'ASCII master passphrase at the vector parameters.',
      'correct horse battery staple',
      SALT[0],
      TEST_KDF_PARAMS,
    ),
    await build(
      'argon2id/nfc-normalised',
      'Decomposed passphrase: the NFC form is what enters the KDF, so both spellings derive one key.',
      DECOMPOSED_PASSPHRASE,
      SALT[1],
      TEST_KDF_PARAMS,
      DECOMPOSED_PASSPHRASE,
    ),
    await build(
      'argon2id/alternate-params',
      'A non-default parameter set, so an implementation cannot hard-code m and t.',
      'correct horse battery staple',
      SALT[2],
      TEST_KDF_PARAMS_ALT,
    ),
  ];
}

/** UTF-8 of a string exactly as given — deliberately *not* normalised. */
function rawUtf8(value: string): Bytes {
  return new TextEncoder().encode(value);
}

async function hkdfVector(
  id: string,
  description: string,
  ikmHex: string,
  info: string,
  saltHex = '',
): Promise<Vector> {
  const okm = await deriveKey({
    ikm: fromHex(ikmHex),
    info,
    ...(saltHex === '' ? {} : { salt: fromHex(saltHex) }),
  });

  return {
    id,
    kind: 'hkdf',
    description,
    input: { ikmHex, saltHex, info, length: 32 },
    expected: { okmHex: toHex(okm) },
  };
}

async function hkdfVectors(sealedBoxBranch: {
  ikmHex: string;
  saltHex: string;
  info: string;
}): Promise<Vector[]> {
  return [
    await hkdfVector(
      'hkdf/uk-wrap',
      'Stretched Key to the passphrase wrap key.',
      KEY.stretched,
      HKDF_INFO.ukWrap,
    ),
    await hkdfVector(
      'hkdf/unlock-verifier',
      'Stretched Key to the unlock verifier — a sibling branch of the wrap key, not a parent.',
      KEY.stretched,
      HKDF_INFO.unlockVerifier,
    ),
    await hkdfVector(
      'hkdf/recovery-wrap',
      'A recovery code to its RCK.',
      CODE_BYTES.typical,
      HKDF_INFO.recoveryWrap,
    ),
    await hkdfVector(
      'hkdf/prf-wrap',
      'A WebAuthn PRF output to the passkey wrap key.',
      KEY.prfOutput,
      HKDF_INFO.prfWrap,
    ),
    await hkdfVector(
      'hkdf/value-hmac',
      'The Environment HMAC Key to the valueHmac key.',
      KEY.ehk,
      HKDF_INFO.valueHmac,
    ),
    await hkdfVector(
      'hkdf/invite-key',
      'An invite fragment seed to the invitation X25519 private scalar.',
      INVITE_SEED,
      HKDF_INFO.inviteKey,
    ),
    await hkdfVector(
      'hkdf/sealed-box-branch',
      'The sealed box branch: the AAD is the info string and the two public keys are the salt.',
      sealedBoxBranch.ikmHex,
      sealedBoxBranch.info,
      sealedBoxBranch.saltHex,
    ),
  ];
}

async function ukWrapVectors(): Promise<Vector[]> {
  const uk = fromHex(KEY.uk);
  const lookupHashHex = toHex(await recoveryLookupHash(fromHex(CODE_BYTES.typical)));

  const wrap = async (
    id: string,
    description: string,
    wrapKeyHex: string,
    ivHex: string,
    aad: string,
    extra: Record<string, unknown>,
  ): Promise<Vector> => ({
    id,
    kind: 'uk-wrap',
    description,
    input: { userId: ID.user, wrapKeyHex, ukHex: KEY.uk, ivHex, ...extra },
    expected: {
      aad,
      blob: formatGcmBlob(await encryptGcmWithIv(fromHex(wrapKeyHex), fromHex(ivHex), uk, aad)),
    },
  });

  return [
    await wrap(
      'uk-wrap/passphrase',
      'The User Key under the passphrase wrap key.',
      'ca63374a2f78dbd68a3038ce441cb0852af9d2ff4e582bac9ceadde9f95425ef',
      IV[0],
      userKeyWrapAad({ userId: ID.user, wrapKind: 'passphrase' }),
      { wrapKind: 'passphrase' },
    ),
    await wrap(
      'uk-wrap/recovery',
      'The same User Key under one recovery code, bound to that code by its lookup hash.',
      'ecb03f985be77d4632b2e388950e182ea11b8d351d26efb510766c8067982011',
      IV[1],
      userKeyWrapAad({ userId: ID.user, wrapKind: 'recovery', lookupHashHex }),
      { wrapKind: 'recovery', lookupHashHex },
    ),
    await wrap(
      'uk-wrap/prf',
      'The same User Key under a passkey PRF wrap, bound to that credential.',
      'ec2cbb6ceaec02549ba0176d7368a3aeae9ab5edbc31bee70f797c369728a0a3',
      IV[2],
      userKeyWrapAad({
        userId: ID.user,
        wrapKind: 'prf',
        credentialIdB64Url: CREDENTIAL_ID_B64URL,
      }),
      { wrapKind: 'prf', credentialIdB64Url: CREDENTIAL_ID_B64URL },
    ),
  ];
}

interface SealedBoxCase {
  id: string;
  description: string;
  purpose: 'edk-grant' | 'ehk-grant';
  recipientKind: 'member' | 'token' | 'invite';
  recipientId: string;
  recipientPrivateKeyHex: string;
  ephemeralPrivateKeyHex: string;
  ivHex: string;
  plaintextHex: string;
  edkVersion?: number;
}

async function sealedBoxVector(testCase: SealedBoxCase): Promise<Vector> {
  const recipientPrivateKey = fromHex(testCase.recipientPrivateKeyHex);
  const recipientPublicKey = encryptionPublicKey(recipientPrivateKey);
  const ephemeralPrivateKey = fromHex(testCase.ephemeralPrivateKeyHex);
  const ephemeralPublicKey = encryptionPublicKey(ephemeralPrivateKey);

  const aad =
    testCase.purpose === 'edk-grant'
      ? edkGrantAad({
          environmentId: ID.environment,
          edkVersion: testCase.edkVersion ?? 1,
          recipientKind: testCase.recipientKind,
          recipientId: testCase.recipientId,
        })
      : ehkGrantAad({
          environmentId: ID.environment,
          recipientKind: testCase.recipientKind,
          recipientId: testCase.recipientId,
        });

  const shared = x25519.getSharedSecret(ephemeralPrivateKey, recipientPublicKey);

  const salt = new Uint8Array(64);
  salt.set(ephemeralPublicKey, 0);
  salt.set(recipientPublicKey, 32);
  const derivedKey = await deriveKey({ ikm: new Uint8Array(shared), salt, info: aad });

  const blob = await sealToPublicKeyWithRandomness({
    recipientPublicKey,
    plaintext: fromHex(testCase.plaintextHex),
    aad,
    ephemeralPrivateKey,
    iv: fromHex(testCase.ivHex),
  });

  return {
    id: testCase.id,
    kind: 'sealed-box',
    description: testCase.description,
    input: {
      purpose: testCase.purpose,
      environmentId: ID.environment,
      ...(testCase.edkVersion === undefined ? {} : { edkVersion: testCase.edkVersion }),
      recipientKind: testCase.recipientKind,
      recipientId: testCase.recipientId,
      recipientPrivateKeyHex: testCase.recipientPrivateKeyHex,
      recipientPublicKeyHex: toHex(recipientPublicKey),
      ephemeralPrivateKeyHex: testCase.ephemeralPrivateKeyHex,
      ivHex: testCase.ivHex,
      plaintextHex: testCase.plaintextHex,
    },
    expected: {
      aad,
      ephemeralPublicKeyHex: toHex(ephemeralPublicKey),
      sharedSecretHex: toHex(new Uint8Array(shared)),
      derivedKeyHex: toHex(derivedKey),
      blob,
    },
  };
}

async function sealedBoxVectors(): Promise<Vector[]> {
  return [
    await sealedBoxVector({
      id: 'sealed-box/member-edk-v1',
      description: "EDK version 1 sealed to a member's X25519 public key.",
      purpose: 'edk-grant',
      edkVersion: 1,
      recipientKind: 'member',
      recipientId: ID.member,
      recipientPrivateKeyHex: KEY.memberPrivate,
      ephemeralPrivateKeyHex: EPHEMERAL[0],
      ivHex: IV[3],
      plaintextHex: KEY.edkV1,
    }),
    await sealedBoxVector({
      id: 'sealed-box/member-edk-v2',
      description:
        'The rotation pair: the same member, the same environment, EDK version 2 — a different AAD and a different blob.',
      purpose: 'edk-grant',
      edkVersion: 2,
      recipientKind: 'member',
      recipientId: ID.member,
      recipientPrivateKeyHex: KEY.memberPrivate,
      ephemeralPrivateKeyHex: EPHEMERAL[1],
      ivHex: IV[4],
      plaintextHex: KEY.edkV2,
    }),
    await sealedBoxVector({
      id: 'sealed-box/member-ehk',
      description:
        'The EHK sealed to the same member. Unversioned, and re-sealed unchanged across rotations.',
      purpose: 'ehk-grant',
      recipientKind: 'member',
      recipientId: ID.member,
      recipientPrivateKeyHex: KEY.memberPrivate,
      ephemeralPrivateKeyHex: EPHEMERAL[2],
      ivHex: IV[5],
      plaintextHex: KEY.ehk,
    }),
    await sealedBoxVector({
      id: 'sealed-box/token-edk',
      description:
        "EDK sealed to a service token's public key — the recipient kind most likely to be hard-coded to member by accident.",
      purpose: 'edk-grant',
      edkVersion: 1,
      recipientKind: 'token',
      recipientId: ID.token,
      recipientPrivateKeyHex: KEY.tokenPrivate,
      ephemeralPrivateKeyHex: EPHEMERAL[3],
      ivHex: IV[6],
      plaintextHex: KEY.edkV1,
    }),
    await sealedBoxVector({
      id: 'sealed-box/invite-edk',
      description:
        'EDK sealed to an invitation public key derived from the out-of-band key fragment.',
      purpose: 'edk-grant',
      edkVersion: 1,
      recipientKind: 'invite',
      recipientId: ID.invitation,
      recipientPrivateKeyHex: KEY.invitePrivate,
      ephemeralPrivateKeyHex: EPHEMERAL[4],
      ivHex: IV[7],
      plaintextHex: KEY.edkV1,
    }),
  ];
}

function grantSignatureVector(params: {
  id: string;
  description: string;
  edkVersion: number;
  recipientKind: 'member' | 'token' | 'invite';
  recipientId: string;
  recipientPrivateKeyHex: string;
  edkSealedBlob: string;
  ehkSealedBlob: string;
}): Vector {
  const recipientPublicKey = encryptionPublicKey(fromHex(params.recipientPrivateKeyHex));
  const fields = {
    environmentId: ID.environment,
    edkVersion: params.edkVersion,
    recipientKind: params.recipientKind,
    recipientId: params.recipientId,
    recipientPublicKey,
    edkSealedBlob: params.edkSealedBlob,
    ehkSealedBlob: params.ehkSealedBlob,
  };

  return {
    id: params.id,
    kind: 'grant-signature',
    description: params.description,
    input: {
      signerPrivateSeedHex: KEY.signerSeed,
      environmentId: ID.environment,
      edkVersion: params.edkVersion,
      recipientKind: params.recipientKind,
      recipientId: params.recipientId,
      recipientPublicKeyHex: toHex(recipientPublicKey),
      edkSealedBlob: params.edkSealedBlob,
      ehkSealedBlob: params.ehkSealedBlob,
    },
    expected: {
      signerPublicKeyHex: toHex(signingPublicKey(fromHex(KEY.signerSeed))),
      signingPayloadHex: toHex(grantSigningPayload(fields)),
      signatureBlob: signGrant({ signerPrivateSeed: fromHex(KEY.signerSeed), fields }),
    },
  };
}

function grantSignatureVectors(sealed: Record<string, string>): Vector[] {
  const ehk = sealed['sealed-box/member-ehk']!;

  return [
    grantSignatureVector({
      id: 'grant-signature/member-v1',
      description: 'A member grant at EDK version 1.',
      edkVersion: 1,
      recipientKind: 'member',
      recipientId: ID.member,
      recipientPrivateKeyHex: KEY.memberPrivate,
      edkSealedBlob: sealed['sealed-box/member-edk-v1']!,
      ehkSealedBlob: ehk,
    }),
    grantSignatureVector({
      id: 'grant-signature/member-v2',
      description:
        'The same member after a rotation: only edkVersion and the EDK blob differ, and the signature must.',
      edkVersion: 2,
      recipientKind: 'member',
      recipientId: ID.member,
      recipientPrivateKeyHex: KEY.memberPrivate,
      edkSealedBlob: sealed['sealed-box/member-edk-v2']!,
      ehkSealedBlob: ehk,
    }),
    grantSignatureVector({
      id: 'grant-signature/token',
      description:
        'A service-token grant. recipientKind is inside the signature, so a server cannot relabel it.',
      edkVersion: 1,
      recipientKind: 'token',
      recipientId: ID.token,
      recipientPrivateKeyHex: KEY.tokenPrivate,
      edkSealedBlob: sealed['sealed-box/token-edk']!,
      ehkSealedBlob: ehk,
    }),
    grantSignatureVector({
      id: 'grant-signature/invite',
      description: 'An invitation grant, signed by the inviter.',
      edkVersion: 1,
      recipientKind: 'invite',
      recipientId: ID.invitation,
      recipientPrivateKeyHex: KEY.invitePrivate,
      edkSealedBlob: sealed['sealed-box/invite-edk']!,
      ehkSealedBlob: ehk,
    }),
  ];
}

async function secretVectors(): Promise<Vector[]> {
  const edk = fromHex(KEY.edkV1);

  const build = async (params: {
    id: string;
    description: string;
    field: 'value' | 'note';
    plaintext: string;
    ivHex: string;
    version?: number;
  }): Promise<Vector> => {
    const plaintext = params.plaintext.normalize('NFC');
    const aad =
      params.field === 'note'
        ? secretNoteAad({
            orgId: ID.org,
            environmentId: ID.environment,
            secretId: ID.secret,
          })
        : secretValueAad({
            orgId: ID.org,
            environmentId: ID.environment,
            secretId: ID.secret,
            version: params.version ?? 1,
          });

    return {
      id: params.id,
      kind: 'secret-value',
      description: params.description,
      input: {
        field: params.field,
        edkHex: KEY.edkV1,
        orgId: ID.org,
        environmentId: ID.environment,
        secretId: ID.secret,
        ...(params.field === 'value' ? { version: params.version ?? 1 } : {}),
        plaintext,
        ivHex: params.ivHex,
      },
      expected: {
        aad,
        blob: formatGcmBlob(
          await encryptGcmWithIv(edk, fromHex(params.ivHex), normalizedUtf8(plaintext), aad),
        ),
      },
    };
  };

  return [
    await build({
      id: 'secret-value/value-ascii',
      description: 'A typical connection string at version 1.',
      field: 'value',
      version: 1,
      plaintext: 'postgres://app:hunter2@db.example.com:5432/app?sslmode=require',
      ivHex: IV[8],
    }),
    await build({
      id: 'secret-value/value-empty',
      description: 'The empty value: a legitimate secret, and the shortest possible ciphertext.',
      field: 'value',
      version: 2,
      plaintext: '',
      ivHex: IV[9],
    }),
    await build({
      id: 'secret-value/value-non-ascii',
      description:
        'A value carrying characters whose decomposed form differs — the case an implementation silently gets wrong.',
      field: 'value',
      version: 3,
      plaintext: DECOMPOSED_VALUE,
      ivHex: IV[10],
    }),
    await build({
      id: 'secret-value/value-max-size',
      description:
        'A plaintext of exactly MAX_SECRET_VALUE_BYTES, the largest a client may encrypt.',
      field: 'value',
      version: 4,
      plaintext: 'x'.repeat(MAX_SECRET_VALUE_BYTES),
      ivHex: IV[11],
    }),
    await build({
      id: 'secret-value/note-non-ascii',
      description: 'A note: the same construction with no version component in its AAD.',
      field: 'note',
      plaintext: DECOMPOSED_NOTE,
      ivHex: IV[0],
    }),
  ];
}

async function valueHmacVectors(): Promise<Vector[]> {
  const ehk = fromHex(KEY.ehk);
  const hmacKeyHex = toHex(await deriveKey({ ikm: ehk, info: HKDF_INFO.valueHmac }));

  const build = async (id: string, description: string, plaintext: string): Promise<Vector> => ({
    id,
    kind: 'value-hmac',
    description,
    input: { ehkHex: KEY.ehk, plaintext: plaintext.normalize('NFC') },
    expected: {
      hmacKeyHex,
      valueHmacHex: toHex(await computeValueHmac({ ehk, plaintext })),
    },
  });

  return [
    await build(
      'value-hmac/ascii',
      'The change-detection tag for a typical value. Stable across EDK rotations by construction.',
      'postgres://app:hunter2@db.example.com:5432/app?sslmode=require',
    ),
    await build('value-hmac/empty', 'The tag for an empty value.', ''),
    await build(
      'value-hmac/non-ascii',
      'The tag for a value needing NFC normalisation: two spellings must produce one tag.',
      DECOMPOSED_VALUE,
    ),
  ];
}

/**
 * A display-form string one substitution away from a valid one.
 *
 * Luhn mod 32 detects every single-character substitution, so any replacement
 * works; the assertion is here anyway, because a vector that fails to be invalid
 * would quietly stop testing anything.
 */
function substituted(displayForm: string, position: number): string {
  const characters = [...displayForm];
  const original = characters[position]!;
  const next = CROCKFORD_ALPHABET[(CROCKFORD_ALPHABET.indexOf(original) + 1) % 32]!;
  characters[position] = next;

  const candidate = characters.join('');
  if (isValidLuhnMod32(candidate.replace(/-/g, ''))) {
    throw new Error('substituted variant unexpectedly passes the check character');
  }
  return candidate;
}

/** The first adjacent transposition Luhn mod 32 actually catches, if any. */
function transposed(displayForm: string): string | undefined {
  const plain = displayForm.replace(/-/g, '');

  for (let i = 0; i < plain.length - 1; i += 1) {
    if (plain[i] === plain[i + 1]) continue;
    const swapped = plain.slice(0, i) + plain[i + 1]! + plain[i]! + plain.slice(i + 2);
    if (!isValidLuhnMod32(swapped)) {
      const groups = swapped.slice(0, 25).match(/.{5}/g) ?? [];
      return [...groups, swapped.slice(25)].join('-');
    }
  }
  return undefined;
}

async function recoveryCodeVectors(): Promise<Vector[]> {
  const build = async (
    id: string,
    description: string,
    codeBytesHex: string,
    typedInput?: string,
  ): Promise<Vector> => {
    const codeBytes = fromHex(codeBytesHex);
    const code = encodeRecoveryCode(codeBytes);

    const invalidVariants = [substituted(code.displayForm, 0), substituted(code.displayForm, 7)];
    const transposition = transposed(code.displayForm);
    if (transposition !== undefined) invalidVariants.push(transposition);

    return {
      id,
      kind: 'recovery-code',
      description,
      input: { codeBytesHex, ...(typedInput === undefined ? {} : { typedInput }) },
      expected: {
        dataChars: code.dataChars,
        checkChar: code.checkChar,
        displayForm: code.displayForm,
        lookupHashHex: toHex(await recoveryLookupHash(codeBytes)),
        rckHex: toHex(await deriveRecoveryKey(codeBytes)),
        invalidVariants,
      },
    };
  };

  const typedCode = encodeRecoveryCode(fromHex(CODE_BYTES.typed));

  return [
    await build('recovery-code/typical', 'A code from 125 bits of entropy.', CODE_BYTES.typical),
    await build(
      'recovery-code/left-padded',
      'A small 125-bit value: the base32 form is left-padded to 25 characters rather than shortened.',
      CODE_BYTES.padded,
    ),
    await build(
      'recovery-code/typed-input',
      'The same code as a user types it: lower case, no hyphens, with I/L/O standing in for 1/1/0.',
      CODE_BYTES.typed,
      typedCode.displayForm
        .replace(/-/g, '')
        .toLowerCase()
        // The first `1` becomes `i` and the rest `l`, so one string exercises
        // both aliases as well as `o` for `0`.
        .replace(/1/, 'i')
        .replace(/1/g, 'l')
        .replace(/0/g, 'o'),
    ),
  ];
}

async function blobParseVectors(): Promise<Vector[]> {
  const keyHex = KEY.uk;
  const aad = userKeyWrapAad({ userId: ID.user, wrapKind: 'passphrase' });
  const otherAad = userKeyWrapAad({
    userId: ID.user,
    wrapKind: 'prf',
    credentialIdB64Url: CREDENTIAL_ID_B64URL,
  });

  const blob = formatGcmBlob(
    await encryptGcmWithIv(fromHex(keyHex), fromHex(IV[0]), fromHex(KEY.edkV1), aad),
  );

  const payload = parseGcmBlob(blob);
  const tampered = new Uint8Array(payload.ciphertext);
  tampered[0] = tampered[0]! ^ 0x01;
  const tamperedBlob = formatGcmBlob({ iv: payload.iv, ciphertext: tampered });

  // One byte short of an IV plus a tag: there is no ciphertext there at all.
  const shortGcm = `xk2.gcm.${toBase64Url(new Uint8Array(27))}`;

  const reject = (
    id: string,
    description: string,
    input: Record<string, unknown>,
    errorClass: 'format' | 'decryption',
  ): Vector => ({
    id,
    kind: 'blob-parse',
    description,
    input,
    expected: { rejected: true, errorClass },
  });

  return [
    reject(
      'blob-parse/unknown-version',
      'A blob from a future format version. It must fail to parse rather than be misread as this one.',
      { blob: blob.replace(/^xk2\./, 'xk3.'), reason: 'unknown-version' },
      'format',
    ),
    reject(
      'blob-parse/unknown-algorithm',
      'An algorithm tag outside the registry.',
      { blob: blob.replace(/^xk2\.gcm\./, 'xk2.chacha20poly1305.'), reason: 'unknown-algorithm' },
      'format',
    ),
    reject(
      'blob-parse/payload-too-short',
      'An AES-GCM payload shorter than an IV plus a tag: there is no ciphertext there to authenticate.',
      { blob: shortGcm, reason: 'payload-too-short' },
      'format',
    ),
    reject(
      'blob-parse/sealed-box-too-short',
      'A sealed box shorter than an ephemeral public key plus an IV plus a tag.',
      { blob: `xk2.x25519.${toBase64Url(new Uint8Array(59))}`, reason: 'payload-too-short' },
      'format',
    ),
    reject(
      'blob-parse/invalid-base64url',
      'A payload containing characters outside the base64url alphabet, padding included.',
      { blob: 'xk2.gcm.AAAA====', reason: 'invalid-base64url' },
      'format',
    ),
    reject(
      'blob-parse/aad-mismatch',
      'A well-formed blob opened under a different AAD — the relocation attack AAD binding exists to defeat.',
      { blob, reason: 'aad-mismatch', keyHex, aad: otherAad },
      'decryption',
    ),
    reject(
      'blob-parse/tampered-ciphertext',
      'One flipped bit in the ciphertext.',
      { blob: tamperedBlob, reason: 'tampered-ciphertext', keyHex, aad },
      'decryption',
    ),
    reject(
      'blob-parse/wrong-key',
      'The right blob and the right AAD under the wrong key: indistinguishable from every other failure.',
      { blob, reason: 'wrong-key', keyHex: KEY.otherKey, aad },
      'decryption',
    ),
  ];
}

/* ──────────────────────────────── assembly ──────────────────────────────── */

/** Builds every vector, in file order. Deterministic: the inputs are pinned. */
export async function buildVectors(): Promise<Vector[]> {
  const sealedBox = await sealedBoxVectors();
  const sealedBlobs = Object.fromEntries(
    sealedBox.map((vector) => [vector.id, vector.expected['blob'] as string]),
  );

  const memberEdk = sealedBox.find((vector) => vector.id === 'sealed-box/member-edk-v1')!;

  const sealedBoxBranch = {
    ikmHex: memberEdk.expected['sharedSecretHex'] as string,
    saltHex:
      (memberEdk.expected['ephemeralPublicKeyHex'] as string) +
      (memberEdk.input['recipientPublicKeyHex'] as string),
    info: memberEdk.expected['aad'] as string,
  };

  return [
    ...(await argon2idVectors()),
    ...(await hkdfVectors(sealedBoxBranch)),
    ...(await ukWrapVectors()),
    ...sealedBox,
    ...grantSignatureVectors(sealedBlobs),
    ...(await secretVectors()),
    ...(await valueHmacVectors()),
    ...(await recoveryCodeVectors()),
    ...(await blobParseVectors()),
  ];
}

/** Builds the whole file, including the metadata the generator stamps. */
export async function buildVectorFile(meta: {
  generatedAt: string;
  generator: string;
}): Promise<VectorFile> {
  return {
    $schema: './e2ee-vectors.schema.json',
    specVersion: SPEC_VERSION,
    blobVersion: 'xk2',
    generatedAt: meta.generatedAt,
    generator: meta.generator,
    vectors: await buildVectors(),
  };
}
