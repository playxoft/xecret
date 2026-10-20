import { FETCHES_PER_METERED_UNIT, meteredUnitsOwed } from '@xecret/core/entitlements';
import {
  addFetchCounts,
  appendAuditEvents,
  entitlementsFromRow,
  listMeterableUsage,
  markMeteredUnitsSent,
} from '@xecret/db/repositories';
import type { ServiceContext } from '../context';
import { describeError } from '../logging';
import { subscriptionResource, systemAudit } from './audit';
import { billingProvider, DodoApiError } from './client';
import type { UsageEvent } from './client';
import { billingSetup } from './config';

/**
 * Usage metering (P12): counting secret fetches without writing on the fetch
 * path, and reporting the overage to Dodo exactly once.
 *
 * ── Counting: in the isolate, flushed off the response ──
 * The plan left the choice open between accumulating in the Worker and a
 * Durable Object counter per organisation. **In the isolate**, for three
 * reasons:
 *
 *  1. **Zero cost on the response path.** `countSecretFetch` is a map
 *     increment. The flush is an `INSERT … ON CONFLICT … + n` from
 *     `waitUntil`, after the response has gone, once per isolate per
 *     {@link FLUSH_INTERVAL_MS} or {@link FLUSH_AT_COUNT} fetches — not once
 *     per fetch. A Durable Object would put a subrequest on every fetch, and an
 *     outage of it next to the one path that must never depend on anything.
 *  2. **No new infrastructure.** No Durable Object class, no migration of the
 *     Worker's bindings, nothing for a self-hoster to provision.
 *  3. **Its one failure is in the customer's favour.** An isolate evicted
 *     between flushes loses its last few seconds of counts. Nothing can make
 *     it count a fetch twice: a flush takes its snapshot and clears the map in
 *     one synchronous step, and a flush that fails is dropped rather than
 *     retried — a retry after a write that did land but reported failure would
 *     be the one way to over-count. Under-counting by a handful of fetches in
 *     a million is the honest price; over-billing by any is not.
 *
 * The counter holds organisation ids and integers and nothing else — no
 * request object, no database handle, nothing that is I/O. workerd forbids
 * sharing those across requests; plain numbers are what it allows.
 *
 * ── Reporting: one event per thousand fetches past the allowance ──
 * The hourly job (`flushUsageToDodo`) reads each billed organisation's counter
 * for its period — **our count, written first, is the dispute record** — and
 * computes `floor((fetches − included) / 1000) − units already reported`. Each
 * new unit is one Dodo event with a **deterministic id**,
 * `${orgId}:${periodStart}:${unitIndex}`, so a retry, a crashed run or two
 * runs racing report the same ids and Dodo ignores the repeats. Units are
 * recorded as reported only after Dodo accepted them, with `GREATEST`, so the
 * record can only move forward and never past what was sent.
 *
 * The included allowance is subtracted *here*, from `plans.ts` with any support
 * override — so Dodo's meter must carry no free threshold of its own, or the
 * allowance is given twice (docs/operations/billing.md).
 */

/** Flush an isolate's counts at most this often. */
export const FLUSH_INTERVAL_MS = 15_000;
/** …or as soon as this many fetches are waiting, whichever comes first. */
export const FLUSH_AT_COUNT = 50;
/** Bound the map, so an isolate serving thousands of organisations stays small. */
const MAX_TRACKED_ORGS = 1_000;

interface CounterState {
  counts: Map<string, number>;
  pending: number;
  lastFlushAt: number;
}

const STATE = Symbol.for('xecret.secret-fetch-counter');

function state(): CounterState {
  const store = globalThis as unknown as Record<symbol, CounterState | undefined>;
  return (store[STATE] ??= { counts: new Map(), pending: 0, lastFlushAt: 0 });
}

/**
 * Counts one secret fetch — a bulk pull, an export, a reveal — for an
 * organisation. **On the data path, and never able to fail it**: no await, no
 * throw, no query; a flush, when due, runs from `waitUntil`.
 *
 * Counted whatever the plan and whether or not payments are on: the billing
 * screen shows every organisation its usage, and only a subscription Dodo
 * bills is ever reported.
 */
export function countSecretFetch(services: ServiceContext, orgId: string): void {
  try {
    const counter = state();
    if (!counter.counts.has(orgId) && counter.counts.size >= MAX_TRACKED_ORGS) {
      // A full map is flushed rather than grown; this fetch goes in after it.
      services.waitUntil(flushFetchCounts(services));
    }
    counter.counts.set(orgId, (counter.counts.get(orgId) ?? 0) + 1);
    counter.pending += 1;

    const now = Date.now();
    if (counter.pending >= FLUSH_AT_COUNT || now - counter.lastFlushAt >= FLUSH_INTERVAL_MS) {
      services.waitUntil(flushFetchCounts(services));
    }
  } catch {
    // Unreachable in practice — a Map and two integers — and swallowed all the
    // same: a fetch is never refused, or failed, for a billing reason.
  }
}

