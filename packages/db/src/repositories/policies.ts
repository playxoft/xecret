import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { DEFAULT_SECRET_POLICY, DEFAULT_TOKEN_POLICY } from '@xecret/core/policy';
import type { SecretPolicy, TokenPolicy } from '@xecret/core/policy';
import { uuidv7 } from '@xecret/core/ids';
import { users } from '../schema/identity';
import { environmentReadSightings, orgPolicies, readAlertDigests } from '../schema/paid-features';
import type { SightingPrincipalKind } from '../schema/paid-features';
import { environments, projects } from '../schema/resources';
import { orgMembers } from '../schema/tenancy';
import { withinOrganization } from './environments';
import type { EnvironmentRecord } from './environments';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Organisation and environment policies, and the read sightings behind the
 * new-location alerts (P19 §6–§9, migrations 0027 and 0028).
 */

export interface OrgPolicies {
  tokens: TokenPolicy;
  secrets: SecretPolicy;
  updatedAt: Date | null;
}

/** The organisation's policies, or every default when it never set one. */
export async function loadOrgPolicies(exec: Executor, orgId: string): Promise<OrgPolicies> {
  const [row] = await exec
    .select({
      tokenRequireIpAllowlist: orgPolicies.tokenRequireIpAllowlist,
      tokenMaxLifetimeDays: orgPolicies.tokenMaxLifetimeDays,
      secretPolicy: orgPolicies.secretPolicy,
      updatedAt: orgPolicies.updatedAt,
    })
    .from(orgPolicies)
    .where(eq(orgPolicies.orgId, orgId))
    .limit(1);

  if (!row) {
    return { tokens: DEFAULT_TOKEN_POLICY, secrets: DEFAULT_SECRET_POLICY, updatedAt: null };
  }
  return {
    tokens: {
      requireIpAllowlist: row.tokenRequireIpAllowlist,
      maxLifetimeDays: row.tokenMaxLifetimeDays,
    },
    // A stored policy written by an older build may lack a field this one added;
    // the default fills it rather than an `undefined` reaching an evaluator.
    secrets: { ...DEFAULT_SECRET_POLICY, ...(row.secretPolicy ?? {}) },
    updatedAt: row.updatedAt,
  };
}

/** Writes the token policy, creating the row if the organisation has none. */
export async function saveTokenPolicy(
  exec: Executor,
  params: { orgId: string; policy: TokenPolicy; updatedBy: string | null },
): Promise<void> {
  await exec
    .insert(orgPolicies)
    .values({
      orgId: params.orgId,
      tokenRequireIpAllowlist: params.policy.requireIpAllowlist,
      tokenMaxLifetimeDays: params.policy.maxLifetimeDays,
      updatedBy: params.updatedBy,
    })
    .onConflictDoUpdate({
      target: orgPolicies.orgId,
      set: {
        tokenRequireIpAllowlist: params.policy.requireIpAllowlist,
        tokenMaxLifetimeDays: params.policy.maxLifetimeDays,
        updatedBy: params.updatedBy,
        updatedAt: sql`now()`,
      },
    });
}

/** Writes the secret policy, already validated by `validateSecretPolicy`. */
export async function saveSecretPolicy(
  exec: Executor,
  params: { orgId: string; policy: SecretPolicy; updatedBy: string | null },
): Promise<void> {
  await exec
    .insert(orgPolicies)
    .values({ orgId: params.orgId, secretPolicy: params.policy, updatedBy: params.updatedBy })
    .onConflictDoUpdate({
      target: orgPolicies.orgId,
      set: { secretPolicy: params.policy, updatedBy: params.updatedBy, updatedAt: sql`now()` },
    });
}

/** The two per-environment switches. Absent means "leave it". */
export interface EnvironmentPolicyPatch {
  plaintextExportDisabled?: boolean | undefined;
  /** `null` restores the default — on for production, off elsewhere. */
  readAlerts?: boolean | null | undefined;
}

