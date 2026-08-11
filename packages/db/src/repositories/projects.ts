import { and, count, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@xecret/core/ids';
import { environments, projects } from '../schema/resources';
import { isUniqueViolation } from './users';
import { clampPageSize, RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Projects — the node every environment, secret, and service token hangs from.
 *
 * Two rules hold across this whole directory and are worth stating once, here,
 * because the rest of the resource repositories depend on them:
 *
 * 1. **Every lookup filters on `org_id`, even when the child id alone would
 *    identify the row.** Substituting another tenant's `projectId` is the exact
 *    shape of threat T2 — the most likely real breach in the threat model — and
 *    a repository is the last layer that can still catch it. "The route already
 *    checked" is not a control; the `WHERE` clause is.
 *
 * 2. **Soft delete propagates through joins, not through cascading writes.**
 *    Soft-deleting a project must hide its environments and secrets, but a
 *    cascade `UPDATE` across three tables would be slow, racy, and impossible to
 *    undo cleanly. Instead every read in this directory that reaches a project
 *    also asserts `projects.deleted_at is null`, so the parent's state is
 *    honoured by construction and `restoreProject` is a single-row write.
 *
 * Rows are never hard-deleted. An audit trail that points at a row somebody
 * `DELETE`d is worthless, and "who deleted this and when" is the question the
 * log exists to answer.
 */

/**
 * Offset pagination request, shared by the resource listings in this directory.
 *
 * Offsets are acceptable here because a project or secret listing is bounded by
 * what a human will scroll and is not append-heavy. The audit log — which is
 * both — uses keyset pagination instead; see `queryAuditLogs`.
 */
export interface PageRequest {
  /** 1-based. Values below 1 are treated as the first page. */
  page?: number | undefined;
  pageSize?: number | undefined;
}

export type ProjectRecord = typeof projects.$inferSelect;

export interface ProjectListItem extends ProjectRecord {
  /** Aggregated inside the listing query — never one extra query per project. */
  environmentCount: number;
}

export interface ProjectPage {
  items: ProjectListItem[];
  /**
   * Whether a further page exists, derived from reading one row past the page
   * rather than from a second `COUNT(*)`. An exact total would cost a full index
   * scan on every page view, and no screen in the product displays one.
   */
  hasMore: boolean;
}

export interface CreateProjectParams {
  orgId: string;
  name: string;
  slug: string;
  description?: string | null | undefined;
  createdBy: string;
}

export interface UpdateProjectParams {
  name?: string | undefined;
  description?: string | null | undefined;
}

/**
 * Creates a project.
 *
 * Slug uniqueness is scoped to the organisation by `projects_org_slug_idx`,
 * which is partial (`WHERE deleted_at IS NULL`). A soft-deleted project
 * therefore releases its slug immediately and a new project may take it — which
 * in turn means `restoreProject` can fail with a conflict later. That is the
 * deliberate trade: a slug appears in `.xecret.yaml` and in CI configuration, so
 * holding it hostage to a deleted project would be worse than a rare restore
 * failure the caller can resolve by renaming.
 *
 * `ON CONFLICT DO NOTHING` lets the index arbitrate: an empty `RETURNING` is the
 * conflict signal. A `SELECT` first and then an `INSERT` would leave a window in
 * which two concurrent requests both see "free" and both proceed.
 */
export async function createProject(
  exec: Executor,
  params: CreateProjectParams,
): Promise<ProjectRecord> {
  const [row] = await exec
    .insert(projects)
    .values({
      id: uuidv7(),
      orgId: params.orgId,
      name: params.name,
      slug: params.slug,
      description: params.description ?? null,
      createdBy: params.createdBy,
    })
    .onConflictDoNothing()
    .returning();

  if (!row) {
    throw new RepositoryError(
      'conflict',
      `A project with slug "${params.slug}" already exists in this organisation`,
    );
  }

  return row;
}

/** Resolves a project by its org-scoped slug. Returns `undefined` if absent. */
export async function findProjectBySlug(
  exec: Executor,
  orgId: string,
  slug: string,
): Promise<ProjectRecord | undefined> {
  const [row] = await exec
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.slug, slug), isNull(projects.deletedAt)))
    .limit(1);

  return row;
}

/**
 * Resolves a project by id.
 *
 * The `org_id` predicate is not redundant with the primary key: it is the whole
 * point. A caller that has an id from a URL has proved nothing about who owns it.
 */
export async function findProjectById(
  exec: Executor,
  orgId: string,
  projectId: string,
): Promise<ProjectRecord | undefined> {
  const [row] = await exec
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);

  return row;
}

