import { can } from '@xecret/core/authz';
import { parseBlob } from '@xecret/core/crypto/client';
import { toBase64Url } from '@xecret/core/crypto';
import {
  ARCHIVE_MAX_KEYS_PER_ENVIRONMENT,
  ARCHIVE_PART_BUDGET_BYTES,
  ArchiveTooLargeError,
  encodeArchivePart,
  isArchivableSecret,
  parseArchiveDocument,
  planArchiveParts,
  serializeArchiveDocument,
  toArchiveLabel,
  toArchiveSlug,
} from '@xecret/core/vault-archive';
import type {
  ArchiveEnvironment,
  ArchiveInput,
  ArchiveSecret,
  ArchiveVault,
  VaultArchiveDocument,
} from '@xecret/core/vault-archive';
import {
  listArchiveGrants,
  listArchiveSecrets,
  loadArchiveVault,
  loadAuthorizationContext,
  measureArchiveSecrets,
  toBytes,
} from '@xecret/db/repositories';
import type { ArchiveGrantRecord, Executor } from '@xecret/db/repositories';
import { publicOrigin } from './bindings';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { describeMailFailure } from './mail';
import type { Mailer, MailMessage } from './mail';
import { toGrantContext } from './tenancy';
import { vaultArchiveMail, vaultResetNoticeMail } from './vault-archive-mail';

/**
 * The vault escape archive, server side: measured, assembled from rows this
 * server already stores, and emailed to the account's own address before its
 * vault is reset (P23; spec §14).
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
 * ── Measured first, loaded second ──
 * {@link surveyVaultArchive} reads the small things — the key row, the grants —
 * and asks the database for the *size* of the secrets, without loading one
 * ciphertext. That is what the reset screen's preflight shows, and what lets a
 * reset refuse, or go ahead without the archive when the person said so, before
 * a vault too large to email has been read into a Worker's memory. Only an
 * archive that will be sent is loaded ({@link emailVaultArchive}), each row's
 * bytes turned into text and the row dropped at once, and each part encoded and
 * sent before the next is made.
 *
 * ── Never without the archive, silently (owner decision, round 1 of PR #121) ──
 * A failed send refuses the reset: a transient provider failure is a retry, and
 * a retry must find the vault still there. A production deployment with no mail
 * provider refuses every reset. A vault too large to email — or, outside
 * production, a deployment with no mail — is shown on the reset screen before
 * anything is confirmed, and resets only when the person ticks "Reset without
 * the emailed archive". The seven-day retention applies either way.
 */

/**
 * The largest archive a reset emails, as the estimated size of its documents:
 * 8 MiB, in at most {@link ARCHIVE_EMAIL_MAX_PARTS} parts of
 * {@link ARCHIVE_PART_BUDGET_BYTES}.
 *
 * Chosen from a measurement, for a Worker's 128 MB. Building and sending an
 * archive of 8 MiB of ciphertext in Node, exactly as below — the rows released
 * as they become text, every part parsed back, then one part's ZIP, base64 and
 * request body at a time — peaks at about 70 MiB of live heap, including a
 * 14 MiB baseline (round 1 of PR #121; the peak is the second part's encoding
 * beside the plan, not the rows). That leaves well over a third of the
 * isolate, and a vault beyond the cap is never loaded at all. 8 MiB is still
 * tens of thousands of secrets.
 */
export const ARCHIVE_EMAIL_MAX_BYTES = 8 * 1024 * 1024;

/** The most parts one reset emails. Two of 5 MiB hold the 8 MiB cap with room for the plan's margins. */
export const ARCHIVE_EMAIL_MAX_PARTS = 2;

export interface ArchiveEmailLimits {
  /** The largest estimated archive that is emailed at all. */
  maxDocumentBytes: number;
  maxPartBytes: number;
  maxParts: number;
}

export const ARCHIVE_EMAIL_LIMITS: ArchiveEmailLimits = {
  maxDocumentBytes: ARCHIVE_EMAIL_MAX_BYTES,
  maxPartBytes: ARCHIVE_PART_BUDGET_BYTES,
  maxParts: ARCHIVE_EMAIL_MAX_PARTS,
};

/** Why a reset's archive cannot be emailed. */
export type ArchiveUndeliverable = 'mail-not-configured' | 'too-large';

