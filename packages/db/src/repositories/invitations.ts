import { and, count, eq, gt, isNull, lt } from 'drizzle-orm';
import { generateToken, hashToken, invitationExpiryFrom, invitationState } from '@xecret/core/auth';
import type { OrgRole } from '@xecret/core/authz';
import type { Bytes } from '@xecret/core/crypto';
import { uuidv7 } from '@xecret/core/ids';
import { users } from '../schema/identity';
import { invitations, orgMembers, organizations } from '../schema/tenancy';
import { addMember } from './membership';
import type { MemberRecord } from './membership';
import { MAX_PAGE_SIZE, RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Invitations — the only path by which a second person enters an organisation.
 *
 * The lifecycle is a one-time credential's: minted here (the caller never sees
 * a plaintext token except in the creation return value), stored hashed,
 * consumed atomically, superseded on re-issue. That mirrors `cli-auth.ts` and
 * `pins.ts` deliberately — this layer has one way of treating a single-use
 * token, not three.
 *
 * Seats are enforced here, inside the transactions that change who holds one,
 * because "how many members may this organisation have" is exactly the kind of
 * invariant that two concurrent accepts would otherwise both pass. The count is
 * taken under a `FOR UPDATE` lock on the organisation row — the same
 * serialisation the last-owner guard uses, for the same reason.
 */

