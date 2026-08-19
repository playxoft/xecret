import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { uuidv7 } from '@xecret/core/ids';
import type { AuditAction, AuditEvent, AuditOutcome } from '@xecret/core/audit';
import { auditLogs } from '../schema/audit';
import { clampPageSize } from './shared';
import type { Executor } from './shared';

/**
 * The audit log.
 *
 * **There is no update function and no delete function in this file, and their
 * absence is the point.** `audit_logs` is append-only, enforced by migration
 * 0009: the application role holds `INSERT` and `SELECT` on this table and
 * nothing else. Adding a mutation helper here would not merely be poor taste, it
 * would be dead code that fails at runtime — and worse, it would advertise that
 * editing history is a thing the system contemplates. A log an operator can
 * quietly amend is not evidence of anything.
 *
 * The table is range-partitioned by quarter, which shapes both functions below:
 * inserts go to the current partition and are cheap, while any read that is not
 * bounded in time visits every partition that has ever existed.
 */

export type AuditLogRecord = typeof auditLogs.$inferSelect;

/**
 * The widest window a single query may scan.
 *
 * Retention outlives this by design — partitions are kept far longer — but one
 * request must not be able to ask for all of it. Ninety days covers every
 * ordinary investigation, and is one quarter, so a clamped query opens one or
 * two partitions. Anything broader is an export, which is a background job with
 * its own budget, not a page in a UI.
 */
export const MAX_AUDIT_RANGE_DAYS = 90;

const MAX_AUDIT_RANGE_MS = MAX_AUDIT_RANGE_DAYS * 24 * 60 * 60 * 1000;

/** The time span a query actually scanned, after clamping. */
export interface AuditWindow {
  from: Date;
  to: Date;
}

/**
 * Position in a result set, as the sort key of the last row returned.
 *
 * `created_at` alone is not unique — a bulk read emits several events in the
 * same transaction — so `id` breaks the tie. UUIDv7 is time-ordered, so the pair
 * sorts consistently with the intended chronological order.
 */
export interface AuditCursor {
  createdAt: Date;
  id: string;
}

export interface AuditLogFilter {
  /** Always required. There is no cross-organisation audit query. */
  orgId: string;
  actorId?: string | undefined;
  action?: AuditAction | undefined;
  projectId?: string | undefined;
  environmentId?: string | undefined;
  outcome?: AuditOutcome | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  cursor?: AuditCursor | undefined;
  pageSize?: number | undefined;
}

export interface AuditPage {
  items: AuditLogRecord[];
  /** Feed back as `filter.cursor` for the next page. `null` at the end. */
  nextCursor: AuditCursor | null;
  /**
   * The window actually scanned. Returned rather than kept private because it
   * may be narrower than what the caller asked for, and a UI that silently shows
   * ninety days when the user asked for a year is lying to them.
   */
  window: AuditWindow;
}

/**
 * Appends audit events in a single multi-row `INSERT`.
 *
 * One statement, because on the bulk read path this is the third of the three
 * queries the whole request is allowed. Callers emit one event per request — the
 * `secret.read` for an entire `xecret run` is a single record carrying a count,
 * not one record per secret — so the array is small by construction and there is
 * no chunking here to reflect a batch size that does not occur.
 *
 * An empty array is a no-op rather than an error: "record whatever happened" is
 * a reasonable thing for a caller to say when nothing did.
 */
export async function appendAuditEvents(
  exec: Executor,
  events: readonly AuditEvent[],
): Promise<void> {
  if (events.length === 0) return;

  await exec.insert(auditLogs).values(
    events.map((event) => ({
      id: uuidv7(),
      orgId: event.orgId,
      actorType: event.actorType,
      actorId: event.actorId,
      actorLabel: event.actorLabel,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      projectId: event.projectId,
      environmentId: event.environmentId,
      outcome: event.outcome,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      requestId: event.requestId,
      metadata: event.metadata,
      // `created_at` is left to the column default so the partition key comes
      // from the database's clock. A Worker clock that drifts backwards would
      // otherwise be able to file a record into the previous month's partition.
    })),
  );
}

