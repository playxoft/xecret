import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Argon2idParams } from '@xecret/core/crypto/client';
import { envDataKeys, envKeyGrants } from '../schema/env-keys';
import { environments, projects } from '../schema/resources';
import { secrets, secretVersions } from '../schema/secrets';
import { organizations } from '../schema/tenancy';
import { userKeys, userKeyWraps } from '../schema/vault';
import type { Executor } from './shared';

/**
 * The rows a vault escape archive is assembled from (spec §14.2).
 *
 * Read-only, and nothing here is readable by the server: the key row's wraps,
 * the account's member grants, and the latest ciphertext of each live secret in
 * the environments those grants open. The caller narrows the environments to
 * the ones the account may still read before any secret is loaded, and turns
 * the bytes into the archive's text forms.
 *
 * The archive covers only `e2ee` environments. A `server`-mode environment is
 * not touched by a reset — the server's own envelope still opens it — and an
 * archive of it would have to be plaintext.
 */

export interface ArchiveVaultRecord {
  createdAt: Date;
  kdfSalt: Uint8Array;
  kdfParams: Argon2idParams;
  passphraseWrap: Uint8Array;
  recoveryWraps: { lookupHash: Uint8Array; wrap: Uint8Array }[];
  encPublicKey: Uint8Array;
  encPrivateKeyEnc: Uint8Array;
}

export interface ArchiveGrantRecord {
  envDataKeyId: string;
  edkVersion: number;
  edkSealed: Uint8Array;
  ehkSealed: Uint8Array;
  environmentId: string;
  environmentName: string;
  environmentSlug: string;
  isProduction: boolean;
  projectId: string;
  projectName: string;
  projectSlug: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
}

export interface ArchiveSecretRecord {
  environmentId: string;
  secretId: string;
  name: string;
  valueType: string;
  version: number;
  envDataKeyId: string;
  ciphertext: Uint8Array;
  encNote: Uint8Array | null;
  updatedAt: Date;
}

/** The account's vault as an archive needs it, or `null` when there is none. */
export async function loadArchiveVault(
  exec: Executor,
  userId: string,
): Promise<ArchiveVaultRecord | null> {
  const [keys] = await exec
    .select({
      createdAt: userKeys.createdAt,
      kdfSalt: userKeys.kdfSalt,
      kdfParams: userKeys.kdfParams,
      encPublicKey: userKeys.encPublicKey,
      encPrivateKeyEnc: userKeys.encPrivateKeyEnc,
    })
    .from(userKeys)
    .where(eq(userKeys.userId, userId))
    .limit(1);

  if (!keys) return null;

  const wraps = await exec
    .select({
      kind: userKeyWraps.kind,
      wrap: userKeyWraps.wrap,
      lookupHash: userKeyWraps.lookupHash,
      supersededAt: userKeyWraps.supersededAt,
      usedAt: userKeyWraps.usedAt,
    })
    .from(userKeyWraps)
    .where(eq(userKeyWraps.userId, userId))
    .orderBy(asc(userKeyWraps.createdAt), asc(userKeyWraps.id));

  const passphrase = wraps.find((wrap) => wrap.kind === 'passphrase' && wrap.supersededAt === null);
  if (!passphrase) return null;

  return {
    ...keys,
    passphraseWrap: passphrase.wrap,
    recoveryWraps: wraps
      .filter(
        (wrap) => wrap.kind === 'recovery' && wrap.usedAt === null && wrap.lookupHash !== null,
      )
      .map((wrap) => ({ lookupHash: wrap.lookupHash!, wrap: wrap.wrap })),
  };
}

/**
 * Every member grant the account holds, at every key version, in a live
 * end-to-end-encrypted environment of a live project in a live organisation.
 */
export async function listArchiveGrants(
  exec: Executor,
  userId: string,
): Promise<ArchiveGrantRecord[]> {
  return exec
    .select({
      envDataKeyId: envKeyGrants.envDataKeyId,
      edkVersion: envDataKeys.version,
      edkSealed: envKeyGrants.edkSealed,
      ehkSealed: envKeyGrants.ehkSealed,
      environmentId: environments.id,
      environmentName: environments.name,
      environmentSlug: environments.slug,
      isProduction: environments.isProduction,
      projectId: projects.id,
      projectName: projects.name,
      projectSlug: projects.slug,
      orgId: organizations.id,
      orgName: organizations.name,
      orgSlug: organizations.slug,
    })
    .from(envKeyGrants)
    .innerJoin(envDataKeys, eq(envDataKeys.id, envKeyGrants.envDataKeyId))
    .innerJoin(environments, eq(environments.id, envDataKeys.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(
      and(
        eq(envKeyGrants.memberUserId, userId),
        eq(environments.encryptionMode, 'e2ee'),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
        isNull(organizations.deletedAt),
      ),
    )
    .orderBy(asc(environments.id), asc(envDataKeys.version));
}

/**
 * The latest version of every live secret in these environments, with its note.
 *
 * One `DISTINCT ON` over all of them rather than a query per environment. A
 * secret whose latest version is a `server`-mode row — an environment migrated
 * part-way — has no client ciphertext to archive and is left out by the caller,
 * which sees `envDataKeyId` null.
 */
export async function listArchiveSecrets(
  exec: Executor,
  environmentIds: readonly string[],
): Promise<ArchiveSecretRecord[]> {
  if (environmentIds.length === 0) return [];

  const rows = await exec
    .selectDistinctOn([secretVersions.secretId], {
      secretId: secrets.id,
      environmentId: secrets.environmentId,
      name: secrets.name,
      valueType: secrets.valueType,
      encNote: secrets.encNote,
      version: secretVersions.version,
      envDataKeyId: secretVersions.envDataKeyId,
      ciphertext: secretVersions.ciphertext,
      createdAt: secretVersions.createdAt,
    })
    .from(secretVersions)
    .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
    .where(and(inArray(secrets.environmentId, [...environmentIds]), isNull(secrets.deletedAt)))
    .orderBy(asc(secretVersions.secretId), desc(secretVersions.version));

  return rows
    .filter((row) => row.envDataKeyId !== null)
    .map((row) => ({
      environmentId: row.environmentId,
      secretId: row.secretId,
      name: row.name,
      valueType: row.valueType,
      version: row.version,
      envDataKeyId: row.envDataKeyId!,
      ciphertext: row.ciphertext,
      encNote: row.encNote,
      updatedAt: row.createdAt,
    }));
}
