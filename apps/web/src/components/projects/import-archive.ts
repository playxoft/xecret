'use client';

import type { OpenedArchive, OpenedEnvironment } from '@xecret/core/vault-archive';
import {
  clientSecretIo,
  fetchEnvironmentKeys,
  fetchRecipients,
  modeIsAllowed,
  modePinKey,
  openEnvironmentKeys,
  readModePins,
  recordModePin,
} from '@/components/envkeys';
import type { SecretIo } from '@/components/envkeys';
import { readVaultKeys } from '@/components/vault/key-store';
import { errorMessage } from '@/lib/api';
import type { ImportPlanResponse } from '@/components/secrets/types';

/**
 * Importing a vault archive into a project (P23): the logic behind the dialog.
 *
 * ── Where the plaintext is, and where it is not ──
 * The archive is opened in this tab with the passphrase or a recovery code that
 * opened it; neither ever leaves the browser. Each target environment is then
 * written through exactly the path the dashboard's own import uses
 * (`SecretIo.runImport`), which for an end-to-end-encrypted environment
 * encrypts every value here, under that environment's current key, before any
 * request exists — so nothing readable reaches the server.
 *
 * ── Only into end-to-end-encrypted environments ──
 * Every value in an archive came out of an `e2ee` environment: the archive is a
 * source that says "end to end", and it is pinned like one. A `server`-mode
 * target would send the values to the server readable, so it is not offered —
 * shown with its mode and refused, never confirmed past. An environment whose
 * mode this browser has seen as `e2ee` and the server now calls `server` is
 * refused as a downgrade, as everywhere (`pins.ts`).
 *
 * ── Who may write ──
 * Whatever the server says. Each import is an ordinary import request,
 * authorised per environment by the same `can()` every write goes through; a
 * refusal is reported against that environment and the others carry on.
 *
 * ── What is not imported ──
 * Values only. Notes and value types are not carried by an import request, so
 * the dialog says so rather than dropping them silently; and `no-key` or
 * `damaged` values have nothing to import.
 */

/** Where one archive environment goes: an environment slug of this project, or nowhere. */
export type ArchiveMapping = Record<string, string | null>;

export interface ProjectEnvironment {
  slug: string;
  name: string;
  encryptionMode: string;
}

/** Why a target environment cannot take an import. */
export type TargetUnavailable =
  /** This tab holds no vault keys. */
  | 'locked'
  /** The account holds no grant, and somebody else does: a teammate can share it. */
  | 'no-key'
  /** Nobody holds a grant: the key is gone for good. */
  | 'nobody-holds'
  /** The server says `server` for an environment this browser saw as `e2ee`. */
  | 'downgraded'
  /** Server-side encryption: the values would reach the server readable. */
  | 'server-mode'
  /** The environment's key state could not be read. */
  | 'failed';

/** One environment of this project, as an import target. */
export type TargetState =
  | { status: 'ready'; environmentId: string; io: SecretIo }
  | {
      status: 'unavailable';
      environmentId: string | null;
      reason: TargetUnavailable;
      /** For `failed`: the request's own message. */
      detail?: string;
    };

/**
 * The write path for one environment of this project, exactly as the editor
 * builds it — the mode pin included — or why there is none.
 */
export async function ioForEnvironment(context: {
  orgSlug: string;
  orgId: string;
  projectSlug: string;
  envSlug: string;
}): Promise<TargetState> {
  let keys: Awaited<ReturnType<typeof fetchEnvironmentKeys>>;
  try {
    keys = await fetchEnvironmentKeys(context);
  } catch (cause) {
    return {
      status: 'unavailable',
      environmentId: null,
      reason: 'failed',
      detail: errorMessage(cause),
    };
  }
  const environmentId = keys.environmentId;

  const pin = modePinKey(context);
  if (!modeIsAllowed(readModePins(), pin, keys.encryptionMode).allowed) {
    return { status: 'unavailable', environmentId, reason: 'downgraded' };
  }
  recordModePin(pin, keys.encryptionMode);

  if (keys.encryptionMode !== 'e2ee') {
    return { status: 'unavailable', environmentId, reason: 'server-mode' };
  }

  const opened = await openEnvironmentKeys(keys, readVaultKeys());
  if (opened.status === 'open') {
    return { status: 'ready', environmentId, io: clientSecretIo(context, opened.material) };
  }
  if (opened.reason === 'locked') return { status: 'unavailable', environmentId, reason: 'locked' };
  if (opened.reason === 'pending' && (await nobodyHoldsKey(context))) {
    return { status: 'unavailable', environmentId, reason: 'nobody-holds' };
  }
  return { status: 'unavailable', environmentId, reason: 'no-key' };
}