/** An invitation as it is listed and audited. Never includes the token hash. */
export interface InvitationRecord {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface InvitationListEntry extends InvitationRecord {
  inviter: {
    email: string;
    displayName: string | null;
  } | null;
}

export interface CreateInvitationParams {
  orgId: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
  environment?: 'live' | 'test' | undefined;
}

export interface IssuedInvitation {
  invitation: InvitationRecord;
  /**
   * The raw token, returned exactly once. It goes into the invitation email
   * and the one-time link shown to the inviter; only its hash is stored.
   */
  token: string;
}

/** What the public lookup endpoint may learn from a presented token. */
export interface InvitationClaim {
  invitation: InvitationRecord;
  organization: { id: string; name: string; slug: string };
  inviter: { email: string; displayName: string | null } | null;
}

export interface AcceptInvitationParams {
  tokenHash: Bytes;
  userId: string;
  /** The accepting account's address, compared against the invited one. */
  userEmail: string;
}

export interface AcceptedInvitation {
  member: MemberRecord;
  invitation: InvitationRecord;
  organization: { id: string; name: string; slug: string };
}

/** How full the organisation is, for the members page and the invite check. */
export interface SeatUsage {
  /** Members holding a seat, whatever their status — suspension frees nothing. */
  members: number;
  /** Open invitations that have not expired. Each one is a promised seat. */
  pendingInvitations: number;
  seatLimit: number;
}

const INVITATION_COLUMNS = {
  id: invitations.id,
  orgId: invitations.orgId,
  email: invitations.email,
  role: invitations.role,
  invitedBy: invitations.invitedBy,
  expiresAt: invitations.expiresAt,
  acceptedAt: invitations.acceptedAt,
  acceptedBy: invitations.acceptedBy,
  revokedAt: invitations.revokedAt,
  createdAt: invitations.createdAt,
} as const;

/**
 * Invites an address, superseding any invitation it already has.
 *
 * Superseding rather than refusing makes "resend the invite" the same operation
 * as inviting — the old link stops working the moment the new one exists, so at
 * most one live token per (organisation, address) can ever circulate. It is
 * also what makes re-inviting after expiry work at all: the partial unique
 * index `invitations_pending_idx` does not consider expiry, so an expired
 * invitation left un-revoked would otherwise block its own replacement.
 *
 * Refused outright when the address already belongs to a member — an
 * invitation that could only ever fail at acceptance should fail now, in front
 * of the person who can act on it.
 */
export async function createInvitation(
  exec: Executor,
  params: CreateInvitationParams,
): Promise<IssuedInvitation> {
  return exec.transaction(async (tx) => {
    const organization = await lockOrganization(tx, params.orgId);

    const existingMember = await memberByEmail(tx, params.orgId, params.email);
    if (existingMember) {
      throw new RepositoryError('conflict', 'That address already belongs to a member.');
    }

    // Withdraw whatever this address already had, before counting seats, so a
    // re-invitation replaces its predecessor's seat claim instead of needing a
    // second one.
    const now = new Date();
    await tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(invitations.orgId, params.orgId),
          eq(invitations.email, params.email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );

    await assertSeatAvailable(tx, organization, now);

    const generated = await generateToken('invitation', params.environment ?? 'live');
    const [row] = await tx
      .insert(invitations)
      .values({
        id: uuidv7(),
        orgId: params.orgId,
        email: params.email,
        role: params.role,
        tokenHash: generated.hash,
        invitedBy: params.invitedBy,
        expiresAt: invitationExpiryFrom(now),
        createdAt: now,
      })
      .returning(INVITATION_COLUMNS);

    if (!row) throw new RepositoryError('conflict', 'The invitation could not be recorded.');

    return { invitation: row, token: generated.token };
  });
}

/**
 * Open invitations, newest first, with who sent them.
 *
 * Includes expired ones on purpose: they are still rows an operator may want to
 * revoke or re-send, and silently hiding them would make "why can't I re-invite
 * this person?" unanswerable from the screen that caused it. The caller reads
 * each row's state with `invitationState`.
 */
export async function listInvitations(
  exec: Executor,
  orgId: string,
): Promise<InvitationListEntry[]> {
  const rows = await pendingInvitationsQuery(exec, orgId);

  return rows.map((row) => ({
    ...row.invitation,
    inviter: row.inviter,
  }));
}

/**
 * Resolves a presented token to its invitation, or `null`.
 *
 * No expiry filter here: the caller distinguishes "expired" from "unknown" with
 * `invitationState`, because the two deserve different sentences on the accept
 * page. What *is* filtered is a deleted organisation — an invitation into an
 * organisation that no longer exists is not an invitation.
 */
export async function findInvitationByTokenHash(
  exec: Executor,
  tokenHash: Bytes,
): Promise<InvitationClaim | null> {
  const [row] = await invitationClaimQuery(exec, tokenHash);
  return row ?? null;
}

/**
 * Withdraws an invitation. Returns the row it closed, or `null` when there was
 * no open invitation to withdraw — the distinction the audit record needs.
 */
export async function revokeInvitation(
  exec: Executor,
  orgId: string,
  invitationId: string,
): Promise<InvitationRecord | null> {
  const [row] = await exec
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.orgId, orgId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning(INVITATION_COLUMNS);

  return row ?? null;
}

/**
 * Turns a presented token into a membership, atomically.
 *
 * Everything that must hold — the invitation is still open, the address
 * matches, a seat is free, the user is not already a member — is re-checked
 * inside the transaction under the organisation lock, whatever the route
 * already showed the user. The lookup endpoint's answer was advisory; this is
 * the decision.
 *
 * The address comparison is case-insensitive, matching the `citext` column the
 * addresses live in. It exists because an invitation is addressed to a person,
 * not to whoever finds the link: a forwarded email must not let a colleague
 * join as somebody else.
 */
export async function acceptInvitation(
  exec: Executor,
  params: AcceptInvitationParams,
): Promise<AcceptedInvitation> {
  return exec.transaction(async (tx) => {
    // Resolve the organisation first — the lock ordering everywhere in this
    // layer is organisation, then children, and deviating here would deadlock
    // against `createInvitation`.
    const claim = await findInvitationByTokenHash(tx, params.tokenHash);
    if (!claim) throw new RepositoryError('notFound', 'No such invitation.');

    const organization = await lockOrganization(tx, claim.invitation.orgId);

    // Re-read under the lock: the unlocked row above may have been accepted or
    // revoked while this transaction waited its turn.
    const [invitation] = await tx
      .select(INVITATION_COLUMNS)
      .from(invitations)
      .where(eq(invitations.id, claim.invitation.id))
      .limit(1);
    if (!invitation) throw new RepositoryError('notFound', 'No such invitation.');

    const now = new Date();
    const state = invitationState(invitation, now);
    if (state !== 'pending') {
      throw new RepositoryError('invalid', `This invitation is ${state}.`);
    }

    if (invitation.email.toLowerCase() !== params.userEmail.toLowerCase()) {
      throw new RepositoryError(
        'invalid',
        'This invitation was sent to a different email address.',
      );
    }

    await assertSeatAvailable(tx, organization, now);

    // `addMember` throws `conflict` when the user already belongs — the
    // two-tabs case — and the invitation is then left open rather than
    // half-consumed by a join that did not happen.
    const member = await addMember(tx, {
      orgId: invitation.orgId,
      userId: params.userId,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
    });

    const [accepted] = await tx
      .update(invitations)
      .set({ acceptedAt: now, acceptedBy: params.userId })
      .where(and(eq(invitations.id, invitation.id), isNull(invitations.acceptedAt)))
      .returning(INVITATION_COLUMNS);
    if (!accepted) throw new RepositoryError('conflict', 'This invitation was already accepted.');

    return {
      member,
      invitation: accepted,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      },
    };
  });
}

