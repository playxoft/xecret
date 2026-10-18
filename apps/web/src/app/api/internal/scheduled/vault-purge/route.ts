import { deleteSpentSignInConfirmations } from '@xecret/db/repositories';
import { json } from '@/server/http';
import { describeError } from '@/server/logging';
import { publicRoute } from '@/server/route';
import { isScheduledRequest } from '@/server/scheduled';
import { purgeRetainedVaults } from '@/server/vault-purge';

/**
 * The hourly housekeeping, reachable only from the Worker's own Cron Trigger
 * (`worker.ts`, `server/scheduled.ts`): the retained-vault purge, and the
 * spent sign-in confirmations.
 *
 * Anything else — every request from the internet — gets a bare 404 with no
 * body, decided before anything is built: no service context, no database
 * connection, no log line, no request id. It carries no nonce minted for a
 * scheduled run in this isolate, and outside such a run there is none to
 * carry, so the only work an outside request can cause here is one header
 * comparison.
 *
 * There is no route in the product that deletes a retained vault early, and
 * this is not one either: it deletes only vaults whose seven days are over, by
 * the database's own clock, and the database refuses anything else.
 *
 * ── Spent sign-in confirmations (review round 2) ──
 * Each held-back sign-in that was answered leaves one row in
 * `sign_in_confirmations`, the ledger that makes its cookie single-use. Once
 * the cookie's five minutes are over the row can stop nothing — the cookie is
 * refused on its age first — so every row whose `expires_at` has passed is
 * deleted here. After the purge, and never allowed to fail it: a row left
 * over is 80 bytes until the next hour.
 */
const purge = publicRoute(async ({ services }) => {
  const purged = await purgeRetainedVaults(services);
  let signInConfirmations: number | null;
  try {
    signInConfirmations = await deleteSpentSignInConfirmations(services.db, new Date());
  } catch (cause) {
    services.log
      .at('scheduled')
      .error('Could not delete spent sign-in confirmations; they wait for the next run', {
        error: describeError(cause),
      });
    signInConfirmations = null;
  }
  return json({ purged, signInConfirmationsDeleted: signInConfirmations });
});

export async function POST(request: Request): Promise<Response> {
  if (!isScheduledRequest(request)) return new Response(null, { status: 404 });
  return purge(request);
}
