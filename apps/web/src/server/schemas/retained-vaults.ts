import * as z from 'zod/mini';
import { toBase64Url } from '@xecret/core/crypto';
import { toBytes } from '@xecret/db/repositories';
import type {
  RetainedGrantRecord,
  RetainedVaultMaterial,
  RetainedVaultSummary,
} from '@xecret/db/repositories';
import { publicKeySchema, sealedBlobSchema, signatureSchema } from './env-keys';
import { uuidField } from './ids';
import { decodeBlob, lookupHashSchema, ukUnlockVerifierSchema } from './vault';

/**
 * The shapes of the retained-vault endpoints (P23): listing a reset vault,
 * fetching what the browser needs to open it, one recovery wrap by lookup hash,
 * and the restore that writes its keys into the current vault.
 *
 * Every value here is a public key, a parameter set, or a blob this server has
 * no key for — the same property `schemas/vault.ts` has for the live vault.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

/** The most grants one restore may carry: a vault's grants across every key version. */
export const MAX_RESTORED_GRANTS = 2000;

export const retainedRecoveryWrapSchema = z.strictObject(
  { lookupHash: lookupHashSchema },
  UNEXPECTED_FIELD,
);

/**
 * One key of the retained vault, re-sealed by the browser to the current vault.
 *
 * No `recipientKind` and no `recipientId`: a restore writes member grants to the
 * caller and to nobody else, so neither is the client's to choose. The server
 * fills both in — the caller, as a member — and they are what the browser signed.
 */
export const restoredGrantSchema = z.strictObject(
  {
    envDataKeyId: uuidField('A key is named by a UUID.'),
    recipientPublicKey: publicKeySchema,
    edkSealed: sealedBlobSchema,
    ehkSealed: sealedBlobSchema,
    signature: signatureSchema,
  },
  UNEXPECTED_FIELD,
);

export const retainedRestoreSchema = z.strictObject(
  {
    /**
     * `HKDF(oldUK, "xecret.v2.uk-unlock-verifier")` — the proof that whoever is
     * restoring opened the retained vault's User Key, with its passphrase or one
     * of its recovery codes. Compared against the digest the vault was set up
     * with, under the retained vault's own lockout.
     */
    ukUnlockVerifier: ukUnlockVerifierSchema,
    grants: z
      .array(restoredGrantSchema)
      .check(z.maxLength(MAX_RESTORED_GRANTS, 'Too many grants in one restore.')),
  },
  UNEXPECTED_FIELD,
);

export type RetainedRestoreRequest = z.infer<typeof retainedRestoreSchema>;

export interface RetainedVaultPayload {
  id: string;
  retainedAt: string;
  /** When the scheduled purge may delete it. Recoverable and undeletable until then. */
  retainedUntil: string;
  recoveredAt: string | null;
  /** Key versions held; `environmentCount` is what the screens show. */
  grantCount: number;
  environmentCount: number;
  recoveryCodesRemaining: number;
}

export interface RetainedGrantPayload {
  envDataKeyId: string;
  edkVersion: number;
  /** `active` or `retired`. */
  edkStatus: string;
  environmentId: string;
  environmentName: string;
  environmentSlug: string;
  isProduction: boolean;
  projectName: string;
  projectSlug: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  edkSealed: string;
  ehkSealed: string;
}

export interface RetainedVaultMaterialPayload extends RetainedVaultPayload {
  userId: string;
  encPublicKey: string;
  encPrivateKeyEnc: string;
  kdfSalt: string;
  kdfParams: unknown;
  passphraseWrap: string;
  grants: RetainedGrantPayload[];
}

export function toRetainedVault(vault: RetainedVaultSummary): RetainedVaultPayload {
  return {
    id: vault.id,
    retainedAt: vault.retainedAt.toISOString(),
    retainedUntil: vault.purgeAfter.toISOString(),
    recoveredAt: vault.recoveredAt?.toISOString() ?? null,
    grantCount: vault.grantCount,
    environmentCount: vault.environmentCount,
    recoveryCodesRemaining: vault.recoveryCodesRemaining,
  };
}

function toRetainedGrant(grant: RetainedGrantRecord): RetainedGrantPayload {
  return {
    envDataKeyId: grant.envDataKeyId,
    edkVersion: grant.edkVersion,
    edkStatus: grant.edkStatus,
    environmentId: grant.environmentId,
    environmentName: grant.environmentName,
    environmentSlug: grant.environmentSlug,
    isProduction: grant.isProduction,
    projectName: grant.projectName,
    projectSlug: grant.projectSlug,
    orgId: grant.orgId,
    orgName: grant.orgName,
    orgSlug: grant.orgSlug,
    edkSealed: decodeBlob(grant.edkSealed),
    ehkSealed: decodeBlob(grant.ehkSealed),
  };
}

/**
 * Everything the browser needs to open a retained vault — and deliberately not
 * its recovery wraps, which are served one at a time by lookup hash, exactly as
 * the live vault's are.
 */
export function toRetainedVaultMaterial(
  vault: RetainedVaultMaterial,
): RetainedVaultMaterialPayload {
  return {
    ...toRetainedVault(vault),
    userId: vault.userId,
    encPublicKey: toBase64Url(toBytes(vault.encPublicKey)),
    encPrivateKeyEnc: decodeBlob(vault.encPrivateKeyEnc),
    kdfSalt: toBase64Url(toBytes(vault.kdfSalt)),
    kdfParams: vault.kdfParams,
    passphraseWrap: decodeBlob(vault.passphraseWrap),
    grants: vault.grants.map(toRetainedGrant),
  };
}
