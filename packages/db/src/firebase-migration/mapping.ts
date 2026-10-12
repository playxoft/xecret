import { WORKOS_USER_ID_PATTERN } from '@xecret/core/auth';

/**
 * The `firebase_uid → workos_user_id` mapping the import writes and the
 * backfill reads.
 *
 * It is bound to one WorkOS environment — by name and by the application's
 * client id, which (unlike an API key) identifies the environment. The xecret Development and
 * Production configurations share one database, so a Staging id written into
 * `users.workos_user_id` would sit exactly where the Production id belongs:
 * the real Production sign-in then finds the row linked to someone else (a
 * `conflict`), and the backfill — which only fills NULLs — can no longer fix
 * it. The environment is recorded here, checked on every read, and checked
 * again against the API key in use.
 *
 * Holds no secret, but it lives next to the export (which does) and outside
 * the repository, with it.
 */

export type MigrationEnvironment = 'staging' | 'production';

export const MAPPING_FORMAT = 'firebase-workos-user-mapping/1';

export type MappingOutcome = 'created' | 'already-imported' | 'reuse-existing';

export interface MappingEntry {
  readonly workosUserId: string;
  readonly outcome: MappingOutcome;
  /** Whether a password hash went with it. Null when a re-run found a user it cannot tell about. */
  readonly passwordImported: boolean | null;
  readonly recordedAt: string;
}

export interface UserMapping {
  readonly environment: MigrationEnvironment;
  /** The WorkOS client (`client_…`) of the environment the ids live in. */
  readonly clientId: string;
  /** Keyed by Firebase uid. */
  readonly entries: ReadonlyMap<string, MappingEntry>;
}

const OUTCOMES: readonly MappingOutcome[] = ['created', 'already-imported', 'reuse-existing'];

export const WORKOS_CLIENT_ID_PATTERN = /^client_[0-9A-Za-z]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptyUserMapping(environment: MigrationEnvironment, clientId: string): UserMapping {
  if (!WORKOS_CLIENT_ID_PATTERN.test(clientId)) throw new Error('Not a WorkOS client id.');
  return { environment, clientId, entries: new Map() };
}

/** Refuses two uids mapped to one WorkOS user: the backfill would hand one account to both. */
function assertOneUidPerUser(entries: ReadonlyMap<string, MappingEntry>) {
  const owners = new Map<string, string>();
  for (const [uid, entry] of entries) {
    const other = owners.get(entry.workosUserId);
    if (other !== undefined) {
      throw new Error(
        `Mapping is inconsistent: ${entry.workosUserId} is mapped from both ${other} and ${uid}.`,
      );
    }
    owners.set(entry.workosUserId, uid);
  }
}

/**
 * Reads a mapping file. Any damage throws: a mapping decides which account
 * every imported person lands in, so it is trusted whole or not at all.
 */
export function parseUserMapping(json: unknown): UserMapping {
  if (!isRecord(json) || json['format'] !== MAPPING_FORMAT) {
    throw new Error(`Not a user mapping file (expected format "${MAPPING_FORMAT}").`);
  }
  const environment = json['environment'];
  if (environment !== 'staging' && environment !== 'production') {
    throw new Error('Mapping file has no valid "environment".');
  }
  const clientId = json['clientId'];
  if (typeof clientId !== 'string' || !WORKOS_CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error('Mapping file has no valid "clientId".');
  }
  const rawEntries = json['entries'];
  if (!isRecord(rawEntries)) throw new Error('Mapping file has no "entries" object.');
  const entries = new Map<string, MappingEntry>();
  for (const [uid, raw] of Object.entries(rawEntries)) {
    if (uid === '' || !isRecord(raw)) throw new Error(`Mapping entry "${uid}" is malformed.`);
    const { workosUserId, outcome, passwordImported, recordedAt } = raw;
    if (typeof workosUserId !== 'string' || !WORKOS_USER_ID_PATTERN.test(workosUserId)) {
      throw new Error(`Mapping entry ${uid} does not hold a WorkOS user id.`);
    }
    if (!OUTCOMES.includes(outcome as MappingOutcome)) {
      throw new Error(`Mapping entry ${uid} has an unknown outcome.`);
    }
    if (passwordImported !== null && typeof passwordImported !== 'boolean') {
      throw new Error(`Mapping entry ${uid} has a malformed "passwordImported".`);
    }
    if (typeof recordedAt !== 'string') {
      throw new Error(`Mapping entry ${uid} has no "recordedAt".`);
    }
    entries.set(uid, {
      workosUserId,
      outcome: outcome as MappingOutcome,
      passwordImported,
      recordedAt,
    });
  }
  assertOneUidPerUser(entries);
  return { environment, clientId, entries };
}

export function serializeUserMapping(mapping: UserMapping, updatedAt: string): unknown {
  const entries: Record<string, MappingEntry> = {};
  for (const uid of [...mapping.entries.keys()].sort()) {
    const entry = mapping.entries.get(uid);
    if (entry) entries[uid] = entry;
  }
  return {
    format: MAPPING_FORMAT,
    environment: mapping.environment,
    clientId: mapping.clientId,
    updatedAt,
    entries,
  };
}

/**
 * The mapping with `uid` recorded.
 *
 * A re-run that finds the same user again changes nothing: the entry keeps
 * the outcome, time and password knowledge of the run that first recorded it
 * (a re-run sees a `created` user as merely `already-imported`, and cannot
 * tell whether it has a password). A *different* id replaces the entry — the
 * newer run saw WorkOS as it is now — and the backfill then reports any row
 * already linked to the old one rather than moving it.
 */
export function withMappingEntry(
  mapping: UserMapping,
  uid: string,
  entry: MappingEntry,
): UserMapping {
  const previous = mapping.entries.get(uid);
  const merged: MappingEntry =
    previous && previous.workosUserId === entry.workosUserId
      ? { ...previous, passwordImported: previous.passwordImported ?? entry.passwordImported }
      : entry;
  const entries = new Map(mapping.entries);
  entries.set(uid, merged);
  assertOneUidPerUser(entries);
  return { environment: mapping.environment, clientId: mapping.clientId, entries };
}
