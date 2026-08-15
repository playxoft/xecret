import { AuthorizationError } from '@xecret/core/authz';
import { createInvitation, listMembers, seatUsage } from '@xecret/db/repositories';
import { publicOrigin } from '@/server/bindings';
import { json, parseJsonBody, parseQuery } from '@/server/http';
import { invitationMail } from '@/server/invitation-mail';
import { mailerFrom } from '@/server/mail';
import {
  assertRoleAuthority,
  mapMembershipError,
  requireMembership,
  requireSessionPrincipal,
  resolveInvitationGrants,
} from '@/server/members-service';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { memberInviteSchema, toInvitation, toMember, toSeats } from '@/server/schemas/members';
import { listQuery } from '@/server/schemas/secrets';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * Who is in this organisation — and the door new people come through.
 *
 * `member.read` is the capability behind the listing, and every active role
 * holds it — a developer needs to know who to ask for production access as much
 * as an owner needs to know who has it. A *suspended* member holds nothing,
 * which is the case this check is really settling: `resolveOrg` proves
 * membership exists, and `authorize` proves it is still active.
 *
 * ── What the listing returns, and what it does not ──
 * Name, email, role, status, join date, and the seat count. Emails are visible
 * to everyone in the organisation on purpose: they are how members are invited
 * and identified in the audit log. Access *grants* are not here — "who may read
 * production" is a more sensitive question than "who is here", it is
 * per-project, and it belongs on the member's own page (`[memberId]/access`).
 *
 * ── Inviting (POST) ──
 * An invitation is a minted credential, so the rules that govern credential
 * minting apply: browser session only (a bearer token may not mint further
 * credentials — the same rule as `/api/cli/authorize`), the `member.invite`
 * capability, and the role hierarchy — nobody hands out a role above their own.
 * The invitation email is sent after the response via `waitUntil`; the token is
 * also returned once in the response, because mail is optional in a self-hosted
 * install and an invitation that cannot be delivered by hand would make mail a
 * hard dependency of having colleagues.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'member.read');

  const { limit, cursor } = parseQuery(request, listQuery);
  const page = cursor ?? 1;

  const members = await listMembers(services.db, scope.organization.id, {
    page,
    ...(limit === undefined ? {} : { pageSize: limit }),
  });
  const seats = await seatUsage(services.db, scope.organization.id, new Date());

  const viewerUserId = scope.actor.kind === 'serviceToken' ? null : scope.actor.userId;

  return json({
    data: members.members.map((member) => toMember(member, viewerUserId)),
    seats: toSeats(seats),
    // Offset pagination behind an opaque cursor, exactly as the secret listing
    // does — see the note in `schemas/secrets.ts`. A client that does arithmetic
    // on this breaks the day it becomes a keyset cursor.
    nextCursor: members.hasMore ? String(page + 1) : null,
  });
});

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    // Keyed on the organisation: this endpoint sends mail on our domain, and
    // one noisy tenant must not spend the sending reputation of all of them.
    await enforce(services.env, 'RL_INVITE', rateLimitKey([orgId]));

    try {
      authorize(scope, 'member.invite');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(
          audit(orgId).denied('member.invited', { type: 'invitation', id: null }, cause.decision),
        );
      }
      throw cause;
    }

    const inviter = requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    const body = await parseJsonBody(request, memberInviteSchema);
    assertRoleAuthority(membership.role, body.role);

    // Resolved to ids now, while the inviter is present to fix a bad slug.
    // Present-but-empty is meaningful: it makes the membership deny-by-default
    // at acceptance — see the invitations schema.
    const initialGrants =
      body.grants === undefined
        ? undefined
        : await resolveInvitationGrants(services.db, orgId, body.grants);

    const issued = await createInvitation(services.db, {
      orgId,
      email: body.email,
      role: body.role,
      invitedBy: inviter.user.id,
      ...(initialGrants === undefined ? {} : { initialGrants }),
    }).catch(mapMembershipError);

    const inviteUrl = `${publicOrigin(services.env)}/invite/${encodeURIComponent(issued.token)}`;

    const mailer = mailerFrom(services.env);
    if (mailer !== null) {
      services.waitUntil(
        mailer
          .send(
            invitationMail({
              to: body.email,
              organizationName: scope.organization.name,
              inviterLabel: inviter.user.displayName ?? inviter.user.email,
              url: inviteUrl,
            }),
          )
          .catch((cause: unknown) => {
            // Logged, never rethrown: the response has already gone. The name
            // only — a delivery error embeds the recipient address.
            console.error('invitation mail failed', {
              requestId: services.meta.requestId,
              error: cause instanceof Error ? cause.name : 'unknown',
            });
          }),
      );
    }

    record(
      audit(orgId).success(
        'member.invited',
        { type: 'invitation', id: issued.invitation.id },
        { targetEmail: body.email, newRole: body.role, source: 'dashboard' },
      ),
    );

    return json(
      {
        invitation: toInvitation(issued.invitation, null, new Date()),
        /**
         * The acceptance link, returned exactly once — the token inside it is
         * never retrievable again. Deliberate: mail is optional (see
         * `mail.ts`), so the inviter must be able to deliver the link
         * themselves. It carries no more authority than the email it would
         * otherwise travel in, and acceptance still requires signing in as the
         * invited address.
         */
        inviteUrl,
        emailSent: mailer !== null,
      },
      { status: 201 },
    );
  },
);