/**
 * Writes this isolate's accumulated counts. The snapshot is taken and the map
 * cleared before the first `await`, so a fetch counted while the write is in
 * flight goes into the next flush, never into both.
 */
export async function flushFetchCounts(
  services: Pick<ServiceContext, 'db' | 'log'>,
): Promise<void> {
  const counter = state();
  if (counter.counts.size === 0) return;
  const batch = [...counter.counts.entries()].map(([orgId, fetches]) => ({ orgId, fetches }));
  counter.counts = new Map();
  counter.pending = 0;
  counter.lastFlushAt = Date.now();

  try {
    await addFetchCounts(services.db, batch);
  } catch (cause) {
    services.log.at('flushFetchCounts').warn(
      // Dropped, not retried: see the header — a retry is the one way to
      // over-count, and an over-count is a wrong charge.
      'Could not record secret-fetch counts; they were dropped rather than risk counting twice',
      { organizations: batch.length, error: describeError(cause) },
    );
  }
}

/** @internal For tests: forget everything this isolate has counted. */
export function resetFetchCounterForTesting(): void {
  const store = globalThis as unknown as Record<symbol, CounterState | undefined>;
  store[STATE] = undefined;
}

/** Dodo takes at most this many events a request. */
const EVENTS_PER_REQUEST = 1_000;
/** One run reports at most this many units for one organisation; the next run takes the rest. */
const MAX_UNITS_PER_RUN = 5_000;

/** The deterministic event id of one unit. Exported so a test can pin its shape. */
export function meterEventId(orgId: string, periodStart: Date, unitIndex: number): string {
  return `${orgId}:${periodStart.toISOString()}:${unitIndex}`;
}

export interface UsageReport {
  organizations: number;
  units: number;
  failures: number;
}

/**
 * The hourly overage report: every billed organisation's new units, to Dodo,
 * once. See the header for why this cannot bill twice.
 */
export async function flushUsageToDodo(services: ServiceContext): Promise<UsageReport> {
  const report: UsageReport = { organizations: 0, units: 0, failures: 0 };
  const setup = billingSetup(services.env);
  if (setup.state === 'disabled') return report;
  const { config } = setup;
  const provider = billingProvider(config);
  const log = services.log.at('flushUsageToDodo');

  // Rows touched in the last 40 days: the current period and the tail of the
  // one before, whose last units may still be unreported.
  const rows = await listMeterableUsage(services.db, {
    since: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    limit: 500,
  });

  for (const row of rows) {
    const customerId = row.subscription.dodoCustomerId;
    if (customerId === null) continue;

    const included = entitlementsFromRow(row.subscription).limits.includedFetchesPerMonth;
    const owed = Math.min(
      meteredUnitsOwed(row.secretFetches, included, row.meteredUnitsSent, FETCHES_PER_METERED_UNIT),
      MAX_UNITS_PER_RUN,
    );
    if (owed <= 0) continue;

    const first = row.meteredUnitsSent;
    let sent = first;
    try {
      while (sent < first + owed) {
        const count = Math.min(EVENTS_PER_REQUEST, first + owed - sent);
        const timestamp = new Date();
        const events: UsageEvent[] = Array.from({ length: count }, (_, offset) => ({
          eventId: meterEventId(row.orgId, row.periodStart, sent + offset),
          customerId,
          eventName: config.meterEventName,
          timestamp,
        }));
        await provider.ingestUsage(events);
        sent += count;
        // Recorded per accepted batch, so a failure part-way leaves the record
        // at exactly what Dodo has — and the deterministic ids cover the rest.
        await markMeteredUnitsSent(services.db, row.orgId, row.periodStart, sent);
      }
    } catch (cause) {
      report.failures += 1;
      log.warn('Could not report metered usage to Dodo; the next run retries the same units', {
        orgId: row.orgId,
        ...(cause instanceof DodoApiError
          ? { category: cause.category, status: cause.status }
          : { error: describeError(cause) }),
      });
    }

    const reported = sent - first;
    if (reported > 0) {
      report.organizations += 1;
      report.units += reported;
      await appendAuditEvents(services.db, [
        systemAudit(services, row.orgId, 'billing job').success(
          'billing.usage_reported',
          subscriptionResource(row.orgId),
          { unitCount: reported },
        ),
      ]);
    }
  }

  if (report.units > 0) {
    log.info(
      `Reported ${report.units} metered unit(s) for ${report.organizations} organisation(s)`,
      {
        ...report,
      },
    );
  }
  return report;
}
