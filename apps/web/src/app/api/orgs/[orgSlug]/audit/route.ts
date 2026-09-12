import type { AuditAction } from '@xecret/core/audit';
import { findProjectBySlug, findEnvironmentBySlug, queryAuditLogs } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import {
  ACTOR_FILTER_LIMIT,
  auditQuerySchema,
  decodeAuditCursor,
  encodeAuditCursor,
  toAuditEvent,
} from '@/server/schemas/tokens';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * The audit log — who did what, when, from where, and whether it worked.
 *
 * `audit.read` gates it, which owners and admins hold and developers
 * deliberately do not: the log is an org-wide record that includes actions in
 * projects a developer cannot see, and every denial anyone ever received.
 *
 * Keyset pagination over `(created_at, id)`, exactly as §5 of the API contract
 * prescribes for this table — the one place offset pagination would visibly
 * corrupt under its own write load. The cursor is opaque; the queried window is
 * returned because the repository clamps it to ninety days, and a UI that
 * silently showed less than it was asked for would be lying.
 *
 * Filters arrive as slugs and resolve through the same tenant-filtered lookups
 * as everything else. A slug that resolves to nothing is an ordinary empty
 * result, not an error: the rows may reference projects that have since been
 * deleted, and the filter's job is to narrow, not to validate history.
 *
 * The actor filter takes several ids at once (`actorIds=a,b`), which the
 * organisation's own audit screen uses to answer "what did these two people
 * do". One query rather than one per person is not an optimisation: keyset
 * pages over different result sets cannot be interleaved into one chronology
 * afterwards.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'audit.read');
  const orgId = scope.organization.id;

  const query = parseQuery(request, auditQuerySchema);

  const project =
    query.projectSlug === undefined
      ? undefined
      : await findProjectBySlug(services.db, orgId, query.projectSlug);
  if (query.projectSlug !== undefined && project === undefined) {
    throw errors.notFound('no project with slug in organisation');
  }

  const environment =
    query.environmentSlug === undefined || project === undefined
      ? undefined
      : await findEnvironmentBySlug(services.db, orgId, project.id, query.environmentSlug);
  if (query.environmentSlug !== undefined && project !== undefined && environment === undefined) {
    throw errors.notFound('no environment with slug in project');
  }
  if (query.environmentSlug !== undefined && project === undefined) {
    // An environment slug is only meaningful inside a project.
    throw errors.badRequest('Filtering by environment requires a project.');
  }

  // `actorId` and `actorIds` are the same filter said two ways, so both are
  // honoured and merged. De-duplicated because `?actorId=a&actorIds=a,b` is a
  // reasonable thing for a client to send and `IN (a, a, b)` is not a reasonable
  // thing to send a database.
  const actorIds = [
    ...new Set([
      ...(query.actorId === undefined ? [] : [query.actorId]),
      ...(query.actorIds ?? []),
    ]),
  ];
  // The schema bounds `actorIds` at fifty, but the merge can add one more —
  // `?actorId=z&actorIds=<fifty>` arrives as fifty-one, past the bound that
  // exists so no `IN` list is unbounded. Refused with the schema's own sentence
  // rather than silently truncated: a filter that quietly drops a name is the
  // failure mode this whole screen is supposed to be immune to.
  if (actorIds.length > ACTOR_FILTER_LIMIT) {
    throw errors.badRequest(`Filter by at most ${ACTOR_FILTER_LIMIT} actors at a time.`);
  }

  const page = await queryAuditLogs(services.db, {
    orgId,
    actorIds,
    action: query.action as AuditAction | undefined,
    projectId: project?.id,
    environmentId: environment?.id,
    outcome: query.outcome,
    from: query.from === undefined ? undefined : new Date(query.from),
    to: query.to === undefined ? undefined : new Date(query.to),
    cursor: query.cursor === undefined ? undefined : decodeAuditCursor(query.cursor),
    pageSize: query.limit,
  });

  return json({
    data: page.items.map(toAuditEvent),
    nextCursor: page.nextCursor === null ? null : encodeAuditCursor(page.nextCursor),
    window: {
      from: page.window.from.toISOString(),
      to: page.window.to.toISOString(),
    },
  });
});
