import { PIN_RESET_TTL_MS } from '@xecret/core/auth';
import type { MailMessage } from './mail';

/**
 * The one email xecret sends.
 *
 * ── What is in it ──
 * A link, an expiry, and a sentence telling somebody who did not ask for it that
 * they can ignore it. Nothing else — no PIN, no secret, no session token, and no
 * account detail beyond the address it was sent to, which the recipient already
 * knows.
 *
 * ── Why both parts ──
 * A text/plain alternative is always sent. Plenty of people read mail in clients
 * that do not render HTML, and a security email that arrives as an unreadable
 * blob is one that gets deleted — which for a reset link means the account stays
 * locked out.
 *
 * ── Why the link is not a button-only design ──
 * The URL appears as text as well as behind the link. Mail clients rewrite and
 * wrap links, corporate scanners pre-fetch them, and a user who wants to check
 * where a security email is sending them before clicking should be able to.
 */

export interface PinResetMailParams {
  to: string;
  /** The recipient's display name, when the account has one. */
  toName: string | null;
  /** The fully-qualified reset URL, token included. */
  url: string;
}

const MINUTES = Math.round(PIN_RESET_TTL_MS / 60_000);

export function pinResetMail(params: PinResetMailParams): MailMessage {
  const greeting = params.toName === null ? 'Hello,' : `Hello ${params.toName},`;

  const text = [
    greeting,
    '',
    'You asked to reset the PIN that unlocks xecret on your devices.',
    '',
    'Open this link to choose a new one:',
    params.url,
    '',
    `The link works once and expires in ${MINUTES} minutes.`,
    '',
    'If you did not ask for this, you can ignore this email. Your PIN has not',
    'changed, and nobody can use this link without access to this mailbox.',
    '',
    '— xecret',
  ].join('\n');

  // Inline styles and a table-free layout: every mail client strips <style>
  // blocks, and a design that needs external CSS renders as unstyled text in
  // most of them. Kept plain enough that the unstyled fallback is still fine.
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1e21;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;">
        You asked to reset the PIN that unlocks xecret on your devices.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(params.url)}"
           style="display:inline-block;background:#1c1e21;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:500;">
          Choose a new PIN
        </a>
      </p>
      <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#6b7078;">
        Or paste this into your browser:<br />
        <span style="word-break:break-all;">${escapeHtml(params.url)}</span>
      </p>
      <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#6b7078;">
        The link works once and expires in ${MINUTES} minutes.
      </p>
      <hr style="border:0;border-top:1px solid #e3e5e8;margin:0 0 24px;" />
      <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7078;">
        If you did not ask for this, you can ignore this email. Your PIN has not changed,
        and nobody can use this link without access to this mailbox.
      </p>
    </div>
  </body>
</html>`;

  return {
    to: params.to,
    ...(params.toName === null ? {} : { toName: params.toName }),
    subject: 'Reset your xecret PIN',
    text,
    html,
  };
}

/**
 * Escapes the two interpolated values.
 *
 * The URL is server-constructed and the display name is user-controlled, so
 * only one of them can carry markup — but escaping both is what makes that
 * distinction something nobody has to remember. A display name of
 * `<img onerror=…>` renders as text in a mail client that runs it.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