/** What a reset would archive, sized without loading a ciphertext. */
export interface ArchiveSurvey {
  userId: string;
  vault: ArchiveVault;
  /** The vault's public key, to bind the reset to the vault that was archived. */
  encPublicKey: Uint8Array;
  /** Every environment the archive would hold, with its keys and no secrets yet. */
  environments: ArchiveEnvironment[];
  secretCount: number;
  /** An upper bound on the archive documents' size, in bytes. */
  estimatedBytes: number;
  /** `null` when the archive can be emailed. */
  undeliverable: ArchiveUndeliverable | null;
}

export type ArchiveDelivery =
  | {
      status: 'emailed';
      parts: number;
      environmentCount: number;
      secretCount: number;
      /** The public key of the vault this archive holds. */
      encPublicKey: Uint8Array;
    }
  | { status: 'not-emailed'; reason: ArchiveUndeliverable };

/* ─────────────────────────────── the estimate ─────────────────────────────── */

/**
 * The bytes an entry adds to `archive.json` besides the variable-length values
 * that are measured. Upper bounds, from the serialisation in
 * `@xecret/core/vault-archive` at its real indentation:
 *
 *  - a secret's entry is 368 bytes around its name, value and note, with a
 *    32-character value type and a ten-digit version;
 *  - a key's is under 200 around its two sealed blobs;
 *  - an environment's six names are 256 code points each, at most four bytes
 *    and — after the writer's cleaning — at most one escape each, beside three
 *    ids and three slugs;
 *  - the document's own fields, the vault's fixed fields and each recovery
 *    wrap's hash.
 *
 * Generous on purpose: the estimate decides what is promised on the reset
 * screen, and an estimate that is ever low turns into a refusal after the
 * person has re-authenticated.
 */
const SECRET_ENTRY_BYTES = 400;
const KEY_ENTRY_BYTES = 256;
const ENVIRONMENT_ENTRY_BYTES = 8 * 1024;
const DOCUMENT_BYTES = 4 * 1024;
const RECOVERY_WRAP_ENTRY_BYTES = 160;

/**
 * Everything a reset's archive would hold, and how large it would be — without
 * loading any secret. `null` when the account has no vault.
 *
 * `mailConfigured` is whether this deployment can send mail at all; a survey
 * says `mail-not-configured` before `too-large`, because no size helps then.
 */
export async function surveyVaultArchive(
  exec: Executor,
  userId: string,
  options: { mailConfigured: boolean; limits?: ArchiveEmailLimits },
): Promise<ArchiveSurvey | null> {
  const limits = options.limits ?? ARCHIVE_EMAIL_LIMITS;
  const record = await loadArchiveVault(exec, userId);
  if (record === null) return null;

  const vault: ArchiveVault = {
    createdAt: record.createdAt.toISOString(),
    kdfSaltB64Url: toBase64Url(toBytes(record.kdfSalt)),
    kdfParams: record.kdfParams,
    passphraseWrapBlob: text(record.passphraseWrap),
    recoveryWraps: record.recoveryWraps.map((wrap) => ({
      lookupHashHex: hex(wrap.lookupHash),
      wrapBlob: text(wrap.wrap),
    })),
    encPublicKeyB64Url: toBase64Url(toBytes(record.encPublicKey)),
    encPrivateKeyBlob: text(record.encPrivateKeyEnc),
  };

  const grants = (await listArchiveGrants(exec, userId)).filter(
    (grant) =>
      wellFormed(text(grant.edkSealed), 'x25519') && wellFormed(text(grant.ehkSealed), 'x25519'),
  );
  const readable = await readableEnvironments(exec, userId, grants);
  const environments = archiveEnvironments(grants.filter((g) => readable.has(g.environmentId)));

  const secrets = await measureArchiveSecrets(
    exec,
    environments.map((environment) => environment.environmentId),
  );

  const estimatedBytes =
    DOCUMENT_BYTES +
    vault.passphraseWrapBlob.length +
    vault.encPrivateKeyBlob.length +
    vault.recoveryWraps.reduce(
      (total, wrap) => total + RECOVERY_WRAP_ENTRY_BYTES + wrap.wrapBlob.length,
      0,
    ) +
    environments.reduce(
      (total, environment) =>
        total +
        ENVIRONMENT_ENTRY_BYTES +
        environment.keys.reduce(
          (sum, key) => sum + KEY_ENTRY_BYTES + key.edkSealedBlob.length + key.ehkSealedBlob.length,
          0,
        ),
      0,
    ) +
    secrets.bytes +
    secrets.count * SECRET_ENTRY_BYTES;

  return {
    userId,
    vault,
    encPublicKey: record.encPublicKey,
    environments,
    secretCount: secrets.count,
    estimatedBytes,
    undeliverable: !options.mailConfigured
      ? 'mail-not-configured'
      : estimatedBytes > limits.maxDocumentBytes
        ? 'too-large'
        : null,
  };
}

