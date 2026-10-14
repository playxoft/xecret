import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DecryptionError,
  derivePassphraseWrapKey,
  deriveRecoveryKey,
  deriveStretchedKey,
  deriveUkUnlockVerifier,
  generateEncryptionKeyPair,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  generateKdfSalt,
  generateRecoveryCodes,
  generateSigningKeyPair,
  generateUserKey,
  nobleArgon2idProvider,
  openGrant,
  recoveryLookupHash,
  RecoveryCodeError,
  sealGrant,
  toBase64Url,
  toHex,
  verifyGrantSignature,
  wrapPrivateKey,
  wrapUserKey,
} from '@xecret/core/crypto/client';
import type { Argon2idParams, Bytes } from '@xecret/core/crypto/client';
import type { VaultKeyMaterial } from './key-store';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('./argon2', () => ({ argon2idProvider: nobleArgon2idProvider }));

const { buildRestore, describeSkips, openRetainedUserKey } = await import('./retained-vaults');
const { describeRecoverFailure } = await import('./retained-vaults-card');
const { ArchivePreflightFacts, ResetResult } = await import('./vault-unlock');
import type { RetainedVaultMaterial } from './retained-vaults';

/**
 * Recovering a reset vault, from the browser's side, with real cryptography and
 * no network: the old vault opens with its passphrase or a code, every key it
 * held is re-sealed to the *current* vault and signed by it, and the proof the
 * server checks is the one only the old User Key can produce.
 */

const KDF: Argon2idParams = { alg: 'argon2id', v: 19, m: 19456, t: 1, p: 1, len: 32 };
const USER = '0192f0a1-7c3d-7e4f-8a1b-2c3d4e5f6a7b';
const ENVIRONMENT = '0192f0a1-0000-7000-8000-00000000c001';

async function oldVault(passphrase: string) {
  const userKey = generateUserKey();
  const enc = generateEncryptionKeyPair();
  const salt = generateKdfSalt();
  const wrapKey = await derivePassphraseWrapKey(
    await deriveStretchedKey({ passphrase, salt, params: KDF }),
  );
  const [code] = generateRecoveryCodes(1);
  const lookupHash = await recoveryLookupHash(code!.codeBytes);
  const recoveryWrap = await wrapUserKey({
    wrapKey: await deriveRecoveryKey(code!.codeBytes),
    userKey,
    context: { userId: USER, wrapKind: 'recovery', lookupHash },
  });
  const edk = generateEnvironmentDataKey();
  const ehk = generateEnvironmentHmacKey();
  const recipient = {
    environmentId: ENVIRONMENT,
    edkVersion: 2,
    recipientKind: 'member' as const,
    recipientId: USER,
  };
  const sealed = await sealGrant({
    recipient: { ...recipient, recipientPublicKey: enc.publicKey },
    edk,
    ehk,
  });

  const material: RetainedVaultMaterial = {
    id: 'retained-1',
    userId: USER,
    retainedAt: '2026-10-12T09:30:00.000Z',
    retainedUntil: '2026-10-19T09:30:00.000Z',
    recoveredAt: null,
    grantCount: 1,
    recoveryCodesRemaining: 1,
    encPublicKey: toBase64Url(enc.publicKey),
    encPrivateKeyEnc: await wrapPrivateKey({
      userKey,
      privateKey: enc.privateKey,
      userId: USER,
      purpose: 'encryption',
    }),
    kdfSalt: toBase64Url(salt),
    kdfParams: KDF,
    passphraseWrap: await wrapUserKey({
      wrapKey,
      userKey,
      context: { userId: USER, wrapKind: 'passphrase' },
    }),
    grants: [
      {
        envDataKeyId: 'edk-2',
        edkVersion: 2,
        edkStatus: 'active',
        environmentId: ENVIRONMENT,
        environmentName: 'Production',
        environmentSlug: 'production',
        isProduction: true,
        projectName: 'API',
        projectSlug: 'api',
        orgId: 'org-1',
        orgName: 'Acme',
        orgSlug: 'acme',
        edkSealed: sealed.edkSealed,
        ehkSealed: sealed.ehkSealed,
      },
    ],
  };
  return { material, userKey, edk, ehk, code: code!, recoveryWrap, recipient };
}

