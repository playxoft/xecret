import { and, count, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { environments, projects } from '../schema/resources';
import { cliTokens, serviceTokens } from '../schema/tokens';
import type { Executor } from './shared';

/**
 * Counting what a plan limits, and serialising the writes that add to it.
 *
 * ── Why a count needs a lock ──
 * A plan limit is "at most n". No unique index expresses that, so the only
 * thing that can enforce it is a count — and a count taken before a write is
 * check-then-act: two requests that both read `4` against a limit of `5` both
 * pass, and the database accepts both rows. The organisation ceiling learned
 * this first (`provisionOrganization`); every other ceiling follows the same
 * shape. The creating transaction takes {@link lockCapacity} for the scope it
 * is about to add to, counts inside it, decides, and writes — and a second
 * creation into the same scope waits for the first to commit, then counts again.
 *
 * ── What is counted ──
 * Only what is still live: a soft-deleted project or environment, and a token
 * that is revoked or past its expiry, holds no place. So deleting or revoking
 * one always makes room, and nothing has to be purged first. These are also
 * the counts the billing screen warns from, so a warning and a refusal cannot
 * disagree about what an organisation has.
 *
 * None of this is on the secret-fetch path, and nothing here ever deletes,
 * revokes or hides what an organisation already holds past a ceiling.
 */

/** The scopes a plan ceiling is counted in. */
export type CapacityScope =
  | 'projects'
  | 'environmentsPerProject'
  | 'secretsPerEnvironment'
  | 'serviceTokens'
  | 'cliDevicesPerUser'
  | 'webhooks';

/**
 * Serialises additions to one counted scope for the rest of the transaction.
 *
 * `scopeId` is what the ceiling is counted *in*: the organisation for projects,
 * service tokens and webhooks; the project for its environments; the
 * environment for its secrets; the organisation and the person, joined, for CLI
 * devices.
 *
 * A transaction-scoped advisory lock, like `lockReferenceGraph`: no row is
 * touched, so an ordinary write elsewhere in the organisation never queues
 * behind it, and it ends with the transaction, so a pooled connection never
 * keeps it. **Take it before any row lock or write in the transaction** — the
 * one exception being the reference-graph lock, which a template write takes
 * first. Then nothing that holds a row this transaction wants can be waiting on
 * this lock, and it cannot be part of a deadlock. A hash collision between two
 * scopes only makes their creations queue behind each other; neither ever
 * skips its count.
 */
export async function lockCapacity(
  exec: Executor,
  scope: CapacityScope,
  scopeId: string,
): Promise<void> {
  await exec.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`xecret.capacity:${scope}:${scopeId}`}, 0))`,
  );
}

/** An organisation's live projects — the `projects` count. */
export async function countLiveProjects(exec: Executor, orgId: string): Promise<number> {
  const [row] = await exec
    .select({ total: count() })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)));
  return row?.total ?? 0;
}

/** A live project's live environments — the `environmentsPerProject` count. */
export async function countLiveEnvironments(
  exec: Executor,
  orgId: string,
  projectId: string,
): Promise<number> {
  const [row] = await exec
    .select({ total: count() })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(environments.projectId, projectId),
        eq(projects.orgId, orgId),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
      ),
    );
  return row?.total ?? 0;
}

/**
 * A service token that can still be spent: neither revoked nor expired.
 *
 * The same test authentication applies (`findServiceTokenByHash`), against the
 * database's clock rather than a Worker's — and the billing screen counts with
 * it too, so the two cannot disagree about how many an organisation holds.
 */
export function liveServiceToken(): SQL {
  return and(
    isNull(serviceTokens.revokedAt),
    or(isNull(serviceTokens.expiresAt), gt(serviceTokens.expiresAt, sql`now()`)),
  ) as SQL;
}

/** An organisation's live service tokens — the `serviceTokens` count. */
export async function countLiveServiceTokens(exec: Executor, orgId: string): Promise<number> {
  const [row] = await exec
    .select({ total: count() })
    .from(serviceTokens)
    .where(and(eq(serviceTokens.orgId, orgId), liveServiceToken()));
  return row?.total ?? 0;
}

/**
 * One person's live CLI logins in one organisation — the `cliDevicesPerUser`
 * count. Each `xecret login` is its own token and its own device, so a person
 * logged in on a laptop and a desktop holds two; logging out of one, or
 * revoking it from the dashboard, frees its place.
 */
export async function countLiveCliDevices(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<number> {
  const [row] = await exec
    .select({ total: count() })
    .from(cliTokens)
    .where(
      and(
        eq(cliTokens.orgId, orgId),
        eq(cliTokens.userId, userId),
        isNull(cliTokens.revokedAt),
        or(isNull(cliTokens.expiresAt), gt(cliTokens.expiresAt, sql`now()`)),
      ),
    );
  return row?.total ?? 0;
}
