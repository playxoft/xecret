import { can } from '@xecret/core/authz';
import { parseBlob } from '@xecret/core/crypto/client';
import { toBase64Url } from '@xecret/core/crypto';
import {
  ARCHIVE_PART_BUDGET_BYTES,
  ArchiveTooLargeError,
  encodeArchivePart,
  parseArchiveDocument,
  planArchiveParts,
  serializeArchiveDocument,
} from '@xecret/core/vault-archive';
import type {
  ArchiveEnvironment,
  ArchiveInput,
  ArchiveSecret,
  VaultArchiveDocument,
} from '@xecret/core/vault-archive';
import {
  listArchiveGrants,
  listArchiveSecrets,
  loadArchiveVault,
  loadAuthorizationContext,
  toBytes,
} from '@xecret/db/repositories';
import type { Executor } from '@xecret/db/repositories';
import { publicOrigin } from './bindings';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { describeMailFailure, mailerFrom } from './mail';
import type { Mailer } from './mail';
import { toGrantContext } from './tenancy';
import { vaultArchiveMail, vaultResetNoticeMail } from './vault-archive-mail';

/**
 * The vault escape archive, server side: assembled from rows this server
 * already stores, and emailed to the account's own address before its vault is
 * reset (P23; spec §14).
 *
 * ── What the server can and cannot do here ──
 * It can copy ciphertext. It cannot open any of it — there is no key in this
 * process that could — so the archive's "no plaintext" claim is structural on
 * this side, exactly as it is for every other route that serves a blob. What it
 * decides is *which* ciphertext: the account's own wraps and member grants, and
 * the latest value of each live secret in an end-to-end-encrypted environment
 * the account may still read.
 *
 * ── Why "may still read" is checked, not assumed ──
 * Grants are deleted when access is narrowed, but a revocation and its
 * reconciliation are separate writes; an archive must not be the one place a
 * key outlives the access it stood for. So every environment goes through the
 * same `can(secret.read)` every request does.
 *
 * ── Why the email can be refused, and when it is not ──
 * The archive is sent *before* the reset, and a failed send refuses the reset:
 * a transient provider failure is a retry, and a retry must find the vault
 * still there. Two outcomes are not failures, because retrying cannot change
 * them: a deployment with no mail provider, and a vault too large to email.
 * Both reset anyway — the old vault is retained for seven days whatever happens
 * — and the response says plainly that no archive was sent.
 */

/**
 * The most parts one reset emails. Three parts of 8 MiB is 24 MiB of
 * ciphertext — tens of thousands of secrets — held in a Worker's 128 MB beside
 * one part's zip, base64 and request body at a time. A vault beyond it resets
 * with a notice instead, and the seven-day window is how it is recovered.
 */
export const ARCHIVE_EMAIL_MAX_PARTS = 3;

export type ArchiveDelivery =
  | {
      status: 'emailed';
      parts: number;
      environmentCount: number;
      secretCount: number;
    }
  | { status: 'not-emailed'; reason: 'mail-not-configured' | 'too-large' | 'no-vault' };

/**
 * Reads everything an archive holds for this account. `null` when it has no
 * vault. Blobs that fail their own format check — which the API never stores,
 * so this is corruption — are left out rather than allowed to make the whole
 * archive unreadable; they could not be opened anyway.
 */
export async function assembleVaultArchive(
  exec: Executor,
  userId: string,
): Promise<ArchiveInput | null> {
  const vault = await loadArchiveVault(exec, userId);
  if (vault === null) return null;

  const grants = (await listArchiveGrants(exec, userId)).filter(
    (grant) =>
      wellFormed(text(grant.edkSealed), 'x25519') && wellFormed(text(grant.ehkSealed), 'x25519'),
  );

  const readable = await readableEnvironments(exec, userId, grants);

  const environments = new Map<string, ArchiveEnvironment>();
  for (const grant of grants) {
    if (!readable.has(grant.environmentId)) continue;
    let environment = environments.get(grant.environmentId);
    if (environment === undefined) {
      environment = {
        orgId: grant.orgId,
        orgName: label(grant.orgName),
        orgSlug: label(grant.orgSlug),
        projectId: grant.projectId,
        projectName: label(grant.projectName),
        projectSlug: label(grant.projectSlug),
        environmentId: grant.environmentId,
        environmentName: label(grant.environmentName),
        environmentSlug: label(grant.environmentSlug),
        isProduction: grant.isProduction,
        keys: [],
        secrets: [],
      };
      environments.set(grant.environmentId, environment);
    }
    environment.keys.push({
      envDataKeyId: grant.envDataKeyId,
      edkVersion: grant.edkVersion,
      edkSealedBlob: text(grant.edkSealed),
      ehkSealedBlob: text(grant.ehkSealed),
    });
  }

  for (const secret of await listArchiveSecrets(exec, [...environments.keys()])) {
    const valueBlob = text(secret.ciphertext);
    if (!wellFormed(valueBlob, 'gcm')) continue;
    const noteBlob = secret.encNote === null ? null : text(secret.encNote);

    const entry: ArchiveSecret = {
      secretId: secret.secretId,
      name: secret.name,
      valueType: secret.valueType,
      version: secret.version,
      envDataKeyId: secret.envDataKeyId,
      valueBlob,
      noteBlob: noteBlob !== null && wellFormed(noteBlob, 'gcm') ? noteBlob : null,
      updatedAt: secret.updatedAt.toISOString(),
    };
    environments.get(secret.environmentId)?.secrets.push(entry);
  }

  return {
    userId,
    vault: {
      createdAt: vault.createdAt.toISOString(),
      kdfSaltB64Url: toBase64Url(toBytes(vault.kdfSalt)),
      kdfParams: vault.kdfParams,
      passphraseWrapBlob: text(vault.passphraseWrap),
      recoveryWraps: vault.recoveryWraps.map((wrap) => ({
        lookupHashHex: hex(wrap.lookupHash),
        wrapBlob: text(wrap.wrap),
      })),
      encPublicKeyB64Url: toBase64Url(toBytes(vault.encPublicKey)),
      encPrivateKeyBlob: text(vault.encPrivateKeyEnc),
    },
    environments: [...environments.values()],
  };
}