/**
 * The archive's environments, from the grants that may still be read: names
 * cleaned and slugs kept in the product's grammar so every reader accepts them
 * (§14.4), and at most the newest {@link ARCHIVE_MAX_KEYS_PER_ENVIRONMENT} key
 * versions each — the reader's own limit. A secret under an older version than
 * that opens as "no key", which is what it would be anyway.
 */
export function archiveEnvironments(grants: readonly ArchiveGrantRecord[]): ArchiveEnvironment[] {
  const environments = new Map<string, ArchiveEnvironment>();
  for (const grant of grants) {
    let environment = environments.get(grant.environmentId);
    if (environment === undefined) {
      environment = {
        orgId: grant.orgId,
        orgName: toArchiveLabel(grant.orgName),
        orgSlug: toArchiveSlug(grant.orgSlug, 'slug', grant.orgId),
        projectId: grant.projectId,
        projectName: toArchiveLabel(grant.projectName),
        projectSlug: toArchiveSlug(grant.projectSlug, 'slug', grant.projectId),
        environmentId: grant.environmentId,
        environmentName: toArchiveLabel(grant.environmentName),
        environmentSlug: toArchiveSlug(grant.environmentSlug, 'environment', grant.environmentId),
        isProduction: grant.isProduction,
        keys: [],
        secrets: [],
      };
      environments.set(grant.environmentId, environment);
    }
    // One grant per key version: a second for the same version is a row the
    // reader would refuse as a repeat, and the first already opens it.
    if (environment.keys.some((key) => key.edkVersion === grant.edkVersion)) continue;
    environment.keys.push({
      envDataKeyId: grant.envDataKeyId,
      edkVersion: grant.edkVersion,
      edkSealedBlob: text(grant.edkSealed),
      ehkSealedBlob: text(grant.ehkSealed),
    });
  }

  for (const environment of environments.values()) {
    if (environment.keys.length > ARCHIVE_MAX_KEYS_PER_ENVIRONMENT) {
      environment.keys = [...environment.keys]
        .sort((a, b) => b.edkVersion - a.edkVersion)
        .slice(0, ARCHIVE_MAX_KEYS_PER_ENVIRONMENT);
    }
  }
  return [...environments.values()];
}

/* ─────────────────────────────── the archive ─────────────────────────────── */

/**
 * The surveyed archive with its secrets: the latest value of each, loaded now.
 *
 * Each row's bytes become text the moment it is read, and the row is let go
 * before the next, so the vault's ciphertext is never held twice. Blobs that
 * fail their own format check — which the API never stores, so this is
 * corruption — and secrets with a name a reader refuses are left out rather
 * than allowed to make the whole archive unreadable; neither could be imported.
 */
