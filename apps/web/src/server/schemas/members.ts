import { z } from 'zod';
import { invitationState } from '@xecret/core/auth';
import type { AccessLevel, OrgRole } from '@xecret/core/authz';
import { environmentSlugSchema, slugSchema } from '@xecret/core/validation';
import type {
  InvitationListEntry,
  InvitationRecord,
  MemberListEntry,
  SeatUsage,
} from '@xecret/db/repositories';

/**
 * The request schemas and response shapes of the member and invitation routes.
 *
 * The same rules as `resources.ts`: bodies are `strictObject` with a fixed
 * unknown-field message, primitives come from `@xecret/core` rather than being
 * restated, and the serialisers list their columns so nothing reaches a client
 * by being added to a table later. Notably absent from every payload here: the
 * invitation token hash and any user id other than the member's own — grants
 * and invitations are addressed by slug and email, like everything else in the
 * API.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

export const orgRoleSchema = z.enum(['owner', 'admin', 'developer', 'viewer']);

export const accessLevelSchema = z.enum(['none', 'read', 'write', 'admin']);

/**
 * An invitee's address.
 *
 * 320 is the RFC ceiling and the `citext` column's practical bound; the format
 * check is deliberately zod's, not a hand-rolled pattern — the address only has
 * to be deliverable, and the real arbiter of that is the mail provider.
 */
const emailSchema = z.email('Enter a valid email address.').max(320);

export const memberInviteSchema = z.strictObject(
  {
    email: emailSchema,
    role: orgRoleSchema,
  },
  UNEXPECTED_FIELD,
);

/**
 * Exactly one change per request: a role change and a suspension are different
 * acts with different audit records, and a body carrying both would force this
 * endpoint to invent an ordering the caller never stated.
 */
export const memberPatchSchema = z
  .strictObject(
    {
      role: orgRoleSchema.optional(),
      status: z.enum(['active', 'suspended']).optional(),
    },
    UNEXPECTED_FIELD,
  )
  .refine(
    (patch) => [patch.role, patch.status].filter((field) => field !== undefined).length === 1,
    {
      message: 'Provide either a role or a status, not both.',
    },
  );

/**
 * A grant names its scope by slug, like every other request in this API.
 * `environmentSlug: null` — or omitting it — means the whole project.
 */
export const grantWriteSchema = z.strictObject(
  {
    projectSlug: slugSchema,
    environmentSlug: environmentSlugSchema.nullable().optional(),
    accessLevel: accessLevelSchema,
  },
  UNEXPECTED_FIELD,
);

export const grantRemoveSchema = z.strictObject(
  {
    projectSlug: slugSchema,
    environmentSlug: environmentSlugSchema.nullable().optional(),
  },
  UNEXPECTED_FIELD,
);

/**
 * A presented invitation token.
 *
 * Bounded, and checked only for gross shape here — whether it *is* an
 * invitation is answered by the hash lookup, and the well-formedness check in
 * `@xecret/core` runs in the route so a garbage value is refused before it
 * costs a database query.
 */
export const invitationTokenSchema = z.strictObject(
  { token: z.string().min(1).max(128) },
  UNEXPECTED_FIELD,
);

export type MemberInviteRequest = z.infer<typeof memberInviteSchema>;
export type MemberPatchRequest = z.infer<typeof memberPatchSchema>;
export type GrantWriteRequest = z.infer<typeof grantWriteSchema>;
export type GrantRemoveRequest = z.infer<typeof grantRemoveSchema>;

export interface MemberPayload {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  status: 'active' | 'suspended';
  joinedAt: string;
  isYou: boolean;
}

export interface SeatsPayload {
  used: number;
  pendingInvitations: number;
  limit: number;
}

export interface InvitationPayload {
  id: string;
  email: string;
  role: OrgRole;
  /** Derived from the row's lifecycle columns at serialisation time. */
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  invitedBy: { email: string; displayName: string | null } | null;
  createdAt: string;
  expiresAt: string;
}

export interface GrantPayload {
  projectSlug: string;
  /** `null` when the grant covers the whole project. */
  environmentSlug: string | null;
  accessLevel: AccessLevel;
}

export function toMember(member: MemberListEntry, viewerUserId: string | null): MemberPayload {
  return {
    id: member.id,
    userId: member.userId,
    email: member.user.email,
    displayName: member.user.displayName,
    avatarUrl: member.user.avatarUrl,
    role: member.role,
    status: member.status,
    joinedAt: member.createdAt.toISOString(),
    isYou: viewerUserId !== null && member.userId === viewerUserId,
  };
}

export function toSeats(seats: SeatUsage): SeatsPayload {
  return {
    used: seats.members,
    pendingInvitations: seats.pendingInvitations,
    limit: seats.seatLimit,
  };
}

export function toInvitation(
  invitation: InvitationRecord,
  inviter: InvitationListEntry['inviter'],
  now: Date,
): InvitationPayload {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    state: invitationState(invitation, now),
    invitedBy: inviter === null ? null : { email: inviter.email, displayName: inviter.displayName },
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
  };
}
