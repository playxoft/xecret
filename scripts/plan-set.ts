#!/usr/bin/env -S npx tsx
/**
 * Sets an organisation's plan, add-ons and limit overrides, by hand.
 *
 *   phase run -- npm run plan:show -- --org acme
 *   phase run -- npm run plan:set  -- --org acme --plan team --interval yearly --seats 5
 *   phase run -- npm run plan:set  -- --org acme --interval monthly
 *   phase run -- npm run plan:set  -- --org acme --status past_due
 *   phase run -- npm run plan:set  -- --org acme --addon saml --on
 *   phase run -- npm run plan:set  -- --org acme --limit-override projects=2000
 *   phase run -- npm run plan:set  -- --org acme --plan free
 *
 * ## Seats are two columns, and this tool writes both
 *
 * `org_subscriptions.seats` is what the invoice is computed from.
 * `organizations.seat_limit` is what `assertSeatAvailable` refuses an invitation
 * against. `--seats` goes through `setBilledSeats`, which writes the pair in one
 * transaction, because a tool that moved only the first would report success and
 * leave the organisation unable to invite anybody up to the number it printed.
 *
 * ## Why this exists before any payment code does
 *
 * Billing is built second-to-last (`.local/plans/v2/00-overview.md` §2.1), and
 * every phase between here and there gates on a plan or an add-on flag. Without
 * this tool, SSO, RBAC extensions and the Scale features would have nothing to
 * read, and each would grow its own temporary way to fake a plan — which is how
 * a temporary thing becomes four permanent ones.
 *
 * ## Why it survives the arrival of billing
 *
 * Webhooks will write these rows too, and this tool keeps writing them. Support
 * needs a way to grant a trial extension, honour a fair-usage raise, or record
 * an Enterprise agreement that was invoiced by hand and never passed through a
 * checkout page. None of those have a customer-facing flow and none should.
 *
 * ## Why it is a script and never an HTTP endpoint
 *
 * A route that grants paid plans is a route that will eventually be reachable
 * by someone who should not reach it — through a misconfigured wrapper, a
 * forgotten capability check, or a future refactor that moves it. A script run
 * by a person holding database credentials cannot be called by a browser. That
 * is the whole of the security argument, and it is why no amount of "but we
 * could put it behind an admin role" should turn this into a route.
 *
 * ## What it records
 *
 * A `plan.changed` audit row per mutation, attributed to the operator named by
 * `--operator` or by `$USER`. Unlike every other audit actor in the system this
 * one is not a user id or a token id, because an operator at a shell is
 * neither; the record of this run is that row plus this terminal's scrollback.
 */

import { eq } from 'drizzle-orm';
import {
  MINIMUM_SEATS,
  PLAN_IDS,
  PLANS,
  resolveEntitlements,
  type PlanId,
} from '../packages/core/src/entitlements/index.ts';
import { createAuditBuilder } from '../packages/core/src/audit/index.ts';
import { createDatabaseHandle } from '../packages/db/src/client.ts';
import { appendAuditEvents } from '../packages/db/src/repositories/audit.ts';
import { setBilledSeats } from '../packages/db/src/repositories/subscriptions.ts';
import { orgSubscriptions } from '../packages/db/src/schema/billing.ts';
import { subscriptionStatusEnum } from '../packages/db/src/schema/enums.ts';
import { organizations } from '../packages/db/src/schema/tenancy.ts';

type Args = Record<string, string | boolean>;

type SubscriptionStatusValue = (typeof subscriptionStatusEnum.enumValues)[number];
type BillingInterval = 'monthly' | 'yearly';

const BILLING_INTERVALS: readonly BillingInterval[] = ['monthly', 'yearly'];

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}

/**
 * Checked against the Drizzle enum rather than a list written out here.
 *
 * `--status` used to be a bare cast. The spelling is the trap: `canceled` (US)
 * and `cancelled` (the value) differ by one letter, and an unvalidated cast sent
 * either straight to Postgres — where it failed as a raw enum error, after the
 * organisation lookup had already run and with nothing saying which flag was
 * wrong. Every other flag in this file is validated; this one is no different.
 */
function isSubscriptionStatus(value: string): value is SubscriptionStatusValue {
  return (subscriptionStatusEnum.enumValues as readonly string[]).includes(value);
}

function isBillingInterval(value: string): value is BillingInterval {
  return (BILLING_INTERVALS as readonly string[]).includes(value);
}

