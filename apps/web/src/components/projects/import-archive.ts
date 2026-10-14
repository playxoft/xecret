'use client';

import type { OpenedArchive, OpenedEnvironment } from '@xecret/core/vault-archive';
import {
  clientSecretIo,
  fetchEnvironmentKeys,
  modeIsAllowed,
  modePinKey,
  openEnvironmentKeys,
  readModePins,
  recordModePin,
  serverSecretIo,
} from '@/components/envkeys';
import type { SecretIo } from '@/components/envkeys';
import { readVaultKeys } from '@/components/vault/key-store';
import type { ImportPlanResponse } from '@/components/secrets/types';

/**
 * Importing a vault archive into a project (P23): the logic behind the dialog.
 *
 * ── Where the plaintext is, and where it is not ──
 * The archive is opened in this tab with the passphrase or a recovery code that
 * opened it; neither ever leaves the browser. Each target environment is then
 * written through exactly the path the dashboard's own import uses
 * (`SecretIo.runImport`): for an end-to-end-encrypted environment that path
 * encrypts every value here, under that environment's current key, before any
 * request exists — so nothing readable reaches the server. A `server`-mode
 * environment is the existing exception, as it is for every write to one: its
 * values travel to the server, which encrypts them under its own envelope.
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

/**
 * The default mapping: an archive environment goes to the environment of the
 * same slug **only** when it came from this very project in this very
 * organisation. Anything else starts as "don't import" — putting another
 * project's production values into this one's because both are called
 * `production` is a default nobody should have to notice and undo.
 */
export function defaultMapping(
  archive: OpenedArchive,
  target: { orgSlug: string; projectSlug: string; environments: readonly ProjectEnvironment[] },
): ArchiveMapping {
  const slugs = new Set(target.environments.map((environment) => environment.slug));
  const mapping: ArchiveMapping = {};
  for (const environment of archive.environments) {
    const sameProject =
      environment.orgSlug === target.orgSlug && environment.projectSlug === target.projectSlug;
    mapping[environment.environmentId] =
      sameProject && slugs.has(environment.environmentSlug) ? environment.environmentSlug : null;
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

export type IoResult =
  | { status: 'ready'; io: SecretIo }
  | { status: 'unavailable'; reason: 'locked' | 'no-key' | 'downgraded' };

/**
 * The write path for one environment of this project, exactly as the editor
 * builds it — the mode pin included. A `server` answer from an environment this
 * browser has seen as end-to-end encrypted is refused, not obeyed: an import is
 * the worst moment to be told to send plaintext (`pins.ts`).
 */
export async function ioForEnvironment(context: {
  orgSlug: string;
  orgId: string;
  projectSlug: string;
  envSlug: string;
}): Promise<IoResult> {
  const keys = await fetchEnvironmentKeys(context);

  const pin = modePinKey(context);
  if (!modeIsAllowed(readModePins(), pin, keys.encryptionMode).allowed) {
    return { status: 'unavailable', reason: 'downgraded' };
  }
  recordModePin(pin, keys.encryptionMode);

  if (keys.encryptionMode !== 'e2ee') return { status: 'ready', io: serverSecretIo(context) };

  const opened = await openEnvironmentKeys(keys, readVaultKeys());
  if (opened.status !== 'open') {
    return { status: 'unavailable', reason: opened.reason === 'locked' ? 'locked' : 'no-key' };
  }
  return { status: 'ready', io: clientSecretIo(context, opened.material) };
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