/**
 * Reads the audit log, newest first.
 *
 * **Keyset pagination, not `OFFSET`.** Two reasons, both specific to this table:
 *
 * - `OFFSET n` makes PostgreSQL produce and discard `n` rows. On a partitioned
 *   table that means opening partitions purely to throw their contents away, and
 *   the cost grows with the page number rather than staying flat.
 * - The table is append-only and high-volume — `secret.read` fires on every CI
 *   build. Rows are constantly inserted at the newest end, which is exactly where
 *   page one starts, so an offset boundary shifts underneath a reader and the
 *   same record appears on two consecutive pages. `(created_at, id) < (…)` names
 *   a position rather than a distance and cannot drift.
 *
 * The window is always bounded, and clamped to `MAX_AUDIT_RANGE_DAYS`, so the
 * planner can prune partitions instead of scanning the entire history.
 */
export async function queryAuditLogs(exec: Executor, filter: AuditLogFilter): Promise<AuditPage> {
  const pageSize = clampPageSize(filter.pageSize);
  const window = clampAuditRange(filter, new Date());

  const conditions: SQL[] = [
    eq(auditLogs.orgId, filter.orgId),
    gte(auditLogs.createdAt, window.from),
    lte(auditLogs.createdAt, window.to),
  ];

  // Each optional filter has a matching index in ../schema/audit: actor and
  // action are both `(org_id, …, created_at DESC)`, so adding one narrows the
  // scan rather than forcing a filter over the org-wide time range.
  if (filter.actorId !== undefined) conditions.push(eq(auditLogs.actorId, filter.actorId));
  if (filter.action !== undefined) conditions.push(eq(auditLogs.action, filter.action));
  if (filter.projectId !== undefined) conditions.push(eq(auditLogs.projectId, filter.projectId));
  if (filter.environmentId !== undefined) {
    conditions.push(eq(auditLogs.environmentId, filter.environmentId));
  }
  if (filter.outcome !== undefined) conditions.push(eq(auditLogs.outcome, filter.outcome));

  if (filter.cursor !== undefined) {
    // A row-value comparison, which PostgreSQL evaluates lexicographically and
    // can satisfy from `audit_logs_org_time_idx`.
    //
    // The bounds are passed as ISO strings with explicit casts rather than as
    // `Date` objects: inside a raw fragment there is no column for the driver to
    // infer a parameter type from, and a timestamp that arrives as text and gets
    // resolved as `text` compares alphabetically, which is wrong in a way that
    // only shows up at certain times of day.
    conditions.push(
      sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${filter.cursor.createdAt.toISOString()}::timestamptz, ${filter.cursor.id}::uuid)`,
    );
  }

  const items = await exec
    .select()
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(pageSize);

  const last = items[items.length - 1];

  return {
    items,
    // A full page implies there may be more. Reading one row past the page to be
    // certain is not worth it here: the caller follows the cursor until a page
    // comes back short, and an occasional empty final page is harmless.
    nextCursor:
      last && items.length === pageSize ? { createdAt: last.createdAt, id: last.id } : null,
    window,
  };
}

/**
 * Bounds a requested date range to something a single query may scan.
 *
 * Clamped rather than rejected, because the common case is a UI defaulting to
 * "all time" and an error there is a dead end for the user. The window that was
 * actually applied comes back in `AuditPage.window` so nothing is silently
 * misrepresented.
 *
 * Exported separately from the query so the boundary arithmetic can be tested
 * without a database.
 */
export function clampAuditRange(
  range: { from?: Date | undefined; to?: Date | undefined },
  now: Date,
): AuditWindow {
  const to = range.to ?? now;
  let from = range.from ?? new Date(to.getTime() - MAX_AUDIT_RANGE_MS);

  // An inverted range is a caller bug. Collapsing it to an empty window returns
  // no rows, which is honest; guessing that the two were meant to be swapped
  // would return rows nobody asked for.
  if (from.getTime() > to.getTime()) from = to;

  if (to.getTime() - from.getTime() > MAX_AUDIT_RANGE_MS) {
    // Keep the most recent slice: someone asking for a year almost always wants
    // to start at the present and page backwards.
    from = new Date(to.getTime() - MAX_AUDIT_RANGE_MS);
  }

  return { from, to };
}
