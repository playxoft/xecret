import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import type { Database } from '../client';
import type * as schema from '../schema';

/**
 * Shared plumbing for the repository layer.
 *
 * Repositories are plain functions over an executor rather than classes holding
 * a connection. That keeps them composable inside a transaction: the caller
 * decides the boundary, and a repository never opens one on its own. A
 * repository that quietly began its own transaction would make it impossible to
 * write "create the organisation, its keys, and the owner membership, or none of
 * them" — which is exactly the invariant the bootstrap path depends on.
 */

/** A transaction handle with the same query surface as the database itself. */
export type Transaction = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Anything a repository can run against.
 *
 * Every repository function takes this rather than `Database`, so the same
 * function works standalone and inside a transaction with no second code path.
 */
export type Executor = Database | Transaction;

/**
 * Rows a query may return before pagination guards are applied.
 *
 * A caller that forgets a limit on a tenant-scoped table would otherwise stream
 * an entire organisation's rows through a Worker with a 128 MB memory ceiling.
 */
export const MAX_PAGE_SIZE = 200;

export const DEFAULT_PAGE_SIZE = 50;

/** Clamps a caller-supplied page size into the permitted range. */
export function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE);
}

/**
 * Raised when a write would violate an invariant the schema cannot express.
 *
 * Carries a stable `code` rather than a message the caller must pattern-match,
 * because route handlers map these onto HTTP responses and a message is not an
 * API contract.
 */
export class RepositoryError extends Error {
  constructor(
    readonly code: RepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

export type RepositoryErrorCode =
  | 'conflict'
  | 'notFound'
  | 'lastOwner'
  | 'seatLimit'
  /**
   * A standing per-account ceiling would be exceeded by this write.
   *
   * Distinct from `conflict`, which the organisation routes already spend on a
   * slug somebody else claimed: the two are both 409s and both resolvable by
   * the caller, but they are resolved by opposite acts — pick another name
   * versus close one you already have — and `POST /api/orgs` puts the first on
   * the slug field and the second at the foot of the form.
   */
  | 'quotaExceeded'
  | 'immutable'
  /**
   * The call itself is malformed — an update with nothing to update, say.
   *
   * Distinct from the others in that it describes the *request* rather than the
   * data: no arrangement of rows would have made it succeed. Route handlers map
   * it to 400, which is where their `default` branch already sends it.
   */
  | 'invalid';