/**
 * `projects=2000` or `projects=null`.
 *
 * `null` means unlimited. Overrides are applied raise-only by
 * `resolveEntitlements`, so a value below the plan's own ceiling is stored but
 * has no effect — which is deliberate: an operator who typed the wrong number
 * cannot downgrade a paying customer with it.
 */
function parseOverride(spec: string): [string, number | null] {
  const [key, raw] = spec.split('=', 2);
  if (!key || raw === undefined) {
    fail(`--limit-override expects key=value, got "${spec}"`);
  }
  if (raw === 'null' || raw === 'unlimited') return [key, null];

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    fail(`--limit-override value must be a non-negative number or "null", got "${raw}"`);
  }
  return [key, value];
}

/**
 * `seatLimit` is passed in rather than read off the subscription because it is
 * not there: it lives on `organizations`, and it is the column an invitation is
 * actually refused against. Printed next to the billed number on every run so
 * that a divergence between the two is visible without a second query — the two
 * disagreeing is what made `--seats` look like it worked when it did not.
 */
function describe(
  row: typeof orgSubscriptions.$inferSelect,
  slug: string,
  seatLimit: number,
): void {
  const entitlements = resolveEntitlements({
    plan: row.plan,
    status: row.status,
    addonSaml: row.addonSaml,
    addonDirectorySync: row.addonDirectorySync,
    limitOverrides: row.limitOverrides ?? undefined,
    currentPeriodEnd: row.currentPeriodEnd,
  });

  const enabled = Object.entries(entitlements.features)
    .filter(([, on]) => on)
    .map(([name]) => name);

  console.log(`\n  ${slug}`);
  console.log(`  ${'─'.repeat(slug.length)}`);
  console.log(
    `  plan            ${row.plan}${row.billingInterval ? ` (${row.billingInterval})` : ''}`,
  );
  console.log(`  status          ${row.status}`);
  console.log(`  seats billed    ${row.seats}`);
  console.log(
    `  seats enforced  ${seatLimit}${seatLimit === row.seats ? '' : '  ← diverged from billed'}`,
  );
  console.log(`  control plane   ${entitlements.controlPlaneActive ? 'open' : 'closed'}`);
  // Stated on every run because it is the property most likely to be doubted
  // during an incident, and the one the product's promise rests on.
  console.log(`  data plane      open (always — see isDataPlaneActive)`);
  console.log(`  add-ons         saml=${row.addonSaml} directorySync=${row.addonDirectorySync}`);
  console.log(`  currency        ${row.currency ?? '—'} ${row.billingCountry ?? ''}`);
  console.log(`  period ends     ${row.currentPeriodEnd?.toISOString() ?? '—'}`);
  console.log(`  grandfathered   ${row.grandfatheredUntil?.toISOString() ?? '—'}`);
  console.log(`  overrides       ${row.limitOverrides ? JSON.stringify(row.limitOverrides) : '—'}`);
  console.log(`  features        ${enabled.length ? enabled.join(', ') : 'none'}`);
  console.log(
    `  fetches/month   ${entitlements.limits.includedFetchesPerMonth.toLocaleString('en-GB')}`,
  );
  console.log('');
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    fail('DATABASE_URL is not set. Try: phase run -- npm run plan:set -- --org <slug> …');
  }

  const args = parseArgs(process.argv.slice(2));
  const slug = typeof args['org'] === 'string' ? args['org'] : null;
  if (!slug) fail('--org <slug> is required.');

  const showOnly = args['show'] === true || process.env['PLAN_TOOL_MODE'] === 'show';
  const operator =
    (typeof args['operator'] === 'string' ? args['operator'] : null) ??
    process.env['USER'] ??
    process.env['USERNAME'] ??
    'unknown-operator';

  const { db, end } = createDatabaseHandle({ connectionString: url });

  try {
    const [org] = await db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        seatLimit: organizations.seatLimit,
      })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);

    if (!org) fail(`No organisation with slug "${slug}".`);

    const [existing] = await db
      .select()
      .from(orgSubscriptions)
      .where(eq(orgSubscriptions.orgId, org.id))
      .limit(1);

    if (!existing) {
      // Every organisation is backfilled by migration 0016 and every new one is
      // inserted alongside its organisation, so this is unreachable. Creating
      // the row rather than failing is still the right answer: the operator is
      // here to fix something, and refusing to act because of a missing default
      // would be the least useful possible response.
      await db.insert(orgSubscriptions).values({ orgId: org.id }).onConflictDoNothing();
      console.log(`  (created the missing Free subscription row for ${slug})`);
    }

    if (showOnly) {
      const [row] = await db
        .select()
        .from(orgSubscriptions)
        .where(eq(orgSubscriptions.orgId, org.id))
        .limit(1);
      if (row) describe(row, slug, org.seatLimit);
      return;
    }

    const patch: Partial<typeof orgSubscriptions.$inferInsert> = {};
    const changes: string[] = [];
    /** Which ceiling this run raised, for the audit row. */
    let overriddenLimit: string | null = null;
    /**
     * Seats, applied through `setBilledSeats` rather than through `patch`.
     *
     * Deliberately kept out of the patch: seats live in **two** columns, and this
     * tool used to write only one of them. `org_subscriptions.seats` is what the
     * invoice says; `organizations.seat_limit` is what `assertSeatAvailable`
     * enforces on an invitation. Setting `--seats 25` and then watching
     * invitations be refused at the default of five is the bug that produced —
     * the tool reported success, and the number it printed was real, and the
     * organisation still could not invite anybody.
     */
    let billedSeats: number | undefined;

    /**
     * `--interval` is read here rather than only inside the `--plan` branch.
     *
     * It was nested, so `plan:set --org acme --interval monthly` on an existing
     * paid subscription added nothing to `changes` and exited with "Nothing to
     * do" — there was no way to move a subscription between monthly and yearly
     * with a tool that documents `--interval` as a flag.
     */
    let interval: BillingInterval | undefined;
    if (typeof args['interval'] === 'string') {
      if (!isBillingInterval(args['interval'])) fail('--interval must be "monthly" or "yearly".');
      interval = args['interval'];
    }

    if (typeof args['plan'] === 'string') {
      const plan = args['plan'];
      if (!isPlanId(plan)) {
        fail(`--plan must be one of: ${PLAN_IDS.join(', ')}`);
      }
      patch.plan = plan;
      changes.push(`plan=${plan}`);

      // The interval check in the schema makes free-with-an-interval and
      // paid-without-one both impossible, so the tool has to settle it rather
      // than let the insert fail with a constraint name.
      if (plan === 'free') {
        if (interval !== undefined) {
          console.warn('  ! free has no billing interval; --interval is ignored.');
        }
        patch.billingInterval = null;
        changes.push('interval=none');
      } else {
        const chosen = interval ?? 'yearly';
        patch.billingInterval = chosen;
        changes.push(`interval=${chosen}`);
      }

      const minimum = MINIMUM_SEATS[plan];
      const requested =
        typeof args['seats'] === 'string' ? Number(args['seats']) : (existing?.seats ?? 1);

      if (!Number.isFinite(requested) || requested < 0) fail('--seats must be a number.');
      if (plan !== 'free' && requested < minimum) {
        console.warn(
          `  ! ${plan} has a ${minimum}-seat minimum; ${requested} was requested. Setting ${minimum}.`,
        );
      }
      billedSeats = plan === 'free' ? 1 : Math.max(requested, minimum);
      changes.push(`seats=${billedSeats}`);
    } else {
      if (interval !== undefined) {
        // Refused rather than silently written: the schema's interval check
        // makes free-with-an-interval impossible, and a constraint name is a
        // worse thing to read than a sentence.
        if ((existing?.plan ?? 'free') === 'free') {
          fail('A free subscription has no billing interval. Pass --plan as well.');
        }
        patch.billingInterval = interval;
        changes.push(`interval=${interval}`);
      }

      if (typeof args['seats'] === 'string') {
        const seats = Number(args['seats']);
        if (!Number.isFinite(seats) || seats < 0) fail('--seats must be a number.');
        billedSeats = seats;
        changes.push(`seats=${seats}`);
      }
    }

    if (typeof args['status'] === 'string') {
      const status = args['status'];
      if (!isSubscriptionStatus(status)) {
        fail(`--status must be one of: ${subscriptionStatusEnum.enumValues.join(', ')}`);
      }
      patch.status = status;
      changes.push(`status=${status}`);
    }

    if (typeof args['addon'] === 'string') {
      // `--on` and `--off` rather than `--addon saml=true`, so that the
      // dangerous direction is never the default of an omitted flag.
      const on = args['on'] === true;
      const off = args['off'] === true;
      if (on === off) fail('--addon needs exactly one of --on or --off.');

      if (args['addon'] === 'saml') {
        patch.addonSaml = on;
        changes.push(`addon.saml=${on}`);
      } else if (args['addon'] === 'scim' || args['addon'] === 'directory-sync') {
        patch.addonDirectorySync = on;
        changes.push(`addon.directorySync=${on}`);
      } else {
        fail('--addon must be "saml" or "scim".');
      }

      if (on) {
        // Said out loud every time, because the cost is real, recurring, and
        // invisible until an invoice arrives a month later.
        console.warn('  ! This add-on corresponds to a WorkOS connection costing $125/month.');
        console.warn('  ! Create the production connection only for a billed customer.');
      }
    }

    if (typeof args['limit-override'] === 'string') {
      const [key, value] = parseOverride(args['limit-override']);
      // `Object.hasOwn`, not `in`: `--limit-override constructor=5` would pass an
      // `in` check and be stored as an override naming no limit at all.
      if (!Object.hasOwn(PLANS.free.limits, key)) {
        fail(`"${key}" is not a limit. Known: ${Object.keys(PLANS.free.limits).join(', ')}`);
      }
      patch.limitOverrides = { ...(existing?.limitOverrides ?? {}), [key]: value };
      overriddenLimit = key;
      changes.push(`override.${key}=${value ?? 'unlimited'}`);
    }

    if (args['clear-overrides'] === true) {
      patch.limitOverrides = null;
      changes.push('overrides=cleared');
    }

    if (typeof args['grandfather-until'] === 'string') {
      const when = new Date(args['grandfather-until']);
      if (Number.isNaN(when.getTime())) fail('--grandfather-until must be an ISO date.');
      patch.grandfatheredUntil = when;
      changes.push(`grandfatheredUntil=${when.toISOString()}`);
    }

    if (changes.length === 0) {
      fail('Nothing to do. Pass --plan, --seats, --status, --addon, --limit-override, or --show.');
    }

    patch.updatedAt = new Date();

    // `actor_type` is 'system': an operator at a shell is not a user and not a
    // token, and inventing a synthetic user id would put a lie in the one table
    // the product promises is truthful. The operator's name goes in the
    // metadata, where it is plainly a label rather than an identity.
    //
    // Built through `createAuditBuilder` rather than assembled as an insert.
    // The declared field *names* from `AuditMetadata` were always here, but the
    // values went in raw — so `LIMITS.operator`, `LIMITS.reason` and
    // `LIMITS.actorLabel`, three caps added by this very change, applied to
    // every audit row in the product except the ones this script wrote.
    // `$USER` is an environment variable and `--operator` is an argument: both
    // are as attacker-influenced as any string the sanitiser exists for, and a
    // script that writes around the one code path because it is "only an
    // operator tool" is the first hole in that guarantee.
    const event = createAuditBuilder({
      orgId: org.id,
      actorType: 'system',
      actorId: null,
      actorLabel: operator,
      ipAddress: null,
      userAgent: null,
      requestId: null,
    }).success(
      'plan.changed',
      { type: 'org', id: org.id },
      {
        operator,
        ...(patch.plan ? { plan: patch.plan } : {}),
        ...(existing?.plan && patch.plan && existing.plan !== patch.plan
          ? { previousPlan: existing.plan }
          : {}),
        ...(typeof args['addon'] === 'string' ? { addonName: args['addon'] } : {}),
        ...(overriddenLimit ? { limitName: overriddenLimit } : {}),
        ...(billedSeats === undefined ? {} : { seatCount: billedSeats }),
        reason: changes.join(' '),
      },
    );

    // One transaction, because seats are two columns and a run that wrote the
    // invoice's number without the enforced one is the failure this tool had.
    // The audit row joins them: a record of a change that did not fully commit
    // is worse than no record, and this is the table the product promises is
    // truthful.
    const updated = await db.transaction(async (tx) => {
      if (billedSeats !== undefined) await setBilledSeats(tx, org.id, billedSeats);

      const [row] = await tx
        .update(orgSubscriptions)
        .set(patch)
        .where(eq(orgSubscriptions.orgId, org.id))
        .returning();
      if (!row) return null;

      await appendAuditEvents(tx, [event]);
      return row;
    });

    if (!updated) fail('Update returned no row.');

    console.log(`✓ ${slug}: ${changes.join(' ')}`);
    describe(updated, slug, billedSeats ?? org.seatLimit);
  } finally {
    await end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