export async function updateEnvironmentPolicy(
  exec: Executor,
  orgId: string,
  environmentId: string,
  patch: EnvironmentPolicyPatch,
): Promise<EnvironmentRecord> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (patch.plaintextExportDisabled !== undefined) {
    set['plaintextExportDisabled'] = patch.plaintextExportDisabled;
  }
  if (patch.readAlerts !== undefined) set['readAlerts'] = patch.readAlerts;

  const [row] = await exec
    .update(environments)
    .set(set)
    .where(
      and(
        eq(environments.id, environmentId),
        isNull(environments.deletedAt),
        withinOrganization(orgId),
      ),
    )
    .returning();
  if (!row) throw new RepositoryError('notFound', `Environment ${environmentId} not found`);
  return row;
}

/* ── read sightings ───────────────────────────────────────────────────────── */

export interface SightingParams {
  orgId: string;
  environmentId: string;
  principalKind: SightingPrincipalKind;
  principalId: string;
  principalLabel: string | null;
  /** Already normalised — a v4 address whole, a v6 address as its /64. */
  ipAddress: string;
}

/**
 * Records that a principal read an environment from an address. Answers whether
 * that triple had never been seen — the only case that owes an alert.
 *
 * One statement either way: `xmax = 0` is true exactly when the row was
 * inserted rather than updated by the `ON CONFLICT` arm.
 */
