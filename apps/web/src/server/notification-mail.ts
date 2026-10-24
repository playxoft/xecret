import type { MailMessage } from './mail';

/**
 * The two security notices P19 sends to an organisation's owners and admins:
 * a webhook switched off for sustained failure (§5), and a digest of reads from
 * addresses and devices nobody had seen read that environment before (§7).
 *
 * ── What neither mail carries ──
 * No secret value and no secret name — a read alert says *where* an environment
 * was read from and by whom, never what was in it — and no webhook URL, whose
 * path or query routinely holds the receiver's own credential. The endpoint is
 * named by its host, as the audit log names it. Nothing here is a link that
 * does anything by being opened: each link is a settings page that asks the
 * reader to sign in first.
 *
 * Both a text and an HTML part, as every mail from this product has, in the
 * house layout `vault-archive-mail.ts` set.
 */

const SHELL_OPEN = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1e21;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:12px;padding:32px;">`;
const SHELL_CLOSE = `
    </div>
  </body>
</html>`;
const P = 'margin:0 0 16px;font-size:15px;line-height:1.6;';
const SMALL = 'margin:0;font-size:13px;line-height:1.6;color:#6b7078;';

export function formatWhen(when: Date): string {
  return `${when.toISOString().slice(0, 16).replace('T', ' at ')} UTC`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── a webhook switched off ───────────────────────────────────────────────── */

export interface WebhookDisabledMailParams {
  to: string;
  toName?: string | null | undefined;
  organizationName: string;
  /** The host the endpoint delivers to. Never the URL. */
  endpointHost: string;
  consecutiveFailures: number;
  failingSince: Date | null;
  /** Where it is switched back on: the organisation's settings. */
  settingsUrl: string;
}

export function webhookDisabledMail(params: WebhookDisabledMailParams): MailMessage {
  const since = params.failingSince === null ? null : formatWhen(params.failingSince);
  const failed =
    `${params.consecutiveFailures} deliveries in a row failed` + (since ? ` since ${since}` : '');

  const text = [
    'Hello,',
    '',
    `xecret has switched off a webhook in ${params.organizationName} that kept failing.`,
    '',
    `  Endpoint: ${params.endpointHost}`,
    `  ${failed}.`,
    '',
    'Nothing more will be sent to it, and the deliveries it was still owed have',
    'been given up. Your secrets are unaffected.',
    '',
    'Once the receiver is working again, switch the webhook back on in your',
    "organisation's settings — its delivery log shows what each attempt got back:",
    params.settingsUrl,
    '',
    'You are receiving this because you are an owner or admin of the organisation.',
    '',
    '— xecret',
  ].join('\n');

  const html = `${SHELL_OPEN}
      <p style="${P}">Hello,</p>
      <p style="${P}">
        xecret has switched off a webhook in <strong>${escapeHtml(params.organizationName)}</strong>
        that kept failing.
      </p>
      <p style="${P}">
        Endpoint: <strong>${escapeHtml(params.endpointHost)}</strong><br />
        ${escapeHtml(failed)}.
      </p>
      <p style="${P}">
        Nothing more will be sent to it, and the deliveries it was still owed have been given up.
        Your secrets are unaffected.
      </p>
      <p style="${P}">
        Once the receiver is working again,
        <a href="${escapeHtml(params.settingsUrl)}">switch the webhook back on</a> in your
        organisation’s settings — its delivery log shows what each attempt got back.
      </p>
      <hr style="border:0;border-top:1px solid #e3e5e8;margin:0 0 24px;" />
      <p style="${SMALL}">
        You are receiving this because you are an owner or admin of the organisation.
      </p>${SHELL_CLOSE}`;

  return {
    to: params.to,
    toName: params.toName ?? undefined,
    subject: `A webhook in ${params.organizationName} was switched off`,
    text,
    html,
  };
}

/* ── reads from somewhere new ─────────────────────────────────────────────── */

export interface ReadAlertSighting {
  projectSlug: string;
  environmentSlug: string;
  isProduction: boolean;
  /** Who read: an email, `email (device)`, or a service token's name. */
  who: string;
  /** A v4 address, or a v6 /64. */
  address: string;
  firstSeenAt: Date;
}

export interface ReadAlertDigestMailParams {
  to: string;
  toName?: string | null | undefined;
  organizationName: string;
  sightings: readonly ReadAlertSighting[];
  /** Each environment's settings, where its alerts are switched off. Keyed `project/environment`. */
  settingsUrls: ReadonlyMap<string, string>;
}

export function readAlertDigestMail(params: ReadAlertDigestMailParams): MailMessage {
  const count = params.sightings.length;
  const line = (sighting: ReadAlertSighting) =>
    `${sighting.projectSlug}/${sighting.environmentSlug}` +
    `${sighting.isProduction ? ' (production)' : ''} — ${sighting.who}, from ${sighting.address}, ` +
    `first seen ${formatWhen(sighting.firstSeenAt)}`;

  const settings = [...params.settingsUrls.entries()];

  const text = [
    'Hello,',
    '',
    count === 1
      ? `An environment in ${params.organizationName} was read from somewhere it had not been read from before:`
      : `Environments in ${params.organizationName} were read from ${count} places they had not been read from before:`,
    '',
    ...params.sightings.map((sighting) => `  - ${line(sighting)}`),
    '',
    'If you recognise these — a new laptop, a new CI runner — there is nothing to do.',
    'If you do not, revoke the credential that made the read and rotate what it',
    'could reach.',
    '',
    'At most one of these is sent an hour; anything newer is in the next one, and',
    "every read location is listed in the environment's settings. To stop these",
    'alerts for an environment, switch them off there:',
    ...settings.map(([name, url]) => `  ${name}: ${url}`),
    '',
    'You are receiving this because you are an owner or admin of the organisation.',
    '',
    '— xecret',
  ].join('\n');

  const html = `${SHELL_OPEN}
      <p style="${P}">Hello,</p>
      <p style="${P}">
        ${
          count === 1
            ? `An environment in <strong>${escapeHtml(params.organizationName)}</strong> was read from somewhere it had not been read from before:`
            : `Environments in <strong>${escapeHtml(params.organizationName)}</strong> were read from ${count} places they had not been read from before:`
        }
      </p>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.6;">
        ${params.sightings.map((sighting) => `<li>${escapeHtml(line(sighting))}</li>`).join('\n        ')}
      </ul>
      <p style="${P}">
        If you recognise these — a new laptop, a new CI runner — there is nothing to do. If you do
        not, revoke the credential that made the read and rotate what it could reach.
      </p>
      <p style="${P}">
        At most one of these is sent an hour; anything newer is in the next one, and every read
        location is listed in the environment’s settings. To stop these alerts for an environment,
        switch them off there:
      </p>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.6;">
        ${settings
          .map(([name, url]) => `<li><a href="${escapeHtml(url)}">${escapeHtml(name)}</a></li>`)
          .join('\n        ')}
      </ul>
      <hr style="border:0;border-top:1px solid #e3e5e8;margin:0 0 24px;" />
      <p style="${SMALL}">
        You are receiving this because you are an owner or admin of the organisation.
      </p>${SHELL_CLOSE}`;

  return {
    to: params.to,
    toName: params.toName ?? undefined,
    subject:
      count === 1
        ? `New read location in ${params.organizationName}`
        : `${count} new read locations in ${params.organizationName}`,
    text,
    html,
  };
}
