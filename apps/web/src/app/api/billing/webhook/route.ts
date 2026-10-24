import { receiveDodoWebhook } from '@/server/billing/webhook';
import { publicRoute } from '@/server/route';

/**
 * `POST /api/billing/webhook` — Dodo's payment events (P12).
 *
 * ── Why this is a `publicRoute`, with no session and no CSRF check ──
 * An unauthenticated mutation is otherwise a bug in this codebase, so the
 * reason is written here, where somebody grepping for one will find it.
 *
 * The caller is Dodo's servers, not a browser: there is no cookie to present,
 * no session to hold, and no page whose origin a CSRF check could compare. The
 * credential is the **signature** — HMAC-SHA256 over the raw body with
 * `DODO_WEBHOOK_SECRET`, Standard Webhooks — and it is checked before anything
 * is read from the body or written anywhere, together with a five-minute
 * replay window and a `webhook-id` the database will accept only once. That is
 * a stronger proof of origin than a session would be: a session proves who is
 * signed in, the signature proves the payload itself came from Dodo unaltered.
 *
 * `authenticatedRoute` would refuse every delivery (no credential), and its
 * CSRF check would refuse the rest (no `x-xecret-csrf`), so the exclusion is
 * not optional; `publicRoute` keeps everything else the wrapper guarantees —
 * the request id, the fixed error envelope, the completion line, the deferred
 * work held open until it has finished.
 *
 * Everything else is in `server/billing/webhook.ts`.
 */
export const POST = publicRoute(async ({ request, services }) =>
  receiveDodoWebhook(services, request),
);