export async function recordReadSighting(
  exec: Executor,
  params: SightingParams,
): Promise<{ isNew: boolean }> {
  const [row] = await exec
    .insert(environmentReadSightings)
    .values({ id: uuidv7(), ...params })
    .onConflictDoUpdate({
      target: [
        environmentReadSightings.environmentId,
        environmentReadSightings.principalKind,
        environmentReadSightings.principalId,
        environmentReadSightings.ipAddress,
      ],
      set: { lastSeenAt: sql`now()`, principalLabel: params.principalLabel },
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return { isNew: row?.inserted === true };
}

/**
 * Claims the right to mail an organisation now: succeeds when it has never been
 * mailed, or not since `notSince`. The claim and the timestamp are one
 * statement, so two reads arriving together send one email between them.
 */
export async function claimReadAlertDigest(
  exec: Executor,
  orgId: string,
  notSince: Date,
): Promise<boolean> {
  const rows = await exec
    .insert(readAlertDigests)
    .values({ orgId, lastSentAt: sql`now()` })
    .onConflictDoUpdate({
      target: readAlertDigests.orgId,
      set: { lastSentAt: sql`now()` },
      setWhere: lt(readAlertDigests.lastSentAt, notSince),
    })
    .returning({ orgId: readAlertDigests.orgId });
  return rows.length > 0;
}

export interface OwedSighting {
  id: string;
  environmentId: string;
  environmentSlug: string;
  projectSlug: string;
  isProduction: boolean;
  principalKind: SightingPrincipalKind;
  principalLabel: string | null;
  ipAddress: string;
  firstSeenAt: Date;
}

/**
 * Takes up to `limit` sightings still owed an alert, marking them notified in
 * the same transaction — so a digest that fails to send has already marked
 * them, and the next one does not repeat them. Under-notifying on a mail
 * failure is the direction to err: the dashboard lists every sighting either
 * way.
 */
export async function takeOwedSightings(
  exec: Executor,
  orgId: string,
  limit: number,
): Promise<OwedSighting[]> {
  return exec.transaction(async (tx) => {
    const owed = await tx
      .select({
        id: environmentReadSightings.id,
        environmentId: environmentReadSightings.environmentId,
        environmentSlug: environments.slug,
        projectSlug: projects.slug,
        isProduction: environments.isProduction,
        principalKind: environmentReadSightings.principalKind,
        principalLabel: environmentReadSightings.principalLabel,
        ipAddress: environmentReadSightings.ipAddress,
        firstSeenAt: environmentReadSightings.firstSeenAt,
      })
      .from(environmentReadSightings)
      .innerJoin(environments, eq(environments.id, environmentReadSightings.environmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(
        and(
          eq(environmentReadSightings.orgId, orgId),
          eq(projects.orgId, orgId),
          isNull(environmentReadSightings.notifiedAt),
        ),
      )
      .orderBy(asc(environmentReadSightings.firstSeenAt))
      .limit(limit)
      .for('update', { of: environmentReadSightings, skipLocked: true });

    if (owed.length > 0) {
      await tx
        .update(environmentReadSightings)
        .set({ notifiedAt: sql`now()` })
        .where(
          sql`${environmentReadSightings.id} in (${sql.join(
            owed.map((row) => sql`${row.id}`),
            sql`, `,
          )})`,
        );
    }
    return owed;
  });
}

/** Organisations owed a digest whose throttle has passed — the scheduled sweep's work list. */
export async function listOrgsOwedReadAlerts(
  exec: Executor,
  notSince: Date,
  limit: number,
): Promise<string[]> {
  const rows = await exec
    .selectDistinct({ orgId: environmentReadSightings.orgId })
    .from(environmentReadSightings)
    .leftJoin(readAlertDigests, eq(readAlertDigests.orgId, environmentReadSightings.orgId))
    .where(
      and(
        isNull(environmentReadSightings.notifiedAt),
        or(isNull(readAlertDigests.lastSentAt), lt(readAlertDigests.lastSentAt, notSince)),
      ),
    )
    .limit(limit);
  return rows.map((row) => row.orgId);
}

export interface SightingRecord {
  id: string;
  principalKind: SightingPrincipalKind;
  principalLabel: string | null;
  ipAddress: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  notifiedAt: Date | null;
}

/** An environment's sightings, newest first — the in-app half of the alert. */
export async function listReadSightings(
  exec: Executor,
  orgId: string,
  environmentId: string,
  limit: number,
): Promise<SightingRecord[]> {
  return exec
    .select({
      id: environmentReadSightings.id,
      principalKind: environmentReadSightings.principalKind,
      principalLabel: environmentReadSightings.principalLabel,
      ipAddress: environmentReadSightings.ipAddress,
      firstSeenAt: environmentReadSightings.firstSeenAt,
      lastSeenAt: environmentReadSightings.lastSeenAt,
      notifiedAt: environmentReadSightings.notifiedAt,
    })
    .from(environmentReadSightings)
    .where(
      and(
        eq(environmentReadSightings.orgId, orgId),
        eq(environmentReadSightings.environmentId, environmentId),
      ),
    )
    .orderBy(sql`${environmentReadSightings.firstSeenAt} desc`)
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** Sightings not seen since `before`. A pruned address is "new" again the next time. */
export async function pruneReadSightings(exec: Executor, before: Date): Promise<number> {
  const rows = await exec
    .delete(environmentReadSightings)
    .where(lt(environmentReadSightings.lastSeenAt, before))
    .returning({ id: environmentReadSightings.id });
  return rows.length;
}

/**
 * The addresses of an organisation's active owners and admins — who a security
 * notification about it goes to. Bounded: an organisation with more than
 * `limit` administrators is mailed the first `limit` by seniority.
 */
export async function listAdministratorAddresses(
  exec: Executor,
  orgId: string,
  limit: number,
): Promise<{ email: string; displayName: string | null }[]> {
  return exec
    .select({ email: users.email, displayName: users.displayName })
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.status, 'active'),
        // By built-in role. A custom role narrows an admin, and one narrowed away
        // from member management is still told about a security event in their
        // organisation — the conservative reading of "the org admins".
        or(eq(orgMembers.role, 'owner'), eq(orgMembers.role, 'admin')),
      ),
    )
    .orderBy(asc(orgMembers.createdAt))
    .limit(limit);
}
