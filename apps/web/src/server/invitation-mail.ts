import { INVITATION_TTL_MS } from '@xecret/core/auth';
import type { MailMessage } from './mail';

/**
 * The invitation email — the second of the two mails xecret sends.
 *
 * The same discipline as `pin-reset-mail.ts`: a link, an expiry, a sentence for
 * the person who did not expect it, and nothing else. What it deliberately
 * *does* include is who sent it and which organisation it opens — an invitation
 * that does not say who is asking reads as phishing, and training recipients to
 * click anonymous credential links would be a strange thing for a secrets
 * manager to do.
 *
 * What is never here: the invitee's role (a permission detail that can change
 * before they accept), any member list, and any secret-adjacent fact about the
 * organisation beyond its display name.
 */

export interface InvitationMailParams {
  to: string;
  organizationName: string;
  /** How the inviter should read in the mail — display name or address. */
  inviterLabel: string;
  /** The fully-qualified acceptance URL, token included. */
  url: string;
}

const DAYS = Math.round(INVITATION_TTL_MS / (24 * 60 * 60 * 1000));

export function invitationMail(params: InvitationMailParams): MailMessage {
  const text = [
    'Hello,',
    '',
    `${params.inviterLabel} has invited you to join ${params.organizationName} on xecret,`,
    'a secret manager for development teams.',
    '',
    'Open this link to accept:',
    params.url,
    '',
    `The link works once and expires in ${DAYS} days. Signing in with this email`,
    'address is required — the invitation is addressed to you, not to the link.',
    '',
    'If you were not expecting this, you can ignore this email. Nothing is',
    'shared with you unless you accept.',
    '',
    '— xecret',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1e21;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hello,</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;">
        <strong>${escapeHtml(params.inviterLabel)}</strong> has invited you to join
        <strong>${escapeHtml(params.organizationName)}</strong> on xecret, a secret manager
        for development teams.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(params.url)}"
           style="display:inline-block;background:#1c1e21;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:500;">
          Accept the invitation
        </a>
      </p>
      <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#6b7078;">
        Or paste this into your browser:<br />
        <span style="word-break:break-all;">${escapeHtml(params.url)}</span>
      </p>
      <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#6b7078;">
        The link works once and expires in ${DAYS} days. Signing in with this email address
        is required — the invitation is addressed to you, not to the link.
      </p>
      <hr style="border:0;border-top:1px solid #e3e5e8;margin:0 0 24px;" />
      <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7078;">
        If you were not expecting this, you can ignore this email. Nothing is shared with
        you unless you accept.
      </p>
    </div>
  </body>
</html>`;

  return {
    to: params.to,
    subject: `Join ${params.organizationName} on xecret`,
    text,
    html,
  };
}

/**
 * Escapes every interpolated value. The organisation name and the inviter label
 * are both chosen by users; the URL is server-built — escaping all three is
 * what makes that distinction something nobody has to keep remembering.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
