import { contactReasonLabel } from '@/lib/contact';
import { publicOrigin } from '@/server/bindings';
import type { Bindings } from '@/server/bindings';
import { ContactDeliveryError, contactSink } from '@/server/discord';
import { errors } from '@/server/errors';
import { isSameOrigin, json, parseJsonBody } from '@/server/http';
import { errorName } from '@/server/logging';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { unbackedRoute } from '@/server/route';
import { contactSchema } from '@/server/schemas/contact';

/**
 * The contact form.
 *
 * ── The only unauthenticated write in the product ──
 * Everything else that changes state presents a credential first. This does not
 * and cannot: the whole point is that somebody who has never signed up can ask a
 * question. That makes it the endpoint most exposed to abuse and the one where
 * the controls have to be stated rather than inherited, so they are, in order:
 *
 *  1. **Same origin.** `publicRoute` does not check this and does not need to:
 *     its routes authenticate by other means. This one has no credential at all,
 *     so without the check any third-party page can `fetch` it with a
 *     CORS-safelisted content type, no preflight, and an opaque response it does
 *     not care about — and every visitor to that page posts an enquiry from
 *     *their own* address. The rate limit is keyed on the address, so it would
 *     stop bounding anything. There is no legitimate non-browser caller here,
 *     which is what makes the check free.
 *  2. **Rate limit, before the body is read.** Keyed on the caller's address,
 *     because there is no account to key on — see `RL_CONTACT` for why it is a
 *     separate bucket from `RL_MUTATION`. Early, so a flood costs a counter
 *     increment rather than a JSON parse and an outgoing fetch.
 *  3. **Schema validation**, which bounds every field and refuses a body that is
 *     not an enquiry.
 *  4. **A honeypot**, answered with the same 202 a real submission gets.
 *  5. **Redaction, markdown escaping and truncation** in the sink, which is
 *     where the untrusted string finally meets a third party.
 *
 * ── Why a failed delivery is reported, and what that costs ──
 * This header used to argue the opposite: that the response should say only
 * "accepted", because reporting the provider's status turns the endpoint into a
 * probe for whether our Discord integration is up. That is true, and it is worth
 * almost nothing next to what it buys — somebody's enquiry disappearing while
 * the page tells them it arrived, which is the worst outcome a contact form has.
 * A form that visibly fails gets tried again or gets mailed; one that silently
 * succeeds gets neither.
 *
 * So a delivery failure answers 503 and names the alternative. What it does not
 * name is the provider, the status it returned, or anything else about why —
 * that detail goes to the log, where the person who can act on it will look.
 *
 * ── Why `unbackedRoute` and not `publicRoute` ──
 * This endpoint reads no rows and unwraps no keys, and `publicRoute` opens a
 * database handle and resolves the Root KEK before the handler runs. That would
 * make the contact form fail whenever the database is unreachable — and people
 * reach for a contact form *because* something is broken. A form that is down
 * for the same reason as the product is a form that is missing when it matters.
 *
 * A missing webhook binding surfaces as a 503 through the wrapper's
 * `MissingBindingError` handling. That is not a third party failing; it is this
 * deployment being unconfigured, and a contact form that silently swallows
 * enquiries because nobody set the webhook is the worst outcome available here.
 */
export const POST = unbackedRoute(async ({ request, env, meta, log }) => {
  if (!isSameOrigin(request, publicOrigin(env))) {
    throw errors.forbidden('This endpoint accepts requests from the xecret site only.');
  }

  // The address, or the user agent behind it. An absent `CF-Connecting-IP` — a
  // self-hosted deployment behind another proxy, or `next dev` — would otherwise
  // collapse every caller into one bucket keyed on `-`, where a single sender
  // takes the contact form down for everybody. A user agent is a poor
  // discriminator and a deliberate one: it is load-bearing only in the case
  // where the good key is missing entirely.
  await enforce(
    env,
    'RL_CONTACT',
    rateLimitKey([meta.ipAddress ?? `ua:${meta.userAgent ?? 'unknown'}`]),
  );

  const body = await parseJsonBody(request, contactSchema);

  // Filled in means a bot: the field is hidden from sight and from assistive
  // technology, so nobody can have typed in it. Answered exactly like a real
  // submission — an author who learns which field gave them away simply stops
  // filling it in.
  if (body.website !== undefined && body.website.trim().length > 0) {
    log.at('contact').info('honeypot tripped');
    return json({ accepted: true }, { status: 202 });
  }

  try {
    await contactSink(env).deliver({
      // The label, not the id: the channel is read by a person, and `feature` is
      // a value where "A feature request" is a sentence.
      reason: contactReasonLabel(body.reason),
      name: body.name,
      email: body.email,
      company: body.company,
      message: body.message,
      source: sourcePage(request, env),
    });
  } catch (cause) {
    // The provider's own status and body, for the person who can fix it. Neither
    // reaches the caller: a webhook's error body can echo the payload back.
    const failed = cause instanceof ContactDeliveryError;
    log.at('contact').error('enquiry could not be delivered', {
      ...(failed ? { status: cause.status, detail: cause.detail } : {}),
      error: errorName(cause),
    });

    throw errors.contactUndeliverable(failed ? `discord ${cause.status}` : errorName(cause));
  }

  log.at('contact').info('enquiry delivered');

  return json({ accepted: true }, { status: 202 });
});

/**
 * Which page on our own site the enquiry came from.
 *
 * A `Referer` naming anywhere else — or naming nothing, or not a URL at all — is
 * reported as `external` rather than repeated. The header is trivially forged by
 * anything that is not a browser, and this value is rendered in a channel where
 * a person reads it as evidence of where somebody was standing when they wrote.
 * Echoing it verbatim let a script put `…/pricing — verified Enterprise trial`
 * in front of that reader.
 *
 * The path is kept and the origin dropped: once the same-origin check above has
 * passed, the origin is ours by definition and repeating it is noise.
 */
function sourcePage(request: Request, env: Bindings): string {
  const referer = request.headers.get('referer');
  if (referer === null) return 'direct';

  try {
    const url = new URL(referer);
    return url.origin === publicOrigin(env) ? `${url.pathname}${url.search}` : 'external';
  } catch {
    return 'external';
  }
}