/**
 * Lists an organisation's projects with the number of live environments in each.
 *
 * The count is a `LEFT JOIN` plus `GROUP BY` in the same statement rather than a
 * follow-up query per project. At twenty projects an N+1 is merely wasteful; in
 * a Worker holding a single pooled connection it is a queue.
 */
export async function listProjects(
  exec: Executor,
  orgId: string,
  page: PageRequest = {},
): Promise<ProjectPage> {
  const pageSize = clampPageSize(page.pageSize);
  const offset = Math.max((page.page ?? 1) - 1, 0) * pageSize;

  const rows = await exec
    .select({ ...getTableColumns(projects), environmentCount: count(environments.id) })
    .from(projects)
    .leftJoin(
      environments,
      and(eq(environments.projectId, projects.id), isNull(environments.deletedAt)),
    )
    .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
    .groupBy(projects.id)
    // `id` breaks ties: UUIDv7 is time-ordered, so two projects created in the
    // same millisecond still get a stable order and pages cannot overlap.
    .orderBy(desc(projects.createdAt), desc(projects.id))
    .limit(pageSize + 1)
    .offset(offset);

  return { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

/**
 * Updates a project's display fields.
 *
 * `slug` is deliberately not updatable. It is the identifier users commit to
 * `.xecret.yaml` and paste into CI configuration, so a rename would silently
 * break every consumer that is not redeployed at the same instant. Renaming is a
 * create-and-migrate operation the product surfaces explicitly, not an `UPDATE`.
 */
export async function updateProject(
  exec: Executor,
  orgId: string,
  projectId: string,
  params: UpdateProjectParams,
): Promise<ProjectRecord> {
  if (params.name === undefined && params.description === undefined) {
    // Nothing to change. Returning early rather than issuing a bare `updated_at`
    // touch keeps "last modified" meaningful in the UI.
    const current = await findProjectById(exec, orgId, projectId);
    if (!current) throw new RepositoryError('notFound', `Project ${projectId} not found`);
    return current;
  }

  const patch: Partial<typeof projects.$inferInsert> = {};
  if (params.name !== undefined) patch.name = params.name;
  if (params.description !== undefined) patch.description = params.description;

  const [row] = await exec
    .update(projects)
    // `now()` is applied by the database rather than passed as a JavaScript
    // `Date`, so the timestamp is the server's and not the Worker's — the two
    // clocks are not the same, and "last modified" ordering must not depend on
    // which isolate happened to serve the write. Set inline because the column
    // then holds a `SQL` expression, which the insert-shaped `patch` cannot type.
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId), isNull(projects.deletedAt)))
    .returning();

  if (!row) throw new RepositoryError('notFound', `Project ${projectId} not found`);

  return row;
}

/**
 * Marks a project deleted.
 *
 * Never a hard `DELETE`: the audit records referencing this project must keep
 * pointing at a row that still exists, and cryptographic erasure of the contained
 * secrets is a separate, explicit operation on `env_keys` — not a side effect of
 * clicking delete in a dashboard.
 */
export async function softDeleteProject(
  exec: Executor,
  orgId: string,
  projectId: string,
): Promise<ProjectRecord> {
  const [row] = await exec
    .update(projects)
    // `now()` rather than a JS `Date`: the Worker's clock is not the database's,
    // and a deletion timestamp that disagrees with the audit record next to it
    // is the kind of thing an incident review cannot explain away.
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId), isNull(projects.deletedAt)))
    .returning();

  if (!row) throw new RepositoryError('notFound', `Project ${projectId} not found`);

  return row;
}

/**
 * Restores a soft-deleted project.
 *
 * Fails with `conflict` when another project has taken the slug in the meantime.
 * The partial unique index is what detects that; there is deliberately no
 * pre-flight `SELECT`, because between that check and this `UPDATE` a concurrent
 * `createProject` could claim the slug anyway.
 */
export async function restoreProject(
  exec: Executor,
  orgId: string,
  projectId: string,
): Promise<ProjectRecord> {
  try {
    const [row] = await exec
      .update(projects)
      .set({ deletedAt: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(projects.orgId, orgId),
          eq(projects.id, projectId),
          sql`${projects.deletedAt} is not null`,
        ),
      )
      .returning();

    if (!row) throw new RepositoryError('notFound', `No deleted project ${projectId} to restore`);

    return row;
  } catch (error) {
    // Matched by constraint name, not merely by SQLSTATE: this statement can only
    // fail this way for one reason, and naming it means a second unique index
    // added later cannot be silently reported as a slug collision.
    if (isUniqueViolation(error, 'projects_org_slug_idx')) {
      throw new RepositoryError(
        'conflict',
        `The slug of project ${projectId} has been taken by another project; rename that project first`,
      );
    }
    throw error;
  }
}