export async function assembleVaultArchive(
  exec: Executor,
  survey: ArchiveSurvey,
): Promise<ArchiveInput> {
  const environments = new Map(
    survey.environments.map((environment) => [
      environment.environmentId,
      { ...environment, secrets: [] as ArchiveSecret[] },
    ]),
  );

  const rows = await listArchiveSecrets(exec, [...environments.keys()]);
  // Popped, not iterated: each row leaves the array as it is converted, so the
  // raw bytes of a row already turned into text are free to be collected.
  for (let row = rows.pop(); row !== undefined; row = rows.pop()) {
    if (!isArchivableSecret(row)) continue;
    const valueBlob = text(row.ciphertext);
    if (!wellFormed(valueBlob, 'gcm')) continue;
    const noteBlob = row.encNote === null ? null : text(row.encNote);

    environments.get(row.environmentId)?.secrets.push({
      secretId: row.secretId,
      name: row.name,
      valueType: row.valueType,
      version: row.version,
      envDataKeyId: row.envDataKeyId,
      valueBlob,
      noteBlob: noteBlob !== null && wellFormed(noteBlob, 'gcm') ? noteBlob : null,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  return { userId: survey.userId, vault: survey.vault, environments: [...environments.values()] };
}

/**
 * Builds the surveyed archive and emails it, one part per message, before a
 * reset. Called only for a survey with nothing `undeliverable`.
 *
 * Throws when the provider refuses a send — the reset must then not happen.
 * Returns `not-emailed` / `too-large` in the one case the estimate did not
 * foresee: the plan needed more parts than allowed. Nothing has been sent then.
 */
export async function emailVaultArchive(
  services: ServiceContext,
  survey: ArchiveSurvey,
  params: { email: string; now: Date; retainedUntil: Date; archiveId: string },
  mailer: Mailer,
  limits: ArchiveEmailLimits = ARCHIVE_EMAIL_LIMITS,
): Promise<ArchiveDelivery> {
  const input = await assembleVaultArchive(services.db, survey);
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
      .warn('The vault archive did not fit the parts its estimate allowed', {
        estimatedBytes: survey.estimatedBytes,
      });
    return { status: 'not-emailed', reason: 'too-large' };
  }

  // Every part read back by the reader the import screen uses, before any is
  // sent: an archive that would not open must never be mailed in place of one
  // that would, and a refusal after part one went out would leave a half.
  for (const part of parts) parseArchiveDocument(serializeArchiveDocument(part));

  // One part encoded and sent at a time, so only one part's ZIP, base64 and
  // request body are ever held at once.
  for (const part of parts) {
    await send(
      services,
      mailer,
      vaultArchiveMail({
        to: params.email,
        part: part.part,
        parts: part.parts,
        file: encodeArchivePart(part, {
          retainedUntil: params.retainedUntil,
          maxPartBytes: limits.maxPartBytes,
        }),
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
    encPublicKey: survey.encPublicKey,
  };
}

/**
 * The notice sent instead of an archive, when the person chose to reset
 * without one: the inbox still records that a reset was asked for, and the
 * seven-day window is written somewhere they will find it.
 */
export async function emailResetNotice(
  services: ServiceContext,
  mailer: Mailer,
  params: { email: string; retainedUntil: Date; reason: ArchiveUndeliverable },
): Promise<void> {
  await send(
    services,
    mailer,
    vaultResetNoticeMail({
      to: params.email,
      retainedUntil: params.retainedUntil,
      origin: publicOrigin(services.env),
    }),
  );
}

async function send(services: ServiceContext, mailer: Mailer, message: MailMessage): Promise<void> {
  try {
    await mailer.send(message);
  } catch (cause) {
    services.log
      .at('emailVaultArchive')
      .error(
        'Could not email the vault archive or notice, so the vault was not reset. The person ' +
          'can try again after re-authenticating; the provider rejected it — see status and detail.',
        describeMailFailure(cause),
      );
    throw errors.vaultArchiveNotSent('vault archive send failed');
  }
}

/* ─────────────────────────────── access ─────────────────────────────── */

/**
 * The environments among these that this account may still read, by the same
 * `can(secret.read)` every request runs. Shared with the retained-vault
 * screens, which must not show a key the account could no longer use either.
 */
export async function readableEnvironments(
  exec: Executor,
  userId: string,
  candidates: readonly {
    orgId: string;
    projectId: string;
    environmentId: string;
    isProduction: boolean;
  }[],
): Promise<Set<string>> {
  const readable = new Set<string>();
  const contexts = new Map<string, Awaited<ReturnType<typeof loadAuthorizationContext>>>();

  for (const candidate of candidates) {
    if (readable.has(candidate.environmentId)) continue;
    if (!contexts.has(candidate.orgId)) {
      contexts.set(
        candidate.orgId,
        await loadAuthorizationContext(exec, { orgId: candidate.orgId, userId }),
      );
    }
    const context = contexts.get(candidate.orgId) ?? null;
    if (context === null) continue;

    const allowed = can(
      { kind: 'user', userId, orgId: candidate.orgId },
      'secret.read',
      {
        kind: 'environment',
        orgId: candidate.orgId,
        projectId: candidate.projectId,
        environmentId: candidate.environmentId,
      },
      { membership: toGrantContext(context), isProduction: candidate.isProduction },
    ).allowed;
    if (allowed) readable.add(candidate.environmentId);
  }

  return readable;
}

/* ─────────────────────────────── text forms ─────────────────────────────── */

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
