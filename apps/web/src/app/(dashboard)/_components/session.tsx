'use client';

import { createContext, use } from 'react';
import type { ReactNode } from 'react';

import type { Action, OrgRole } from '@xecret/core/authz';
import type { CustomRoleRef } from '@/components/members/types';
import type { VaultStatus } from '@/components/vault';

/**
 * Who is signed in, and which organisations they can act in.
 *
 * Fetched once by the dashboard shell from `GET /api/auth/me` and shared from
 * here, so the organisation switcher, the account menu and every screen agree
 * about the answer without each asking again.
 *
 * ── This is a convenience, never an authority ──
 * `authority` decides which controls are *rendered*. It never decides what is
 * *permitted*: every action is authorised server-side by `can()` against the
 * database, and a browser that lies to itself about this object gains exactly
 * nothing — the request still comes back 403. Hiding a button someone cannot use
 * is a courtesy that keeps a screen honest; the button not working is the
 * security property. The `/api/auth/me` handler says the same thing from the
 * other side.
 */
export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * What the viewer may do in one organisation, as the server computed it
 * (`authoritySummary` in `@xecret/core/authz`).
 *
 * Gate controls on this, never on `role`. A stored `admin` whose custom role
 * narrows them to member management is an admin by label and not by
 * authority, and a control drawn from the label is one that answers 403.
 */
export interface SessionAuthority {
  role: OrgRole;
  customRole: CustomRoleRef | null;
  /** The lower of `role` and the custom role's base. */
  effectiveRole: OrgRole;
  capabilities: readonly Action[];
  /**
   * Roles within the viewer's authority — empty unless they hold
   * `member.update` or `member.invite`. Not a permission on its own: ask
   * `mayManageRole` to change a member, and gate inviting on `member.invite`.
   */
  assignableRoles: readonly OrgRole[];
  /** Bases the viewer may define a custom role on. Empty for a narrowed viewer. */
  definableBaseRoles: readonly OrgRole[];
}

export interface SessionOrganization {
  id: string;
  name: string;
  slug: string;
  /** The stored role — what the viewer *is*, and what labels show. */
  role: OrgRole;
  /** What the viewer may *do* here — what controls ask. */
  authority: SessionAuthority;
}

/**
 * Whether this session may currently reach key material.
 *
 * Two booleans rather than one tri-state, because the two questions have
 * different answers and different screens: `configured: false` means "set up
 * your vault", `unlocked: false` means "unlock it", and a single `locked` flag
 * would make the shell guess which.
 *
 * The vault's *material* — the wraps, the public keys, the KDF parameters — is
 * deliberately absent here, and so are the keys themselves. The material comes
 * from `GET /api/auth/vault` and is held by `VaultProvider`; the keys live in
 * the module singleton behind it. Neither belongs in a context every screen
 * reads: one is only wanted by the two screens that unlock, and the other must
 * not be reachable by anything that merely renders a table.
 *
 * Defined by `components/vault` rather than here, so that the type describing
 * the vault ships with the code that operates it, and re-exported because every
 * screen reads it through this module.
 */
export type { VaultStatus };

export interface SessionValue {
  user: SessionUser;
  organizations: readonly SessionOrganization[];
  vault: VaultStatus;
  /** Locks this session without ending it, then re-reads the session. */
  lock: () => Promise<void>;
  /**
   * Re-reads `GET /api/auth/me`. For screens that change what it reports —
   * the auto-lock interval, the display name — so the shell's copy does not
   * go stale until the next full navigation.
   *
   * Resolves once the new answer is in state, which is what a screen that
   * navigates afterwards has to wait for: the membership list decides where
   * `/app` sends a viewer, so redirecting while it still lists a deleted
   * organisation lands them in its 404. Screens that only need the shell to
   * catch up eventually — a rename, an auto-lock change — ignore the promise.
   */
  refresh: () => Promise<void>;
  /**
   * Opens the "New organisation" dialog.
   *
   * The dialog is mounted once, by `DashboardChrome`, and this is how the three
   * screens with a "New organisation" button reach it. They used to mount their
   * own — four copies of the same dialog, three of them alive at once on the
   * settings page, each with its own idea of what to do afterwards. Sharing the
   * open-state means the wiring that follows a successful create is written
   * once, where the session it has to refresh actually lives.
   */
  createOrganization: () => void;
}

/** The body of `GET /api/auth/me`. `credential` is for the CLI and unused here. */
export interface MeResponse {
  user: SessionUser;
  organizations: readonly SessionOrganization[];
  vault: VaultStatus;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ value, children }: { value: SessionValue; children: ReactNode }) {
  return <SessionContext value={value}>{children}</SessionContext>;
}

/**
 * Throws outside the provider rather than returning a null user. Every caller
 * is below the dashboard shell, which does not render its children until the
 * session has resolved — so a missing provider is a wiring bug, and a screen
 * silently rendering as though nobody were signed in is the worst way to find
 * out about one.
 */
export function useSession(): SessionValue {
  const value = use(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>.');
  return value;
}

/** The organisation a URL names, or `null` when the viewer is not a member. */
export function useOrganization(slug: string | null): SessionOrganization | null {
  const { organizations } = useSession();
  if (slug === null) return null;
  return organizations.find((organization) => organization.slug === slug) ?? null;
}

/**
 * Whether a role is at least `admin`.
 *
 * Asked of the *effective* role, through `canAdminister`, never of the stored
 * one on its own.
 */
export function isOrgAdmin(role: OrgRole): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Whether to draw an administrative control whose request needs `action` —
 * creating an environment, reclassifying production, deleting a project,
 * minting a token, managing members.
 *
 * Two halves, both from the server's own answer: the viewer's *effective* role
 * is at least `admin`, and their capabilities include `action`. The first keeps
 * these controls where they have always been — with owners and admins, never
 * drawn for a developer — and the second takes each one away from an admin
 * whose custom role withholds it, which asking the stored role could not.
 *
 * Still the coarse half of the answer. Per-project and per-environment access
 * grants can narrow it further and only the server knows them, so this hides
 * what is certainly unavailable and shows what may be.
 */
export function canAdminister(organization: SessionOrganization | null, action: Action): boolean {
  if (organization === null) return false;
  const { authority } = organization;
  return isOrgAdmin(authority.effectiveRole) && authority.capabilities.includes(action);
}

/**
 * Whether the viewer may change a member holding `role` — their role, their
 * grants, their custom role, their status — or hand `role` to somebody.
 *
 * Both halves the server asks: `member.update` (through `canAdminister`, so
 * the effective role is an admin's too) and `roleWithinAuthority` as the
 * server computed it, so a narrowed admin sees no control on a member their
 * own role could not manage, even though they rank as an admin. For a member
 * without a custom role this is `isOrgAdmin` and `canAssignRole` exactly —
 * `session.test.ts` pins it.
 */
export function mayManageRole(organization: SessionOrganization | null, role: OrgRole): boolean {
  return (
    canAdminister(organization, 'member.update') &&
    organization !== null &&
    organization.authority.assignableRoles.includes(role)
  );
}