/**
 * Builds the archive and emails it, one part per message, before a reset.
 *
 * Throws `unavailable` when the provider refuses a send — the reset must then
 * not happen. Returns `not-emailed` for the two outcomes a retry cannot change.
 */
export async function emailVaultArchive(
  services: ServiceContext,
  params: { userId: string; email: string; now: Date; retainedUntil: Date; archiveId: string },
  mailer: Mailer | null = mailerFrom(services.env),
  /** The size budget. Overridden only by tests, which cannot build a 24 MiB vault. */
  limits: { maxPartBytes: number; maxParts: number } = {
    maxPartBytes: ARCHIVE_PART_BUDGET_BYTES,
    maxParts: ARCHIVE_EMAIL_MAX_PARTS,
  },
): Promise<ArchiveDelivery> {
  const input = await assembleVaultArchive(services.db, params.userId);
  if (input === null) return { status: 'not-emailed', reason: 'no-vault' };

  if (mailer === null) {
    services.log
      .at('emailVaultArchive')
      .warn('No mail provider is configured, so the vault archive was not emailed');
    return { status: 'not-emailed', reason: 'mail-not-configured' };
  }

  const origin = publicOrigin(services.env);

  let parts: VaultArchiveDocument[];
  try {
    parts = planArchiveParts(input, {
      archiveId: params.archiveId,
      createdAt: params.now,
      retainedUntil: params.retainedUntil,
      maxPartBytes: limits.maxPartBytes,
      maxParts: limits.maxParts,
    });
  } catch (cause) {
    if (!(cause instanceof ArchiveTooLargeError)) throw cause;
    services.log
      .at('emailVaultArchive')
      .warn('The vault is too large to email as an archive; sending the reset notice instead');
    await send(
      services,
      mailer,
      vaultResetNoticeMail({ to: params.email, retainedUntil: params.retainedUntil, origin }),
    );
    return { status: 'not-emailed', reason: 'too-large' };
  }

  for (const part of parts) {
    // The writer's own output, read back by the reader the import screen uses.
    // An archive that would not open must never be mailed in place of one that
    // would; this is the check that it was not.
    parseArchiveDocument(serializeArchiveDocument(part));

    const file = encodeArchivePart(part, {
      retainedUntil: params.retainedUntil,
      maxPartBytes: limits.maxPartBytes,
    });
    await send(
      services,
      mailer,
      vaultArchiveMail({
        to: params.email,
        part: part.part,
        parts: part.parts,
        file,
        retainedUntil: params.retainedUntil,
        origin,
      }),
    );
  }

  return {
    status: 'emailed',
    parts: parts.length,
    environmentCount: input.environments.length,
    secretCount: input.environments.reduce(
      (total, environment) => total + environment.secrets.length,
      0,
    ),
  };
}

async function send(
  services: ServiceContext,
  mailer: Mailer,
  message: Parameters<Mailer['send']>[0],
): Promise<void> {
  try {
    await mailer.send(message);
  } catch (cause) {
    services.log
      .at('emailVaultArchive')
      .error(
        'Could not email the vault archive, so the vault was not reset. The person can try ' +
          'again; the provider rejected it — see status and detail.',
        describeMailFailure(cause),
      );
    throw errors.unavailable(
      'We could not email your vault archive, so nothing was reset. Try again in a few minutes.',
    );
  }
}

/** The environments among these grants that this account may still read. */
async function readableEnvironments(
  exec: Executor,
  userId: string,
  grants: readonly {
    orgId: string;
    projectId: string;
    environmentId: string;
    isProduction: boolean;
  }[],
): Promise<Set<string>> {
  const readable = new Set<string>();
  const contexts = new Map<string, Awaited<ReturnType<typeof loadAuthorizationContext>>>();

  for (const grant of grants) {
    if (readable.has(grant.environmentId)) continue;
    if (!contexts.has(grant.orgId)) {
      contexts.set(
        grant.orgId,
        await loadAuthorizationContext(exec, { orgId: grant.orgId, userId }),
      );
    }
    const context = contexts.get(grant.orgId) ?? null;
    if (context === null) continue;

    const allowed = can(
      { kind: 'user', userId, orgId: grant.orgId },
      'secret.read',
      {
        kind: 'environment',
        orgId: grant.orgId,
        projectId: grant.projectId,
        environmentId: grant.environmentId,
      },
      { membership: toGrantContext(context), isProduction: grant.isProduction },
    ).allowed;
    if (allowed) readable.add(grant.environmentId);
  }

  return readable;
}

const decoder = new TextDecoder();

/** A blob column holds the ASCII of an `xk2.` string. */
function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function wellFormed(blob: string, algorithm: 'gcm' | 'x25519'): boolean {
  try {
    parseBlob(blob, algorithm);
    return true;
  } catch {
    return false;
  }
}

/** Display names in an archive are 1 to 256 code points (spec §14.4). */
function label(value: string): string {
  const characters = [...value];
  if (characters.length === 0) return '-';
  return characters.length > 256 ? characters.slice(0, 256).join('') : value;
}
