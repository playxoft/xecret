import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';

import { PLANS } from '@xecret/core/entitlements';
import * as schema from '../schema';
import {
  entitlementColumns,
  entitlementsFromRow,
  recordFetchesStatement,
  recordMeteredUnitsStatement,
  subscriptionQuery,
  usageQuery,
} from './subscriptions';
import type { SubscriptionEntitlementRow } from './subscriptions';

/**
 * Query-shape assertions, in the style of the other repository tests: the
 * database is never contacted, and `.toSQL()` is asserted instead. A suite that
 * has never seen its own database proves the code is *consistent*, not that it
 * *works* — which is exactly what these tests claim and no more.
 */

const db = drizzle(
  {
    options: { parsers: {}, serializers: {} },
  } as unknown as Sql,
  { schema },
);

describe('subscriptionQuery', () => {
  it('filters on org_id and takes at most one row', () => {
    const { sql, params } = subscriptionQuery(db, 'org-1').toSQL();

    expect(sql).toContain('"org_subscriptions"');
    expect(sql).toContain('"org_id" = ');
    expect(sql).toContain('limit');
    expect(params).toContain('org-1');
  });

  it('is a single-table read — no join, so it can ride along with an existing load', () => {
    const { sql } = subscriptionQuery(db, 'org-1').toSQL();
    expect(sql.toLowerCase()).not.toContain('join');
  });
});

describe('usageQuery', () => {
  it('filters on both halves of the composite key', () => {
    const period = new Date('2026-09-01T00:00:00.000Z');
    const { sql, params } = usageQuery(db, 'org-1', period).toSQL();

    expect(sql).toContain('"org_usage_counters"');
    expect(sql).toContain('"org_id" = ');
    expect(sql).toContain('"period_start" = ');
    expect(params).toContain('org-1');
  });
});

describe('entitlementColumns', () => {
  /**
   * The projection exists so that the authorization context can select these
   * columns alongside the membership it already reads, rather than issuing a
   * second query per request. If it ever grows a column that is not needed to
   * resolve entitlements, the hot path pays for it on every secret fetch.
   */
  it('names exactly the columns entitlement resolution consumes', () => {
    expect(Object.keys(entitlementColumns).sort()).toEqual([
      'addonDirectorySync',
      'addonSaml',
      'currentPeriodEnd',
      'limitOverrides',
      'plan',
      'status',
    ]);
  });

  it('carries no credential or provider identifier', () => {
    const names = Object.keys(entitlementColumns).join(' ');
    expect(names).not.toMatch(/dodo|customer|token|secret/i);
  });
});

describe('entitlementsFromRow', () => {
  function row(over: Partial<SubscriptionEntitlementRow> = {}): SubscriptionEntitlementRow {
    return {
      plan: 'team',
      status: 'active',
      addonSaml: false,
      addonDirectorySync: false,
      limitOverrides: null,
      currentPeriodEnd: null,
      ...over,
    };
  }

  it('resolves a row without touching the database', () => {
    const e = entitlementsFromRow(row());
    expect(e.plan).toBe('team');
    expect(e.features.oidcSso).toBe(true);
    expect(e.limits.auditRetentionDays).toBe(PLANS.team.limits.auditRetentionDays);
  });

  it('falls back to Free when the row is missing', () => {
    // Unreachable in practice — the migration backfilled every organisation and
    // provisioning inserts alongside — but Free is the same answer the
    // migration would have written, and it is the safe direction to be wrong in.
    expect(entitlementsFromRow(null).plan).toBe('free');
    expect(entitlementsFromRow(undefined).plan).toBe('free');
  });

  it('carries add-ons through independently of the plan', () => {
    const e = entitlementsFromRow(row({ addonSaml: true }));
    expect(e.addons.samlSso).toBe(true);
    expect(e.addons.directorySync).toBe(false);
  });

  it('applies a stored override', () => {
    const e = entitlementsFromRow(row({ plan: 'free', limitOverrides: { projects: 99 } }));
    expect(e.limits.projects).toBe(99);
  });

  it('treats a null overrides column as no overrides', () => {
    const e = entitlementsFromRow(row({ plan: 'free', limitOverrides: null }));
    expect(e.limits.projects).toBe(PLANS.free.limits.projects);
  });

  it('keeps the data plane open for every lapsed status', () => {
    // The D19 rule, asserted again at the layer that loads the row, because
    // this is where a well-meaning "check the status first" would be added.
    for (const status of ['past_due', 'on_hold', 'cancelled', 'expired'] as const) {
      const e = entitlementsFromRow(row({ status }));
      expect(e.status).toBe(status);
      expect(e.features.oidcSso).toBe(true);
    }
  });

  it('closes the control plane only once a subscription has truly lapsed', () => {
    expect(entitlementsFromRow(row({ status: 'past_due' })).controlPlaneActive).toBe(true);
    expect(entitlementsFromRow(row({ status: 'expired' })).controlPlaneActive).toBe(false);
  });
});

/**
 * The two writes into `org_usage_counters`, which are the only statements in the
 * product whose failure mode is a wrong invoice.
 *
 * `recordMeteredUnits` was an `UPDATE … WHERE org_id AND period_start`. Nothing
 * about that is an error when it matches no row: zero rows affected is a
 * successful statement, and the caller goes away believing the units are banked.
 * They are not — so the next flush recomputes
 * `floor(billable / unit) - unitsAlreadySent` against an `unitsAlreadySent` of
 * zero and reports the same units to the provider a second time. A double
 * charge, produced by the one column that exists to prevent double charges.
 *
 * The row can genuinely be absent: `recordFetches` returns early when a period
 * saw no fetches, so a period with units and no counter row is reachable rather
 * than theoretical.
 */
describe('the usage counter writes', () => {
  const period = new Date('2026-09-01T00:00:00.000Z');

  it('records metered units as an upsert, not an update', () => {
    const { sql } = recordMeteredUnitsStatement(db, 'org-1', period, 3).toSQL();

    expect(sql).toContain('insert into "org_usage_counters"');
    expect(sql).toContain('on conflict');
    expect(sql.toLowerCase().startsWith('update')).toBe(false);
  });

  it('conflicts on the composite key, which the table declares as its primary key', () => {
    // The model declared a plain non-unique index here while migration 0016
    // created the primary key. Postgres resolves an ON CONFLICT target against
    // a unique constraint and nothing else, so any environment built from the
    // model rather than the SQL got a table these two statements cannot run
    // against at all.
    for (const { sql } of [
      recordFetchesStatement(db, 'org-1', period, 2).toSQL(),
      recordMeteredUnitsStatement(db, 'org-1', period, 2).toSQL(),
    ]) {
      expect(sql).toContain('"org_id"');
      expect(sql).toContain('"period_start"');
      expect(sql).toContain('do update set');
    }
  });

  it('adds to what is already banked rather than overwriting it', () => {
    // Two concurrent flushes must sum. A read-add-write in application code
    // cannot guarantee that; only the statement can.
    expect(recordMeteredUnitsStatement(db, 'org-1', period, 3).toSQL().sql).toContain(
      '"metered_units_sent" +',
    );
    expect(recordFetchesStatement(db, 'org-1', period, 3).toSQL().sql).toContain(
      '"secret_fetches" +',
    );
  });

  /**
   * A period that saw units but no fetches is an honest zero, not an unknown.
   * It is also the row the next `recordFetches` will add to.
   */
  it('inserts a zero fetch count when it has to create the row', () => {
    const { params } = recordMeteredUnitsStatement(db, 'org-1', period, 3).toSQL();
    expect(params).toContain(0);
  });
});