/**
 * Whether no principal holds a grant for this environment's key: a solo owner
 * after a reset, typically. Asked only when this account holds none; `false`
 * when the answer is not ours to read, so the sentence falls back to "ask a
 * teammate" rather than claiming the key is lost.
 */
async function nobodyHoldsKey(context: {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}): Promise<boolean> {
  try {
    const { recipients } = await fetchRecipients(context);
    return recipients.every((recipient) => !recipient.holdsGrant);
  } catch {
    return false;
  }
}

/** What to say about a target that cannot take an import. */
export function describeTarget(state: Extract<TargetState, { status: 'unavailable' }>): string {
  switch (state.reason) {
    case 'locked':
      return 'Unlock your vault, then try again.';
    case 'no-key':
      return 'You don’t hold this environment’s key yet — ask a teammate to share it.';
    case 'nobody-holds':
      return 'Nobody can open this environment’s key any more. Create a new environment and import into it.';
    case 'downgraded':
      return 'This environment changed its encryption mode since this browser last saw it, so nothing will be sent.';
    case 'server-mode':
      return 'Server-encrypted. An archive is imported only into an end-to-end encrypted environment, so its values never reach the server readable.';
    case 'failed':
      return state.detail ?? 'This environment could not be checked.';
  }
}

/**
 * The default mapping: an archive environment goes to the environment of this
 * project with **the same id** — the very environment it came from — and only
 * when that environment can take the import now. Anything else starts as
 * "don't import": slugs repeat across projects, and putting another project's
 * production values into this one's because both are called `production` is a
 * default nobody should have to notice and undo.
 */
export function defaultMapping(
  archive: OpenedArchive,
  targets: readonly { slug: string; state: TargetState }[],
): ArchiveMapping {
  const mapping: ArchiveMapping = {};
  for (const environment of archive.environments) {
    const same = targets.find(
      (target) =>
        target.state.status === 'ready' && target.state.environmentId === environment.environmentId,
    );
    mapping[environment.environmentId] = same?.slug ?? null;
  }
  return mapping;
}

/** Two archive environments may not be poured into one target. Returns the problem, or `null`. */
export function mappingProblem(mapping: ArchiveMapping): string | null {
  const targets = Object.values(mapping).filter((slug): slug is string => slug !== null);
  if (targets.length === 0) return 'Choose at least one environment to import into.';
  if (new Set(targets).size !== targets.length) {
    return 'Each environment of this project can receive one environment from the archive.';
  }
  return null;
}

/** An archive environment's importable values, by name: the ones that opened. */
export function importableValues(environment: OpenedEnvironment): Record<string, string> {
  const values: Record<string, string> = {};
  for (const secret of environment.secrets) {
    if (secret.outcome === 'ok' && secret.value !== null) values[secret.name] = secret.value;
  }
  return values;
}

export interface EnvironmentSummary {
  importable: number;
  noKey: number;
  damaged: number;
  notes: number;
}

export function summarise(environment: OpenedEnvironment): EnvironmentSummary {
  const summary: EnvironmentSummary = { importable: 0, noKey: 0, damaged: 0, notes: 0 };
  for (const secret of environment.secrets) {
    if (secret.outcome === 'ok') summary.importable += 1;
    else if (secret.outcome === 'no-key') summary.noKey += 1;
    else summary.damaged += 1;
    if (secret.note !== null) summary.notes += 1;
  }
  return summary;
}

/**
 * Imports one archive environment's values into one target, through the
 * ordinary import — previewed with `dryRun`, then written.
 *
 * As JSON: the values are already exact strings, and JSON is the one format
 * whose round trip through `@xecret/core/importer` is lossless for every
 * string, newlines and quotes included.
 */
export function importValues(params: {
  io: SecretIo;
  values: Record<string, string>;
  strategy: 'skip' | 'overwrite';
  dryRun: boolean;
}): Promise<ImportPlanResponse> {
  return params.io.runImport({
    content: JSON.stringify(params.values),
    filename: 'archive.json',
    format: 'json',
    strategy: params.strategy,
    dryRun: params.dryRun,
  });
}
