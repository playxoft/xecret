import { sanitizeMetadataString } from '@xecret/core/audit';
import { requireBinding } from './bindings';
import type { Bindings } from './bindings';
import { errorName } from './logging';

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
 *  2. **Markdown cannot restructure the message.** Every value is escaped by
 *     `escapeMarkdown` before it goes anywhere near the payload.
 *
 *     This comment used to claim the opposite — that putting values in embed
 *     *fields* rather than in `content` was itself the defence. That is exactly
 *     backwards. Discord suppresses masked links in plain content and renders
 *     them inside embeds, so the structure this file chose for safety is the one
 *     place `[https://xecret.playxoft.com/admin](https://evil.example)` renders
 *     as a clickable link wearing our own domain as its label — in a channel
 *     whose only writer is our own contact form, read by somebody with every
 *     reason to trust it. Escaping is the control; the embed is just layout.
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
 * Field caps, against Discord's actual ones.
 *
 * Discord allows **1,024** characters in an embed field value, 4,096 in the
 * description, and 6,000 across the whole embed. The first of those is the
 * number that matters and the one this file previously got wrong: the comment
 * here claimed everything was "comfortably under" a 6,000 limit and set
 * `message` to 1,800, which is 776 over the field cap. It never showed, because
 * the sanitiser then in use truncated at 512 — so removing that hidden cap was
 * what turned a latent mistake into a 400 from Discord and a lost enquiry.
 *
 * `message` therefore lives in the **description**, not a field, which is the
 * only place in an embed a real enquiry fits. The rest are short by nature and
 * stay as fields.
 */
const LIMITS = {
  name: 100,
  email: 254,
  company: 100,
  /** The description's cap is 4,096; `contactSchema` refuses a body over 4,000. */
  message: 3_900,
  source: 200,
  reason: 60,
} as const;

/**
 * Characters Discord reads as markup.
 *
 * `[`, `]`, `(` and `)` are the important ones and the reason this function
 * exists: together they form a masked link, which renders inside an embed as
 * arbitrary text pointing at an arbitrary URL. The rest — emphasis, spoilers,
 * headings, quotes — cannot redirect anybody but can forge a label
 * ("**Verified Enterprise customer**") beside the real ones.
 *
 * The backslash is first in the class and therefore escaped first, which is what
 * stops `\[` in the input becoming an escaped backslash followed by a live
 * bracket.
 */
const MARKDOWN = /[\\*_~`>#[\]()|]/g;

/** Backslash-escapes anything Discord would otherwise render as markup. */
function escapeMarkdown(value: string): string {
  return value.replace(MARKDOWN, (character) => `\\${character}`);
}

/**
 * One untrusted value, made safe to store, to read and to render.
 *
 * `sanitizeMetadataString` is the same function every audit record in this
 * product passes through: it collapses control characters and bidi overrides to
 * spaces, redacts anything shaped like a credential or a high-entropy blob, and
 * truncates to the length it is given. People paste API keys into contact forms
 * while asking why one does not work, and a channel full of other people's live
 * credentials is a breach we invited.
 *
 * ── Why this replaced two functions ──
 * There were `plain` and `scrubbed`, because the web logger's `scrubText`
 * replaces email addresses with `[redacted-email]` — right for a log line, and
 * catastrophic for the one field an enquiry exists to carry. Splitting them made
 * the email safe and left a second, worse bug: `scrubText` also truncates at its
 * own `MAX_STRING` of 512, so `LIMITS.message` of 1,800 was never reached and
 * 87% of a maximum-length enquiry was silently dropped — under an ellipsis that
 * made it look deliberate. The core sanitiser has no hidden cap and does not
 * touch addresses, so one function serves every field.
 */
function field(value: string | undefined, max: number): string {
  const clean = sanitizeMetadataString(value ?? '', max);
  return clean.length === 0 ? '—' : clamp(escapeMarkdown(clean), max);
}

/**
 * Bounds the value **after** escaping, which is the only length that matters.
 *
 * ── Why this exists ──
 * `sanitizeMetadataString` truncates, then `escapeMarkdown` adds a byte per
 * markup character — so a 3,900-character enquiry could leave here at 7,799 and
 * be refused by Discord with a 400, losing it. `'*'.repeat(4000)` is the extreme
 * case and ordinary prose is not safe either: a pasted stack trace at roughly
 * seven per cent parentheses and underscores clears 4,096 on its own. Only 196
 * markup characters of headroom existed in a maximum-length message.
 *
 * This is the same defect as the one it replaced, one layer further in: a bound
 * applied to the wrong string. The first version measured before redaction
 * shortened the value; this one measured before escaping lengthened it.
 *
 * ── The trailing backslash ──
 * Cutting escaped text can land between a backslash and the character it
 * escapes, leaving a lone backslash that would escape the ellipsis instead — so
 * an odd run at the cut is trimmed. Counting the run rather than testing one
 * character matters because `\\` is an escaped backslash and is even.
 */
function clamp(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;

  let cut = escaped.slice(0, max - 1);
  let trailing = 0;
  while (trailing < cut.length && cut.at(-1 - trailing) === '\\') trailing += 1;
  if (trailing % 2 === 1) cut = cut.slice(0, -1);

  return `${cut}…`;
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
          title: `New enquiry · ${field(message.reason, LIMITS.reason)}`,
          color: 0x5865f2,
          fields: [
            { name: 'Name', value: field(message.name, LIMITS.name), inline: true },
            { name: 'Email', value: field(message.email, LIMITS.email), inline: true },
            { name: 'Company', value: field(message.company, LIMITS.company), inline: true },
            { name: 'From', value: field(message.source, LIMITS.source), inline: false },
          ],
          // The enquiry itself, in the description rather than in a field: a
          // field value is capped at 1,024 and this one is allowed 4,096, which
          // is the difference between delivering what somebody wrote and
          // delivering a quarter of it — or, once the field cap is crossed,
          // delivering nothing and answering them with a 503.
          description: field(message.message, LIMITS.message),
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
