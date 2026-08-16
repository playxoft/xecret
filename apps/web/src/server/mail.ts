import { requireBinding } from './bindings';
import type { Bindings } from './bindings';
import { errorName, scrubText } from './logging';

/**
 * Transactional email.
 *
 * xecret sends exactly one kind of mail today — a PIN reset link — and that
 * shapes every decision here. This is not a mailing system; it is the narrowest
 * thing that can deliver a link to the address on an account.
 *
 * ── The seam is the point ──
 * `Mailer` is an interface and ZeptoMail is one implementation of it. A
 * self-hoster on Postmark, SES or a plain SMTP relay replaces one class and
 * changes nothing else, which is the difference between an open-source project
 * and one that only runs on its author's vendor accounts.
 *
 * ── This spends one of six connections ──
 * A Worker invocation may open six outgoing connections (ADR 0006), and the
 * database already holds one. Sending mail is therefore never done inline with
 * a response the user is waiting for: the reset route hands this to `waitUntil`,
 * so the request returns while the send is still in flight.
 *
 * ── What is never in an email ──
 * No secret value, no PIN, no session token, and no statement about whether an
 * account exists. The reset mail contains a single-use link and nothing else
 * that would be useful to somebody who intercepted it after it had been used.
 */

export interface MailMessage {
  to: string;
  /** The recipient's display name, when one is known. */
  toName?: string | undefined;
  subject: string;
  /** Both bodies are always sent. A text/plain part is not optional. */
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * Raised when a send fails.
 *
 * The provider's response body is kept in `detail` for the log and never
 * returned to a caller: ZeptoMail echoes the recipient address in its errors,
 * and an API that reflected that would turn "did my mail fail?" into an account
 * enumeration oracle.
 */
export class MailDeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Mail delivery failed with status ${status}`);
    this.name = 'MailDeliveryError';
  }
}

/**
 * What a delivery failure is allowed to say in a log.
 *
 * ── Why this exists ──
 * Both mail call sites used to log the error's *class name* and nothing else,
 * on the reasoning that a provider's rejection embeds the recipient address.
 * That reasoning was sound and the result was useless: "MailDeliveryError" does
 * not distinguish a token issued in the wrong Zoho region from an unverified
 * sending domain from a malformed payload, and those have completely different
 * fixes. A person watching an inbox that stays empty got no further than the
 * operator reading the log did.
 *
 * The address is the only part that needed removing, and `scrubText` removes
 * it. What is left — the status and the provider's own explanation — is exactly
 * what makes the failure actionable.
 */
// A type alias rather than an interface, so it satisfies the logger's
// `Record<string, unknown>` — TypeScript gives aliases an implicit index
// signature and interfaces none, and this is passed straight in as log fields.
export type MailFailure = {
  error: string;
  /** The provider's HTTP status. Carries no personal data and names the class of fault. */
  status?: number;
  /** The provider's explanation, with any address stripped out. */
  detail?: string;
};

export function describeMailFailure(cause: unknown): MailFailure {
  if (cause instanceof MailDeliveryError) {
    return {
      error: cause.name,
      status: cause.status,
      detail: scrubText(cause.detail),
    };
  }
  return { error: errorName(cause) };
}

/**
 * ZeptoMail's default endpoint.
 *
 * Zoho runs one host per data centre and a token is only valid at the host it
 * was issued in, so an account created in the EU or India must set
 * `ZEPTOMAIL_API_URL` — otherwise every send fails authentication against a
 * region that has never heard of the token. That failure is confusing enough
 * that `check:env` calls it out by name.
 */
export const ZEPTOMAIL_DEFAULT_URL = 'https://api.zeptomail.com/v1.1/email';

const DEFAULT_FROM_NAME = 'xecret';

export interface ZeptoMailConfig {
  /** The Mail Agent's Send Mail token, *without* the `Zoho-enczapikey` prefix. */
  token: string;
  /** Must be on a domain verified in the ZeptoMail console. */
  fromAddress: string;
  fromName: string;
  apiUrl: string;
}

/**
 * ZeptoMail over its REST API rather than SMTP.
 *
 * A Worker cannot open a raw TCP socket to port 587, so SMTP is not on the
 * table regardless of preference — every mail provider used from an edge runtime
 * is used over HTTPS.
 */
export class ZeptoMailer implements Mailer {
  constructor(private readonly config: ZeptoMailConfig) {}

  async send(message: MailMessage): Promise<void> {
    const response = await fetch(this.config.apiUrl, {
      method: 'POST',
      headers: {
        // Zoho's own scheme name, not `Bearer`. The literal string
        // `Zoho-enczapikey ` prefixes the token, and a token pasted from the
        // console sometimes already includes it — so it is stripped on the way
        // in rather than duplicated here.
        authorization: `Zoho-enczapikey ${this.config.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        from: { address: this.config.fromAddress, name: this.config.fromName },
        to: [
          {
            email_address: {
              address: message.to,
              ...(message.toName === undefined ? {} : { name: message.toName }),
            },
          },
        ],
        subject: message.subject,
        textbody: message.text,
        htmlbody: message.html,
      }),
    });

    if (!response.ok) {
      // Read as text, not JSON: an error from a proxy in front of the API is
      // HTML, and a `json()` that throws would replace a useful log line with a
      // parse error.
      const detail = await response.text().catch(() => '<unreadable>');
      throw new MailDeliveryError(response.status, detail.slice(0, 500));
    }
  }
}

/**
 * Builds the mailer from bindings, or returns `null` when mail is not
 * configured.
 *
 * `null` rather than a throw, because email is optional. A self-hoster running
 * xecret for one team may reasonably not wire up a mail provider at all — the
 * PIN reset flow then reports that it is unavailable, and everything else in the
 * product works. Making mail a hard dependency would mean the whole deployment
 * fails to start over a feature most single-user installs never use.
 */
export function mailerFrom(env: Bindings): Mailer | null {
  const token = env.ZEPTOMAIL_TOKEN;
  const fromAddress = env.ZEPTOMAIL_FROM_ADDRESS;

  if (!token || !fromAddress) return null;

  return new ZeptoMailer({
    token: normaliseToken(token),
    fromAddress,
    fromName: env.ZEPTOMAIL_FROM_NAME || DEFAULT_FROM_NAME,
    apiUrl: env.ZEPTOMAIL_API_URL || ZEPTOMAIL_DEFAULT_URL,
  });
}

/** Throws `unavailable` instead of returning null, where a caller cannot proceed. */
export function requireMailer(env: Bindings): Mailer {
  const mailer = mailerFrom(env);
  if (mailer === null) {
    // Reported as a missing binding so it lands in the same 503 bucket as an
    // absent database: both mean "this deployment is not finished", which is a
    // different alert from "this code is broken".
    requireBinding(env, 'ZEPTOMAIL_TOKEN');
    requireBinding(env, 'ZEPTOMAIL_FROM_ADDRESS');
  }
  return mailer as Mailer;
}

/**
 * Accepts a token with or without the scheme prefix already attached.
 *
 * The ZeptoMail console shows the value as `Zoho-enczapikey wSsV…`, and copying
 * the whole line is the obvious thing to do. Without this, that produces a
 * doubled prefix and a 401 whose message says nothing about the cause.
 */
function normaliseToken(token: string): string {
  const trimmed = token.trim();
  const prefix = 'Zoho-enczapikey ';
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
}
