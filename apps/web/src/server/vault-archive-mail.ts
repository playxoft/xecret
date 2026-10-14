import type { ArchiveFile } from '@xecret/core/vault-archive';
import type { MailMessage } from './mail';

/**
 * The two mails a vault reset sends.
 *
 * ── The archive mail ──
 * One per archive part, each carrying that part as a `.zip` attachment. The
 * product owner decided on 2026-10-12 that the archive is emailed, and accepted
 * the risk that the inbox becomes a permanent, offline-attackable copy of the
 * vault. That risk is the first thing the mail says — before what the file is
 * for — because the person reading it decides there and then whether to leave it
 * sitting in an inbox that is backed up, indexed and forwarded.
 *
 * ── The notice ──
 * Sent instead when the reset goes ahead without an archive — the vault was too
 * large to email — so that the inbox still records that the reset happened, and
 * the seven-day window is stated somewhere the person will find it.
 *
 * Neither mail ever contains a secret value, a name of a secret, or anything
 * that is not already in the attached ciphertext. The organisation, project and
 * environment names are in the archive (spec §14.4) and deliberately not
 * repeated in the body.
 */

export interface ArchiveMailParams {
  to: string;
  part: number;
  parts: number;
  file: ArchiveFile;
  /** When the old vault stops being recoverable in the app. */
  retainedUntil: Date;
  /** The deployment's public origin, for the links. */
  origin: string;
}

function formatWhen(when: Date): string {
  return `${when.toISOString().slice(0, 16).replace('T', ' at ')} UTC`;
}

export function vaultArchiveMail(params: ArchiveMailParams): MailMessage {
  const partLabel = params.parts > 1 ? ` (part ${params.part} of ${params.parts})` : '';
  const until = formatWhen(params.retainedUntil);

  const text = [
    'Hello,',
    '',
    `Your xecret vault was reset. Attached${partLabel} is an encrypted copy of the`,
    'secrets it could open, as xecret stored them.',
    '',
    'READ THIS FIRST: anyone who gets this email or the attachment can try to',
    'guess your old master passphrase on their own computers, as fast and for as',
    'long as they like. There is no rate limit and no lockout, and no deletion or',
    'revocation can take that away. A strong passphrase holds; a weak one will',
    'not. Save the attachment somewhere private, then delete this email.',
    '',
    "The attachment opens only with the old vault's master passphrase or one of",
    'its unused recovery codes. Nobody else can open it — not xecret.',
    ...(params.parts > 1
      ? [
          '',
          `This is part ${params.part} of ${params.parts}. Each part arrives in its own email, holds`,
          'different secrets, and opens on its own.',
        ]
      : []),
    '',
    `Until ${until} you can also recover the old vault itself in`,
    'xecret, with the same passphrase or a recovery code:',
    `${params.origin}/app/settings/security`,
    '',
    'To open the attachment:',
    '  - offline, with no account: xecret vault open-archive <file>',
    '  - in xecret: open a project and choose "Import archive"',
    '',
    `More: ${params.origin}/docs/security/vault-archive`,
    '',
    'If you did not reset your vault, sign in and change your password now.',
    '',
    '— xecret',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1e21;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hello,</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
        Your xecret vault was reset. Attached${escapeHtml(partLabel)} is an encrypted copy of the
        secrets it could open, as xecret stored them.
      </p>
      <div style="margin:0 0 20px;padding:16px;border:1px solid #f0b4b4;background:#fdf2f2;border-radius:8px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:#7a1c1c;">
          <strong>Read this first:</strong> anyone who gets this email or the attachment can try to
          guess your old master passphrase on their own computers, as fast and for as long as they
          like. There is no rate limit and no lockout, and no deletion or revocation can take that
          away. A strong passphrase holds; a weak one will not. Save the attachment somewhere
          private, then delete this email.
        </p>
      </div>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
        The attachment opens only with the old vault’s master passphrase or one of its unused
        recovery codes. Nobody else can open it — not xecret.
      </p>
      ${
        params.parts > 1
          ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">This is part ${params.part} of ${params.parts}. Each part arrives in its own email, holds different secrets, and opens on its own.</p>`
          : ''
      }
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
        Until <strong>${escapeHtml(until)}</strong> you can also
        <a href="${escapeHtml(params.origin)}/app/settings/security">recover the old vault itself</a> in
        xecret, with the same passphrase or a recovery code.
      </p>
      <p style="margin:0 0 8px;font-size:15px;line-height:1.6;">To open the attachment:</p>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;">
        <li>offline, with no account: <code>xecret vault open-archive &lt;file&gt;</code></li>
        <li>in xecret: open a project and choose “Import archive”</li>
      </ul>
      <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#6b7078;">
        <a href="${escapeHtml(params.origin)}/docs/security/vault-archive">What this archive is, and how to keep it safe</a>
      </p>
      <hr style="border:0;border-top:1px solid #e3e5e8;margin:0 0 24px;" />
      <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7078;">
        If you did not reset your vault, sign in and change your password now.
      </p>
    </div>
  </body>
</html>`;

  return {
    to: params.to,
    subject:
      params.parts > 1
        ? `Your xecret vault archive, part ${params.part} of ${params.parts}`
        : 'Your xecret vault archive',
    text,
    html,
    attachments: [
      { name: params.file.fileName, mimeType: 'application/zip', content: params.file.bytes },
    ],
  };
}

export interface ResetNoticeParams {
  to: string;
  retainedUntil: Date;
  origin: string;
}

/** The notice sent when a reset goes ahead without an archive: the vault was too large to email. */
export function vaultResetNoticeMail(params: ResetNoticeParams): MailMessage {
  const until = formatWhen(params.retainedUntil);

  const text = [
    'Hello,',
    '',
    'Your xecret vault was reset. It holds more than an email can carry, so no',
    'archive is attached.',
    '',
    `Until ${until} you can recover the old vault in xecret with its`,
    'master passphrase or one of its recovery codes:',
    `${params.origin}/app/settings/security`,
    '',
    'After that, xecret deletes it.',
    '',
    'If you did not reset your vault, sign in and change your password now.',
    '',
    '— xecret',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1e21;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hello,</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
        Your xecret vault was reset. It holds more than an email can carry, so no archive is
        attached.
      </p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
        Until <strong>${escapeHtml(until)}</strong> you can
        <a href="${escapeHtml(params.origin)}/app/settings/security">recover the old vault</a> in xecret
        with its master passphrase or one of its recovery codes. After that, xecret deletes it.
      </p>
      <hr style="border:0;border-top:1px solid #e3e5e8;margin:0 0 24px;" />
      <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7078;">
        If you did not reset your vault, sign in and change your password now.
      </p>
    </div>
  </body>
</html>`;

  return { to: params.to, subject: 'Your xecret vault was reset', text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
