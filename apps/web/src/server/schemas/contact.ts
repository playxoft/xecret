import * as z from 'zod/mini';

import { CONTACT_LIMITS } from '@/lib/contact';

/**
 * The contact form's request body.
 *
 * ── Why the bounds are here and again in `discord.ts` ──
 * They are not the same bound doing the same job twice. These reject: a body
 * over the limit is a 422 telling the sender to shorten it, which is the honest
 * answer to somebody who pasted too much. The ones in the sink truncate: by then
 * the message has been accepted and the only question left is what fits in the
 * channel, and refusing at that point would lose an enquiry we already promised
 * to deliver. Validation answers the caller; truncation protects the transport.
 *
 * The bounds themselves live in `lib/contact.ts`, because the form needs them
 * for its `maxLength` attributes and the form is a client component — importing
 * them from here would pull `zod/mini` into a public page's bundle.
 */

export { CONTACT_LIMITS };

/**
 * Deliberately not a full RFC 5322 grammar.
 *
 * A regular expression that accepts every legal address is famously longer than
 * this file and still cannot tell you whether the mailbox exists. This checks
 * the shape a person expects to be checked — something, an `@`, something with a
 * dot — and lets delivery be the thing that finds out the rest. Over-strict
 * validation on an address field rejects real customers, which is a worse
 * failure than accepting a typo.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const contactSchema = z.object({
  name: z
    .string()
    .check(
      z.trim(),
      z.minLength(1, 'Tell us who you are.'),
      z.maxLength(CONTACT_LIMITS.name, `A name must be at most ${CONTACT_LIMITS.name} characters.`),
    ),
  email: z
    .string()
    .check(
      z.trim(),
      z.maxLength(CONTACT_LIMITS.email, 'That address is too long to be an address.'),
      z.regex(EMAIL_PATTERN, 'That does not look like an email address.'),
    ),
  company: z.optional(
    z
      .string()
      .check(
        z.trim(),
        z.maxLength(
          CONTACT_LIMITS.company,
          `A company name must be at most ${CONTACT_LIMITS.company} characters.`,
        ),
      ),
  ),
  message: z
    .string()
    .check(
      z.trim(),
      z.minLength(10, 'A sentence or two about what you need is enough.'),
      z.maxLength(
        CONTACT_LIMITS.message,
        `A message must be at most ${CONTACT_LIMITS.message.toLocaleString('en-GB')} characters.`,
      ),
    ),
  /**
   * A honeypot, and the only field here nobody is meant to fill in.
   *
   * Hidden from sight and from assistive technology, so a person never sees it
   * and a screen reader never announces it. A bot that fills every input it
   * finds fills this one too, and the route answers a cheerful 202 without
   * delivering anything — a refusal that tells the author nothing is worth more
   * than one that teaches them which field to skip next time.
   *
   * Not a substitute for the rate limit; it costs nothing and catches the
   * laziest half.
   */
  website: z.optional(z.string()),
});

export type ContactRequest = z.infer<typeof contactSchema>;
