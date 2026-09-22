#!/usr/bin/env -S npx tsx
/**
 * Sets an organisation's plan, add-ons and limit overrides, by hand.
 *
 *   phase run -- npm run plan:show -- --org acme
 *   phase run -- npm run plan:set  -- --org acme --plan team --interval yearly --seats 5
 *   phase run -- npm run plan:set  -- --org acme --addon saml --on
 *   phase run -- npm run plan:set  -- --org acme --limit-override projects=2000
 *   phase run -- npm run plan:set  -- --org acme --plan free
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
import { createDatabaseHandle } from '../packages/db/src/client.ts';
import { auditLogs } from '../packages/db/src/schema/audit.ts';
import { orgSubscriptions } from '../packages/db/src/schema/billing.ts';
import { organizations } from '../packages/db/src/schema/tenancy.ts';
import { uuidv7 } from '../packages/core/src/ids/index.ts';

type Args = Record<string, string | boolean>;

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

function describe(row: typeof orgSubscriptions.$inferSelect, slug: string): void {
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
      .select({ id: organizations.id, slug: organizations.slug })
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
      if (row) describe(row, slug);
      return;
    }

    const patch: Partial<typeof orgSubscriptions.$inferInsert> = {};
    const changes: string[] = [];
    /** Which ceiling this run raised, for the audit row. */
    let overriddenLimit: string | null = null;

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
        patch.billingInterval = null;
      } else {
        const interval = typeof args['interval'] === 'string' ? args['interval'] : 'yearly';
        if (interval !== 'monthly' && interval !== 'yearly') {
          fail('--interval must be "monthly" or "yearly".');
        }
        patch.billingInterval = interval;
        changes.push(`interval=${interval}`);
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
      patch.seats = plan === 'free' ? 1 : Math.max(requested, minimum);
      changes.push(`seats=${patch.seats}`);
    } else if (typeof args['seats'] === 'string') {
      const seats = Number(args['seats']);
      if (!Number.isFinite(seats) || seats < 0) fail('--seats must be a number.');
      patch.seats = seats;
      changes.push(`seats=${seats}`);
    }

    if (typeof args['status'] === 'string') {
      patch.status = args['status'] as typeof orgSubscriptions.$inferInsert.status;
      changes.push(`status=${args['status']}`);
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
      if (!(key in PLANS.free.limits)) {
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

    const [updated] = await db
      .update(orgSubscriptions)
      .set(patch)
      .where(eq(orgSubscriptions.orgId, org.id))
      .returning();

    if (!updated) fail('Update returned no row.');

    // `actor_type` is 'system': an operator at a shell is not a user and not a
    // token, and inventing a synthetic user id would put a lie in the one table
    // the product promises is truthful. The operator's name goes in the
    // metadata, where it is plainly a label rather than an identity.
    //
    // The metadata fields are the declared ones from `AuditMetadata` rather
    // than the free-form object it would be convenient to write here. The
    // allowlist is what guarantees no audit row can carry a secret, and a
    // script that writes around it because it is "only an operator tool" is the
    // first hole in that guarantee.
    await db.insert(auditLogs).values({
      id: uuidv7(),
      orgId: org.id,
      actorType: 'system',
      actorLabel: operator,
      action: 'plan.changed',
      outcome: 'success',
      resourceType: 'org',
      resourceId: org.id,
      metadata: {
        operator,
        ...(patch.plan ? { plan: patch.plan } : {}),
        ...(existing?.plan && patch.plan && existing.plan !== patch.plan
          ? { previousPlan: existing.plan }
          : {}),
        ...(typeof args['addon'] === 'string' ? { addonName: args['addon'] } : {}),
        ...(overriddenLimit ? { limitName: overriddenLimit } : {}),
        ...(typeof patch.seats === 'number' ? { seatCount: patch.seats } : {}),
        reason: changes.join(' '),
      },
      createdAt: new Date(),
    });

    console.log(`✓ ${slug}: ${changes.join(' ')}`);
    describe(updated, slug);
  } finally {
    await end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
