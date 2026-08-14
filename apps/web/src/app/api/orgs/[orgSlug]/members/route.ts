import { listMembers } from '@xecret/db/repositories';
import { json, parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { listQuery } from '@/server/schemas/secrets';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * Who is in this organisation.
 *
 * `member.read` is the capability, and every active role holds it — a developer
 * needs to know who to ask for production access as much as an owner needs to
 * know who has it. A *suspended* member holds nothing, which is the case this
 * check is really settling: `resolveOrg` proves membership exists, and
 * `authorize` proves it is still active.
 *
 * ── What is returned, and what is not ──
 * Name, email, role, status, and when they joined. Emails are visible to
 * everyone in the organisation on purpose: they are how members are invited and
 * how they are identified in the audit log, so hiding them here would hide
 * nothing while making the list unusable for the thing it is for.
 *
 * Access *grants* are not here. "Who may read production" is a different and
 * more sensitive question than "who is in this organisation", it is per-project,
 * and answering it in a list endpoint would mean a query per member. It belongs
 * on the member's own page.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'member.read');

  const { limit, cursor } = parseQuery(request, listQuery);
  const page = cursor ?? 1;

  const members = await listMembers(services.db, scope.organization.id, {
    page,
    ...(limit === undefined ? {} : { pageSize: limit }),
  });

  return json({
    data: members.members.map((member) => ({
      id: member.id,
      userId: member.userId,
      email: member.user.email,
      displayName: member.user.displayName,
      avatarUrl: member.user.avatarUrl,
      role: member.role,
      status: member.status,
      joinedAt: member.createdAt.toISOString(),
      /**
       * True for the caller's own row, so the UI can mark it and refuse
       * self-removal. Always false for a service token, which acts as nobody
       * and therefore cannot be looking at itself.
       */
      isYou: scope.actor.kind !== 'serviceToken' && member.userId === scope.actor.userId,
    })),
    // Offset pagination behind an opaque cursor, exactly as the secret listing
    // does — see the note in `schemas/secrets.ts`. A client that does arithmetic
    // on this breaks the day it becomes a keyset cursor.
    nextCursor: members.hasMore ? String(page + 1) : null,
  });
});