/**
 * Seats in use and seats promised.
 *
 * Members are counted whatever their status: suspending someone is a security
 * act, and it must never be the discount that makes one more invitation fit.
 * Open, unexpired invitations count too, because each is a seat the
 * organisation has already offered to fill.
 */
export async function seatUsage(exec: Executor, orgId: string, now: Date): Promise<SeatUsage> {
  const [organization] = await exec
    .select({ seatLimit: organizations.seatLimit })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  if (!organization) throw new RepositoryError('notFound', 'Organisation not found.');

  return {
    members: await countSeatedMembers(exec, orgId),
    pendingInvitations: await countOpenInvitations(exec, orgId, now),
    seatLimit: organization.seatLimit,
  };
}

/** Housekeeping: removes invitations that expired more than a grace period ago. */
export async function deleteExpiredInvitations(exec: Executor, before: Date): Promise<void> {
  await exec
    .delete(invitations)
    .where(and(isNull(invitations.acceptedAt), lt(invitations.expiresAt, before)));
}

/**
 * @internal Exported for SQL-shape assertions: the listing filters on the
 * organisation and never selects `token_hash`.
 */
export function pendingInvitationsQuery(exec: Executor, orgId: string) {
  return exec
    .select({
      invitation: INVITATION_COLUMNS,
      inviter: {
        email: users.email,
        displayName: users.displayName,
      },
    })
    .from(invitations)
    .leftJoin(users, and(eq(users.id, invitations.invitedBy), isNull(users.deletedAt)))
    .where(
      and(
        eq(invitations.orgId, orgId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .orderBy(invitations.createdAt)
    .limit(MAX_PAGE_SIZE);
}

/**
 * @internal Exported for SQL-shape assertions: resolution joins through a
 * live organisation, so a deleted tenant's invitations resolve to nothing.
 */
export function invitationClaimQuery(exec: Executor, tokenHash: Bytes) {
  return exec
    .select({
      invitation: INVITATION_COLUMNS,
      organization: {
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
      },
      inviter: {
        email: users.email,
        displayName: users.displayName,
      },
    })
    .from(invitations)
    .innerJoin(
      organizations,
      and(eq(organizations.id, invitations.orgId), isNull(organizations.deletedAt)),
    )
    .leftJoin(users, and(eq(users.id, invitations.invitedBy), isNull(users.deletedAt)))
    .where(eq(invitations.tokenHash, tokenHash))
    .limit(1);
}

/**
 * Verifies a raw token and resolves it in one step, for the routes that hold
 * the plaintext. Hashing lives here so no route ever needs the hash utilities.
 */
export async function findInvitationByToken(
  exec: Executor,
  token: string,
): Promise<InvitationClaim | null> {
  return findInvitationByTokenHash(exec, await hashToken(token));
}

async function lockOrganization(tx: Executor, orgId: string) {
  const [organization] = await tx
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      seatLimit: organizations.seatLimit,
    })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1)
    .for('update');
  if (!organization) throw new RepositoryError('notFound', 'Organisation not found.');
  return organization;
}

async function assertSeatAvailable(
  tx: Executor,
  organization: { id: string; seatLimit: number },
  now: Date,
): Promise<void> {
  const seated = await countSeatedMembers(tx, organization.id);
  const promised = await countOpenInvitations(tx, organization.id, now);

  if (seated + promised >= organization.seatLimit) {
    throw new RepositoryError(
      'seatLimit',
      'This organisation has no seats left. Remove a member or revoke an invitation first.',
    );
  }
}

async function countSeatedMembers(exec: Executor, orgId: string): Promise<number> {
  const [row] = await exec
    .select({ value: count() })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.seatAssigned, true)));
  return row?.value ?? 0;
}

async function countOpenInvitations(exec: Executor, orgId: string, now: Date): Promise<number> {
  const [row] = await exec
    .select({ value: count() })
    .from(invitations)
    .where(
      and(
        eq(invitations.orgId, orgId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
      ),
    );
  return row?.value ?? 0;
}

/** Resolves an address to an existing membership, if the address has an account. */
async function memberByEmail(
  exec: Executor,
  orgId: string,
  email: string,
): Promise<{ id: string } | null> {
  const [row] = await exec
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .where(and(eq(orgMembers.orgId, orgId), eq(users.email, email)))
    .limit(1);
  return row ?? null;
}
