import { requireBinding } from './bindings';
import type { Bindings } from './bindings';
import { errorName, scrubText } from './logging';

/**
 * The contact form's delivery channel.
 *
 * ── Why a webhook and not an inbox ──
 * Because the alternative that looks more professional is worse. A sales inbox
 * that nobody has agreed to watch is where an enquiry goes to sit for a week;
 * the channel a small team already has open is where one gets answered. This is
 * built to the same rule as `mail.ts`: the narrowest thing that can deliver one
 * kind of message, behind an interface, so replacing Discord with Slack, an
 * inbox or a database table is one class rather than a refactor.
 *
 * ── The threat this file exists to handle ──
 * Everything posted here is written by a stranger, and the destination renders
 * markdown, resolves mentions and unfurls links for a human who is inclined to
 * trust what their own team channel shows them. So the untrusted string is never
 * handed over intact:
 *
 *  1. **Mentions cannot fire.** `allowed_mentions: { parse: [] }` is on every
 *     request, and it is the control — not the escaping below it. Without it,
 *     `@everyone` in a message body pings a whole server, which turns a public
 *     form into a free notification cannon.
 *  2. **Markdown cannot restructure the message.** Field values are fenced
 *     inside embed fields rather than concatenated into content, so a body full
 *     of `#` headings and `[text](url)` cannot forge the labels around it or
 *     present a link as something it is not.
 *  3. **Nothing is unbounded.** Discord rejects an oversized payload with a
 *     400 that says nothing useful, and an attacker who can make our request
 *     fail can make every *other* enquiry fail with it. Each field is truncated
 *     here, to limits below Discord's own.
 *
 * ── What is never sent ──
 * No session token, no credential, no database identifier. A contact message is
 * the one payload in this product that leaves it for a third party, and it
 * carries exactly what the person typed plus the time they typed it.
 */

/** What a submitted form becomes, after validation. */
export interface ContactMessage {
  /** Why they are writing, as a label a person reads. See `CONTACT_REASONS`. */
  reason: string;
  name: string;
  email: string;
  /** Optional: most enquiries give one, and none is a fine answer. */
  company?: string | undefined;
  message: string;
  /** Which page the enquiry came from, so a reply can pick up the thread. */
  source?: string | undefined;
}

export interface ContactSink {
  deliver(message: ContactMessage): Promise<void>;
}

/**
 * Raised when delivery fails.
 *
 * The provider's body is kept for the log and never returned to the caller, for
 * the reason `MailDeliveryError` gives: a webhook's error text can echo the
 * payload, and an endpoint that reflected it would hand an attacker a way to
 * read back what our own request looked like.
 */
export class ContactDeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Contact delivery failed with ${status}`);
    this.name = 'ContactDeliveryError';
  }
}

/**
 * Field caps, all comfortably under Discord's.
 *
 * Discord allows 256 for an embed field name and 1024 for its value, and 6000
 * across the whole embed. These are smaller because the point is not to fit —
 * it is that a message longer than this is not an enquiry, and truncating it
 * costs a real sender nothing while costing a flooder the thing they wanted.
 */
const LIMITS = {
  name: 100,
  email: 254,
  company: 100,
  message: 1_800,
  source: 200,
  reason: 60,
} as const;

/**
 * Trims one untrusted value to something safe to render, without redacting it.
 *
 * Backticks become apostrophes rather than being escaped: they are the one
 * character that can break out of an inline-code span, and no legitimate
 * enquiry needs one. Control characters go because a message containing a
 * newline run or a bidi override can forge the layout of the embed around it.
 */
function plain(value: string | undefined, max: number): string {
  const clean = (value ?? '')
    // C0 and C1 controls, then the bidirectional overrides. The second set is
    // the less obvious half and the more useful one: U+202E reverses the
    // rendering of everything after it, which is how a value forges the label
    // sitting beside it in a channel somebody already trusts.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replaceAll('`', "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length === 0) return '—';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * As `plain`, and then redacted the way a log line is.
 *
 * `scrubText` masks anything shaped like a credential, which matters more here
 * than it looks: people paste API keys into contact forms while asking why one
 * does not work, and a channel full of other people's live credentials is a
 * breach we invited.
 *
 * ── Why the email field does NOT go through this ──
 * `scrubText` also replaces email addresses with `[redacted-email]`, which is
 * right for a log line and catastrophic here: the address is the entire point of
 * the message, and an enquiry that arrives with no way to reply to it has failed
 * at the only thing it had to do. It is validated by `contactSchema` and cleaned
 * by `plain`, which is the correct amount of handling for a value we asked for
 * on purpose.
 */
function scrubbed(value: string | undefined, max: number): string {
  const clean = plain(scrubText(value ?? ''), max);
  return clean;
}

/** Discord's webhook API, which is the only implementation we ship. */
export class DiscordContactSink implements ContactSink {
  constructor(private readonly webhookUrl: string) {}

  async deliver(message: ContactMessage): Promise<void> {
    const body = {
      // A bot username and avatar are deliberately not set: the webhook's own
      // configured identity is what the channel shows, so the message cannot
      // impersonate a person or another integration by choosing a name.
      embeds: [
        {
          // The reason is in the title rather than only in a field, so the
          // channel is scannable without opening anything: a security
          // questionnaire and a feature request should not look identical in a
          // list until somebody clicks both.
          title: `New enquiry · ${plain(message.reason, LIMITS.reason)}`,
          color: 0x5865f2,
          fields: [
            { name: 'Name', value: scrubbed(message.name, LIMITS.name), inline: true },
            // The one field that is not redacted; see the note on `scrubbed`.
            { name: 'Email', value: plain(message.email, LIMITS.email), inline: true },
            { name: 'Company', value: scrubbed(message.company, LIMITS.company), inline: true },
            { name: 'Message', value: scrubbed(message.message, LIMITS.message), inline: false },
            { name: 'From', value: scrubbed(message.source, LIMITS.source), inline: false },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
      // **The control.** Not decoration, and not redundant with the escaping
      // above it: an empty `parse` array tells Discord to resolve no mention of
      // any kind, so `@everyone` in a body is text. Removing this line turns a
      // public form into a way to ping a server.
      allowed_mentions: { parse: [] as string[] },
    };

    let response: Response;
    try {
      response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      // The URL is never in the message: it is the credential, and an error
      // string containing it would end up in a log line.
      throw new ContactDeliveryError(0, errorName(cause));
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ContactDeliveryError(response.status, detail.slice(0, 500));
    }
  }
}

/**
 * The sink for this deployment, or a `MissingBindingError`.
 *
 * Throwing rather than returning a no-op sink, deliberately. A silent success
 * on an unconfigured deployment means somebody's enquiry is accepted by the form
 * and read by nobody, which is the single worst outcome available to a contact
 * page — worse than the 503 an operator will notice.
 */
export function contactSink(env: Bindings): ContactSink {
  return new DiscordContactSink(requireBinding(env, 'DISCORD_CONTACT_WEBHOOK_URL'));
}
