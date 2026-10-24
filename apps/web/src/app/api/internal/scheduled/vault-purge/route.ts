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
 * refused on its age first — so every row whose `expires_at` is
 * {@link SPENT_CONFIRMATION_MARGIN_MS} in the past is deleted here. After the
 * purge, and never allowed to fail it: a row left over is 80 bytes until the
 * next hour.
 */

/**
 * How long past its `expires_at` a spent confirmation is kept (review round
 * 3). The cookie's age is counted in whole seconds, so it is still accepted for
 * up to a second after the row says it expired, and the Worker that checks it
 * and the one that runs this job need not share a clock to the millisecond.
 * Deleting at the instant of expiry would leave that sliver in which a replay
 * of a cookie still accepted finds no row to stop it; a minute leaves none, and
 * costs nothing. (Not exported: a route file exports its handlers and
 * nothing else.)
 */
const SPENT_CONFIRMATION_MARGIN_MS = 60_000;

const purge = publicRoute(async ({ services }) => {
  const purged = await purgeRetainedVaults(services);
  let signInConfirmations: number | null;
  try {
    signInConfirmations = await deleteSpentSignInConfirmations(
      services.db,
      new Date(Date.now() - SPENT_CONFIRMATION_MARGIN_MS),
    );
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
