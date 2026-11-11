import {
  addPlatformAdmin,
  findUserByEmail,
  findUserById,
  listPlatformAdmins,
  removePlatformAdmin,
} from '@xecret/db/repositories';
import type { PlatformAdminListing } from '@xecret/db/repositories';
import type { Principal } from './actor';
import { asciiAddress } from './admin';
import { publicOrigin } from './bindings';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { describeMailFailure, mailerFrom } from './mail';
import type { AdminUserPayload } from './schemas/admin';

/**
 * The Admins tab (`/api/admin/admins`): who xecret's admins are, and adding
 * and removing them (migration 0035).
 *
 * ── Who may be added ──
 * An account that exists, is live, and whose address is verified — the person
 * signs in to xecret once, and is then added by the address they signed in
 * with. Matched in ASCII only, so a look-alike address never names somebody
 * else's account.
 *
 * ── Who is told ──
 * Every admin, by email, whenever the list changes — the one added or removed
 * included. An admin added behind the others' backs is the shape of an admin
 * account being taken over, and the email is how somebody notices. Best
 * effort: a deployment with no mail sends none, and a failed send is logged
 * rather than undoing the change.
 */

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

function toPayload(admin: PlatformAdminListing, viewer: UserPrincipal): AdminUserPayload {
  return {
    userId: admin.userId,
    email: admin.email,
    displayName: admin.displayName,
    addedAt: admin.addedAt.toISOString(),
    addedByEmail: admin.addedByEmail,
    you: admin.userId === viewer.user.id,
  };
}

export async function listAdmins(
  services: ServiceContext,
  viewer: UserPrincipal,
): Promise<AdminUserPayload[]> {
  return (await listPlatformAdmins(services.db)).map((admin) => toPayload(admin, viewer));
}

/** Makes the account with this address an admin. */
export async function addAdmin(
  services: ServiceContext,
  viewer: UserPrincipal,
  rawEmail: string,
): Promise<AdminUserPayload> {
  const address = asciiAddress(rawEmail);
  const user = address === null ? null : await findUserByEmail(services.db, address);
  // `users.email` is citext, so the lookup folds case in Unicode; the account
  // is accepted only when its address is the same one in ASCII.
  if (user === null || asciiAddress(user.email) !== address) {
    throw errors.conflictOn(
      'email',
      'No xecret account uses that address. Ask them to sign in to xecret once, then add them.',
    );
  }
  if (!user.emailVerified) {
    throw errors.conflictOn(
      'email',
      'That account has not verified its address yet. Once it has, it can be added.',
    );
  }

  const outcome = await services.db.transaction((tx) =>
    addPlatformAdmin(tx, { userId: user.id, email: user.email, by: { userId: viewer.user.id } }),
  );
  if (outcome === 'already') throw errors.conflictOn('email', 'They are an admin already.');

  services.log.at('addAdmin').info('An admin added another admin', {
    adminUserId: viewer.user.id,
    addedUserId: user.id,
  });
  await tellAdmins(services, {
    subject: 'A new xecret admin was added',
    line: `${user.email} was made a xecret admin by ${viewer.user.email}.`,
    alsoTo: null,
  });

  const listed = (await listPlatformAdmins(services.db)).find((admin) => admin.userId === user.id);
  if (listed === undefined) throw errors.internal('an admin just added is not listed');
  return toPayload(listed, viewer);
}

/** Removes an admin — never the last one. An admin may remove themselves. */
export async function removeAdmin(
  services: ServiceContext,
  viewer: UserPrincipal,
  userId: string,
): Promise<void> {
  const user = await findUserById(services.db, userId);
  if (user === null) throw errors.notFound('no such admin');

  const outcome = await services.db.transaction((tx) =>
    removePlatformAdmin(tx, { userId, email: user.email, by: { userId: viewer.user.id } }),
  );
  if (outcome === 'not-admin') throw errors.notFound('not an admin');
  if (outcome === 'last') {
    throw errors.conflict(
      'There must always be at least one admin, so the last one cannot be removed. Add another ' +
        'admin first.',
    );
  }

  services.log.at('removeAdmin').info('An admin removed an admin', {
    adminUserId: viewer.user.id,
    removedUserId: userId,
  });
  await tellAdmins(services, {
    subject: 'A xecret admin was removed',
    line:
      userId === viewer.user.id
        ? `${user.email} stepped down as a xecret admin.`
        : `${user.email} is no longer a xecret admin; ${viewer.user.email} removed them.`,
    // The one removed is no longer on the list, and is still told.
    alsoTo: user.email,
  });
}

/** Emails every admin — and `alsoTo`, when given — one line about the list. */
async function tellAdmins(
  services: ServiceContext,
  message: { subject: string; line: string; alsoTo: string | null },
): Promise<void> {
  const mailer = mailerFrom(services.env);
  if (mailer === null) return;

  const recipients = new Set((await listPlatformAdmins(services.db)).map((admin) => admin.email));
  if (message.alsoTo !== null) recipients.add(message.alsoTo);

  const adminPage = `${publicOrigin(services.env)}/app/admin`;
  const closing =
    'If you did not expect this, check the Admins tab now — an admin added without the others ' +
    'knowing is how a taken-over account keeps its access.';
  const text = [
    'Hello,',
    '',
    message.line,
    '',
    closing,
    '',
    `Admins: ${adminPage}`,
    '',
    '— xecret',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1e21;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hello,</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(message.line)}</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(closing)}</p>
      <p style="margin:8px 0 0;"><a href="${escapeHtml(adminPage)}" style="color:#1c1e21;">Open the Admins tab</a></p>
    </div>
  </body>
</html>`;

  for (const to of recipients) {
    try {
      await mailer.send({ to, subject: message.subject, text, html });
    } catch (cause) {
      // The address is never logged; the provider's explanation is, scrubbed.
      services.log
        .at('tellAdmins')
        .warn('An email about a change to the admin list was not delivered', {
          ...describeMailFailure(cause),
        });
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
