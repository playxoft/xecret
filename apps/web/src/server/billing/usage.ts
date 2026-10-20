import { FETCHES_PER_METERED_UNIT, meteredUnitsOwed } from '@xecret/core/entitlements';
import {
  addFetchCounts,
  appendAuditEvents,
  entitlementsFromRow,
  listMeterableUsage,
  markMeteredUnitsSent,
} from '@xecret/db/repositories';
import type { MeterableUsage } from '@xecret/db/repositories';
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
 *     `waitUntil`, after the response has gone — as soon as
 *     {@link FLUSH_AT_COUNT} fetches are waiting, and otherwise at most
 *     {@link FLUSH_INTERVAL_MS} after the first one: that fetch's request arms
 *     a timer inside its own `waitUntil`, which workerd keeps running for up to
 *     thirty seconds after the response. Not once per fetch: a Durable Object
 *     would put a subrequest on every fetch, and an outage of it next to the
 *     one path that must never depend on anything.
 *  2. **No new infrastructure.** No Durable Object class, no migration of the
 *     Worker's bindings, nothing for a self-hoster to provision.
 *  3. **Its one failure is in the customer's favour.** An isolate evicted
 *     before its timer fires loses at most those fifteen seconds of counts.
 *     Nothing can make it count a fetch twice: a flush takes its snapshot and
 *     clears the map in one synchronous step, and a flush that fails is
 *     dropped rather than retried — a retry after a write that did land but
 *     reported failure would be the one way to over-count. Under-counting by a
 *     handful of fetches is the honest price; over-billing by any is not.
 *
 * ── Each fetch belongs to the period it was made in ──
 * Counts are kept per second, and the flush hands each second to the database
 * with its time (`addFetchCounts`'s `countedAt`), which places it in the
 * billing period that covered that second — never in whichever period is
 * current when the flush lands. A fetch made on Free a few seconds before an
 * upgrade is not counted into the paid period after it.
 *
 * The counter holds organisation ids and integers and nothing else — no
 * request object, no database handle, nothing that is I/O. workerd forbids
 * sharing those across requests; plain numbers are what it allows. The timer's
 * flush writes through the services of the request that armed it, inside that
 * request's own `waitUntil`.
 *
 * ── Reporting: one event per thousand fetches past the allowance ──
 * The hourly job (`flushUsageToDodo`) reads each billed organisation's counter
 * for each period the subscription paid for — **our count, written first, is
 * the dispute record** — and computes `floor((fetches − included) / 1000) −
 * units already reported`. Each new unit is one Dodo event with a
 * **deterministic id**, `${orgId}:${periodStart}:${unitIndex}`; Dodo treats an
 * event id as an idempotency key — "subsequent requests with existing
 * `event_id` values are ignored" — so a retry, a crashed run or two runs racing
 * report the same ids and only the first counts
 * (https://docs.dodopayments.com/api-reference/usage-events/ingest-events).
 * Units are recorded as reported only after Dodo accepted them, with
 * `GREATEST`, so the record can only move forward and never past what was sent.
 *
 * Dodo refuses an event timestamped more than an hour ago, so every event is
 * stamped with the moment it is reported. Units still owed for a period that
 * has just ended are therefore reported — once — into Dodo's next billing
 * period, never dropped and never billed twice.
 *
 * The included allowance is subtracted *here*, from `plans.ts` with any support
 * override — so Dodo's meter must carry no free threshold of its own, or the
 * allowance is given twice (docs/operations/billing.md).
 */

/** Flush an isolate's counts at most this long after the first one waiting. */
export const FLUSH_INTERVAL_MS = 15_000;
/** …or as soon as this many fetches are waiting, whichever comes first. */
export const FLUSH_AT_COUNT = 50;
/** Bound the map, so an isolate serving thousands of organisations stays small. */
const MAX_TRACKED_ORGS = 1_000;

interface CounterState {
  /** Organisation → the second a fetch was made in (epoch seconds) → fetches. */
  counts: Map<string, Map<number, number>>;
  pending: number;
  /** A timer flush is waiting in some request's `waitUntil`. */
  timerArmed: boolean;
}

const STATE = Symbol.for('xecret.secret-fetch-counter');

function state(): CounterState {
  const store = globalThis as unknown as Record<symbol, CounterState | undefined>;
  return (store[STATE] ??= { counts: new Map(), pending: 0, timerArmed: false });
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
    const second = Math.floor(Date.now() / 1000);
    const perSecond = counter.counts.get(orgId) ?? new Map<number, number>();
    perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
    counter.counts.set(orgId, perSecond);
    counter.pending += 1;

    if (counter.pending >= FLUSH_AT_COUNT) {
      services.waitUntil(flushFetchCounts(services));
    } else if (!counter.timerArmed) {
      // The first fetch waiting arms the flush that writes it, so a quiet
      // isolate cannot sit on counts until its next request — or its eviction.
      counter.timerArmed = true;
      services.waitUntil(flushAfter(services, FLUSH_INTERVAL_MS));
    }
  } catch {
    // Unreachable in practice — a Map and two integers — and swallowed all the
    // same: a fetch is never refused, or failed, for a billing reason.
  }
}

async function flushAfter(
  services: Pick<ServiceContext, 'db' | 'log'>,
  delayMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  await flushFetchCounts(services);
}

/**
 * Writes this isolate's accumulated counts. The snapshot is taken and the map
 * cleared before the first `await`, so a fetch counted while the write is in
 * flight goes into the next flush — and arms a timer of its own — never into
 * both.
 */
export async function flushFetchCounts(
  services: Pick<ServiceContext, 'db' | 'log'>,
): Promise<void> {
  const counter = state();
  counter.timerArmed = false;
  if (counter.counts.size === 0) return;
  const batch = [...counter.counts.entries()].flatMap(([orgId, perSecond]) =>
    [...perSecond.entries()].map(([second, fetches]) => ({
      orgId,
      fetches,
      countedAt: new Date(second * 1000),
    })),
  );
  counter.counts = new Map();
  counter.pending = 0;

  try {
    await addFetchCounts(services.db, batch);
  } catch (cause) {
    services.log.at('flushFetchCounts').warn(
      // Dropped, not retried: see the header — a retry is the one way to
      // over-count, and an over-count is a wrong charge.
      'Could not record secret-fetch counts; they were dropped rather than risk counting twice',
      {
        organizations: new Set(batch.map((entry) => entry.orgId)).size,
        error: describeError(cause),
      },
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
/** Rows read per page of the work list. */
export const USAGE_PAGE_SIZE = 500;
/** Pages one run reads at most; a longer list is finished by the next run. */
const MAX_PAGES_PER_RUN = 40;

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

  const reportRow = async (row: MeterableUsage): Promise<void> => {
    const customerId = row.subscription.dodoCustomerId;
    if (customerId === null) return;

    const included = entitlementsFromRow(row.subscription).limits.includedFetchesPerMonth;
    const owed = Math.min(
      meteredUnitsOwed(row.secretFetches, included, row.meteredUnitsSent, FETCHES_PER_METERED_UNIT),
      MAX_UNITS_PER_RUN,
    );
    if (owed <= 0) return;

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
  };

  // Rows touched in the last 40 days: the current period and the tail of the
  // one before, whose last units may still be unreported. Only rows that can
  // owe another unit are listed, in key order, page after page — so no number
  // of quiet rows can push one that owes off the end of the list.
  const since = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  let after: { orgId: string; periodStart: Date } | undefined;
  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    const rows = await listMeterableUsage(services.db, {
      since,
      limit: USAGE_PAGE_SIZE,
      mode: config.mode,
      after,
    });
    for (const row of rows) await reportRow(row);
    if (rows.length < USAGE_PAGE_SIZE) break;
    const last = rows[rows.length - 1]!;
    after = { orgId: last.orgId, periodStart: last.periodStart };
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
