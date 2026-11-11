import { actorId } from '@/server/actor';
import { requireAdmin } from '@/server/admin';
import { removeAdmin } from '@/server/admin-users';
import { errors } from '@/server/errors';
import { noContent } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { isUuid } from '@/server/schemas/ids';

/**
 * `POST /api/admin/admins/{userId}/remove` — that account is no longer an
 * admin, from its next request on. Never the last admin: there is always
 * somebody who can reach this page. An admin may remove themselves. Every
 * admin, and the one removed, is emailed about it.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */

type Params = { userId: string };

export const POST = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const admin = await requireAdmin(services, principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));
  if (!isUuid(params.userId)) throw errors.notFound('malformed user id');
  await removeAdmin(services, admin, params.userId);
  return noContent();
});
