import { contactSink } from '@/server/discord';
import { json, parseJsonBody } from '@/server/http';
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
 *  1. **Rate limit, before the body is read.** Keyed on the caller's address
 *     alone, because there is no account to key on — see `RL_CONTACT` for why it
 *     is a separate bucket from `RL_MUTATION`. First, so a flood costs us a
 *     counter increment rather than a JSON parse and an outgoing fetch.
 *  2. **Schema validation**, which bounds every field and refuses a body that is
 *     not an enquiry.
 *  3. **A honeypot**, answered with the same 202 a real submission gets.
 *  4. **Mention-stripping and truncation** in the sink, which is where the
 *     untrusted string finally meets a third party.
 *
 * ── Why the response never says whether delivery happened ──
 * It says the message was accepted, and that is true the moment validation
 * passes. Reporting the webhook's own status back would let a caller use this
 * endpoint to probe whether our Discord integration is up, and would make a
 * transient 500 from a third party look to the sender like their message was
 * rejected — so they send it again, and we get two.
 *
 * ── Why `unbackedRoute` and not `publicRoute` ──
 * This endpoint reads no rows and unwraps no keys, and `publicRoute` opens a
 * database handle and resolves the Root KEK before the handler runs. That would
 * make the contact form fail whenever the database is unreachable — and people
 * reach for a contact form *because* something is broken. A form that is down
 * for the same reason as the product is a form that is missing when it matters.
 *
 * The one exception is a *missing* binding, which surfaces as a 503 through the
 * route wrapper's `MissingBindingError` handling. That is not a third party
 * failing; it is this deployment being unconfigured, and a contact form that
 * silently swallows enquiries because nobody set the webhook is the worst
 * outcome available here.
 */
export const POST = unbackedRoute(async ({ request, env, meta, log }) => {
  await enforce(env, 'RL_CONTACT', rateLimitKey([meta.ipAddress]));

  const body = await parseJsonBody(request, contactSchema);

  // Filled in means a bot: the field is hidden from sight and from assistive
  // technology, so nobody can have typed in it. Answered exactly like a real
  // submission — an author who learns which field gave them away simply stops
  // filling it in.
  if (body.website !== undefined && body.website.trim().length > 0) {
    log.at('contact').info('honeypot tripped');
    return json({ accepted: true }, { status: 202 });
  }

  await contactSink(env).deliver({
    name: body.name,
    email: body.email,
    company: body.company,
    message: body.message,
    // Taken from our own header rather than from the body, so a caller cannot
    // write the provenance line in a message a human is about to read.
    source: request.headers.get('referer') ?? 'direct',
  });

  log.at('contact').info('enquiry delivered');

  return json({ accepted: true }, { status: 202 });
});
