/**
 * What was decided for each disabled Firebase user, kept next to the export as
 * `disabled-users-decisions.json`.
 *
 * Written by `--soft-delete-disabled --apply`, and read by every later run so
 * that a decision is made once:
 *
 *  - `--soft-delete-disabled` honours a recorded **keep** without `--keep`
 *    being repeated. Without this, the runbook's re-check after the final
 *    export would soft-delete someone the operator had decided to keep — and
 *    revoke their sessions and memberships, which clearing `deleted_at` does
 *    not bring back.
 *  - the import and the backfill report a decided user as a note ("kept,
 *    decided <date>") instead of a problem, and an undecided one as a problem.
 *
 * Holds user ids and Firebase uids, no secret. A recorded decision is changed
 * by editing this file: delete the entry, then run `--soft-delete-disabled`
 * again.
 */

export const DISABLED_DECISIONS_FORMAT = 'firebase-disabled-users-decisions/1';
export const DISABLED_DECISIONS_FILE = 'disabled-users-decisions.json';

export type DisabledDecision =
  | {
      readonly decision: 'soft-deleted';
      readonly userId: string;
      readonly decidedAt: string;
      readonly revokedSessions: number;
      readonly revokedCliTokens: number;
      /** Organisations whose membership was removed. */
      readonly removedFromOrgs: readonly string[];
    }
  /** Kept active on purpose (`--keep`): this person can sign in through WorkOS. */
  | { readonly decision: 'kept'; readonly userId: string; readonly decidedAt: string }
  /** Never signed in to xecret, so there was no row to lock. */
  | { readonly decision: 'no-row'; readonly decidedAt: string }
  /** The row was already soft-deleted when the decision was taken. */
  | { readonly decision: 'already-deleted'; readonly userId: string; readonly decidedAt: string };

export type DisabledDecisions = ReadonlyMap<string, DisabledDecision>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, uid: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Decision for ${uid} has no "${key}".`);
  }
  return value;
}

function requireCount(record: Record<string, unknown>, key: string, uid: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Decision for ${uid} has no valid "${key}".`);
  }
  return value;
}

/** Trusted whole or not at all: a damaged file must not silently drop a keep. */
export function parseDisabledDecisions(json: unknown): DisabledDecisions {
  if (!isRecord(json) || json['format'] !== DISABLED_DECISIONS_FORMAT) {
    throw new Error(
      `Not a disabled-users decisions file (expected "${DISABLED_DECISIONS_FORMAT}").`,
    );
  }
  const entries = json['entries'];
  if (!isRecord(entries)) throw new Error('Decisions file has no "entries" object.');
  const decisions = new Map<string, DisabledDecision>();
  for (const [uid, raw] of Object.entries(entries)) {
    if (!isRecord(raw)) throw new Error(`Decision for ${uid} is malformed.`);
    const decidedAt = requireString(raw, 'decidedAt', uid);
    switch (raw['decision']) {
      case 'soft-deleted': {
        const orgs = raw['removedFromOrgs'];
        if (!Array.isArray(orgs) || !orgs.every((o) => typeof o === 'string')) {
          throw new Error(`Decision for ${uid} has no valid "removedFromOrgs".`);
        }
        decisions.set(uid, {
          decision: 'soft-deleted',
          userId: requireString(raw, 'userId', uid),
          decidedAt,
          revokedSessions: requireCount(raw, 'revokedSessions', uid),
          revokedCliTokens: requireCount(raw, 'revokedCliTokens', uid),
          removedFromOrgs: orgs,
        });
        break;
      }
      case 'kept':
      case 'already-deleted':
        decisions.set(uid, {
          decision: raw['decision'],
          userId: requireString(raw, 'userId', uid),
          decidedAt,
        });
        break;
      case 'no-row':
        decisions.set(uid, { decision: 'no-row', decidedAt });
        break;
      default:
        throw new Error(`Decision for ${uid} has an unknown "decision".`);
    }
  }
  return decisions;
}

export function serializeDisabledDecisions(decisions: DisabledDecisions): unknown {
  const entries: Record<string, DisabledDecision> = {};
  for (const uid of [...decisions.keys()].sort()) {
    const decision = decisions.get(uid);
    if (decision) entries[uid] = decision;
  }
  return { format: DISABLED_DECISIONS_FORMAT, entries };
}

/** The uids decided `kept`. */
export function keptUids(decisions: DisabledDecisions): Set<string> {
  return new Set([...decisions].filter(([, d]) => d.decision === 'kept').map(([uid]) => uid));
}

/** One line for a report: what was decided, and when. */
export function describeDecision(decision: DisabledDecision): string {
  const date = decision.decidedAt.slice(0, 10);
  switch (decision.decision) {
    case 'soft-deleted':
      return `soft-deleted (decided ${date})`;
    case 'kept':
      return `kept active on purpose (decided ${date})`;
    case 'no-row':
      return `no xecret row, nothing to lock (decided ${date})`;
    case 'already-deleted':
      return `row was already soft-deleted (decided ${date})`;
  }
}
