import type { AccessLevel, OrgRole } from '@xecret/core/authz';
import type { BadgeTone } from '@/components/ui';

/**
 * The wire shapes of the member, invitation and access endpoints, plus the
 * display vocabulary the member screens share. One definition, because a role
 * label that says "Admin" in the list and "Administrator" in the invite dialog
 * reads as two different things.
 */

export interface Member {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  status: 'active' | 'suspended';
  joinedAt: string;
  isYou: boolean;
  /**
   * Slugs of the projects this member can reach (any environment above
   * no-access). Present only when the viewer holds `member.update` — grant
   * topology across members is an access map of the organisation, and the
   * list endpoint tells it only to the people who can change it.
   */
  projects?: readonly string[];
}

export interface Seats {
  used: number;
  pendingInvitations: number;
  limit: number;
}

export interface MemberListResponse {
  data: readonly Member[];
  seats: Seats;
  nextCursor: string | null;
}

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  state: InvitationState;
  invitedBy: { email: string; displayName: string | null } | null;
  createdAt: string;
  expiresAt: string;
}

export interface InvitationListResponse {
  data: readonly Invitation[];
}

export interface InviteResponse {
  invitation: Invitation;
  /** Returned exactly once. Shown, copied, and never retrievable again. */
  inviteUrl: string;
  emailSent: boolean;
}

export interface MemberGrantPayload {
  projectSlug: string;
  environmentSlug: string | null;
  accessLevel: AccessLevel;
}

export type AccessSource = 'suspended' | 'environment-grant' | 'project-grant' | 'role-default';

export interface EffectiveEnvironment {
  name: string;
  slug: string;
  isProduction: boolean;
  level: AccessLevel;
  source: AccessSource;
}

export interface EffectiveProject {
  name: string;
  slug: string;
  projectLevel: AccessLevel;
  environments: readonly EffectiveEnvironment[];
}

export interface MemberAccessResponse {
  member: Member;
  grants: readonly MemberGrantPayload[];
  projects: readonly EffectiveProject[];
}

export const ROLE_LABELS: Readonly<Record<OrgRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  developer: 'Developer',
  viewer: 'Viewer',
};

/** Highest first, matching how the roles read in every menu. */
export const ROLES_DESCENDING: readonly OrgRole[] = ['owner', 'admin', 'developer', 'viewer'];

export const ROLE_DESCRIPTIONS: Readonly<Record<OrgRole, string>> = {
  owner: 'Everything, including deleting the organisation.',
  admin: 'Everything except deleting the organisation.',
  developer: 'Works with secrets. No production access unless granted.',
  viewer: 'Read-only, and nothing in production unless granted.',
};

/**
 * Only `owner` gets a tone. Colour in this design system is reserved for
 * things that change what an action costs, and there is exactly one of those
 * in a member list: the person who cannot be removed without stranding the
 * organisation.
 */
export const ROLE_TONE: Readonly<Partial<Record<OrgRole, BadgeTone>>> = {
  owner: 'accent',
};

export const ACCESS_LEVEL_LABELS: Readonly<Record<AccessLevel, string>> = {
  none: 'No access',
  read: 'Read',
  write: 'Read & write',
  admin: 'Admin',
};

export const ACCESS_SOURCE_LABELS: Readonly<Record<AccessSource, string>> = {
  suspended: 'Suspended — everything resolves to no access',
  'environment-grant': 'Environment grant',
  'project-grant': 'Project grant',
  'role-default': 'Role default',
};