function currentVault(): VaultKeyMaterial {
  const enc = generateEncryptionKeyPair();
  const sign = generateSigningKeyPair();
  return {
    userId: USER,
    userKey: generateUserKey(),
    encPrivateKey: enc.privateKey,
    encPublicKey: enc.publicKey,
    signPrivateKey: sign.privateKey,
    signPublicKey: sign.publicKey,
  };
}

describe('opening a retained vault', () => {
  it('opens with its passphrase, NFC-normalised like every other', async () => {
    const old = await oldVault('Café passphrase');
    const userKey = await openRetainedUserKey({
      material: old.material,
      credential: { kind: 'passphrase', passphrase: 'Café passphrase' },
    });
    expect(toHex(userKey)).toBe(toHex(old.userKey));
  });

  it('opens with a recovery code, asking for its wrap by lookup hash only', async () => {
    const old = await oldVault('irrelevant');
    const asked: Bytes[] = [];
    const userKey = await openRetainedUserKey({
      material: old.material,
      credential: { kind: 'recovery-code', code: old.code },
      recoveryWrap: async (hash) => {
        asked.push(hash);
        return old.recoveryWrap;
      },
    });
    expect(toHex(userKey)).toBe(toHex(old.userKey));
    expect(asked.map(toHex)).toEqual([toHex(await recoveryLookupHash(old.code.codeBytes))]);
  });

  it('refuses a wrong passphrase uniformly', async () => {
    const old = await oldVault('right');
    await expect(
      openRetainedUserKey({
        material: old.material,
        credential: { kind: 'passphrase', passphrase: 'wrong' },
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe('building the restore', () => {
  it('re-seals every key to the current vault, signed by it, with the old User Key as proof', async () => {
    const old = await oldVault('right');
    const current = currentVault();
    const oldUserKey = old.userKey.slice();

    const body = await buildRestore({ material: old.material, oldUserKey, current });

    expect(body.ukUnlockVerifier).toBe(toBase64Url(await deriveUkUnlockVerifier(old.userKey)));
    expect(body.grants).toHaveLength(1);
    const [grant] = body.grants;
    expect(grant!.recipientPublicKey).toBe(toBase64Url(current.encPublicKey));

    // Opens with the current vault's private key to the very same keys.
    const opened = await openGrant({
      recipient: old.recipient,
      recipientPrivateKey: current.encPrivateKey,
      grant: { edkSealed: grant!.edkSealed, ehkSealed: grant!.ehkSealed },
    });
    expect(toHex(opened.edk)).toBe(toHex(old.edk));
    expect(toHex(opened.ehk)).toBe(toHex(old.ehk));

    // And verifies against the current vault's signing key.
    expect(
      verifyGrantSignature({
        signerPublicKey: current.signPublicKey,
        signature: grant!.signature,
        fields: {
          ...old.recipient,
          recipientPublicKey: current.encPublicKey,
          edkSealedBlob: grant!.edkSealed,
          ehkSealedBlob: grant!.ehkSealed,
        },
      }),
    ).toBe(true);

    // The old User Key it was handed is gone.
    expect(oldUserKey.every((byte) => byte === 0)).toBe(true);
  });

  it('wipes the old User Key even when a grant will not open', async () => {
    const old = await oldVault('right');
    const oldUserKey = old.userKey.slice();
    const broken = {
      ...old.material,
      grants: [{ ...old.material.grants[0]!, edkVersion: 3 }],
    };

    await expect(
      buildRestore({ material: broken, oldUserKey, current: currentVault() }),
    ).rejects.toBeInstanceOf(DecryptionError);
    expect(oldUserKey.every((byte) => byte === 0)).toBe(true);
  });
});

describe('what a recovery says', () => {
  it('names each kind of skip', () => {
    expect(
      describeSkips([
        { envDataKeyId: 'a', reason: 'already-held' },
        { envDataKeyId: 'b', reason: 'already-held' },
        { envDataKeyId: 'c', reason: 'no-access' },
        { envDataKeyId: 'd', reason: 'environment-gone' },
      ]),
    ).toEqual([
      '2 you already had again — a teammate re-shared them.',
      '1 you no longer have access to, so they were not restored.',
      '1 belonged to environments deleted since the reset.',
    ]);
    expect(describeSkips([])).toEqual([]);
  });

  it('tells a typo from a wrong credential', () => {
    expect(describeRecoverFailure(new DecryptionError(), 'passphrase')).toMatch(
      /passphrase did not open/,
    );
    expect(describeRecoverFailure(new DecryptionError(), 'recovery-code')).toMatch(
      /code did not open/,
    );
    expect(describeRecoverFailure(new RecoveryCodeError('checksum'), 'recovery-code')).toMatch(
      /typo/,
    );
  });
});

describe('the reset result', () => {
  const retained = { id: 'r', retainedUntil: '2026-10-19T09:30:00.000Z', grantCount: 3 };
  const vault = { configured: false, unlocked: false, unlockedUntil: null, autoLockMinutes: 15 };

  it('says where the archive went, warns about it, and until when recovery works', () => {
    const html = renderToStaticMarkup(
      createElement(ResetResult, {
        result: { vault, archive: { emailed: true, parts: 2, to: 'owner@example.com' }, retained },
        onContinue: () => {},
      }),
    );
    expect(html).toContain('2 archive files');
    expect(html).toContain('owner@example.com');
    expect(html).toContain('guess your passphrase offline');
    expect(html).toContain('Settings → Security');
    expect(html).toContain('Set up my new vault');
  });

  it('says plainly when no archive was sent, and why', () => {
    for (const [reason, sentence] of [
      ['too-large', 'too large to email'],
      ['mail-not-configured', 'no email set up'],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(ResetResult, {
          result: { vault, archive: { emailed: false, reason }, retained },
          onContinue: () => {},
        }),
      );
      expect(html).toContain('No archive was emailed');
      expect(html).toContain('As you chose');
      expect(html).toContain(sentence);
      expect(html).toContain('still kept for seven days');
    }
  });

  it('never claims more than xecret can promise about deletion', () => {
    const html = renderToStaticMarkup(
      createElement(ResetResult, {
        result: { vault, archive: { emailed: true, parts: 1, to: 'owner@example.com' }, retained },
        onContinue: () => {},
      }),
    );
    expect(html).toContain('Nothing in xecret can delete it');
    expect(html).not.toMatch(/Nobody can delete/);
  });
});

describe('what the reset screen says about the archive before anything is confirmed', () => {
  const render = (props: Partial<Parameters<typeof ArchivePreflightFacts>[0]>) =>
    renderToStaticMarkup(
      createElement(ArchivePreflightFacts, {
        preflight: null,
        failure: null,
        withoutArchive: false,
        onWithoutArchive: () => {},
        onRetry: () => {},
        ...props,
      }),
    );
  const archive = {
    deliverable: true,
    reason: null,
    estimatedBytes: 40_000,
    maxBytes: 8 * 1024 * 1024,
    environmentCount: 2,
    secretCount: 9,
  };

  it('promises the emailed archive only when it can be emailed', () => {
    const html = render({ preflight: { resettable: true, archive } });
    expect(html).toContain('Before we reset, we email you an archive');
    expect(html).not.toContain('Reset without the emailed archive');
  });

  it('states a vault too large to email, with its size, and asks for the choice', () => {
    const html = render({
      preflight: {
        resettable: true,
        archive: {
          ...archive,
          deliverable: false,
          reason: 'too-large',
          estimatedBytes: 9 * 1024 * 1024,
        },
      },
    });
    expect(html).toContain('Your vault is too large to email');
    expect(html).toContain('about 9.0 MB, more than the 8.0 MB we can email');
    expect(html).toContain('Reset without the emailed archive');
    expect(html).not.toContain('Before we reset, we email you an archive');
  });

  it('asks for the same choice where no mail is set up outside production', () => {
    const html = render({
      preflight: {
        resettable: true,
        archive: { ...archive, deliverable: false, reason: 'mail-not-configured' },
      },
    });
    expect(html).toContain('no email set up');
    expect(html).toContain('Reset without the emailed archive');
  });

  it('offers nothing to choose where nothing can be reset', () => {
    const html = render({
      preflight: {
        resettable: false,
        archive: { ...archive, deliverable: false, reason: 'mail-not-configured' },
      },
    });
    expect(html).toContain('can’t be reset right now');
    expect(html).not.toContain('Reset without the emailed archive');
  });

  it('says it is still checking, and offers a retry when the check failed', () => {
    expect(render({})).toContain('Checking whether your archive can be emailed');
    expect(render({ failure: 'Network down.' })).toContain('Try again');
  });
});
