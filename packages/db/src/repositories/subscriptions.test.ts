import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';

import { PLANS } from '@xecret/core/entitlements';
import * as schema from '../schema';
import {
  entitlementColumns,
  entitlementsFromRow,
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
