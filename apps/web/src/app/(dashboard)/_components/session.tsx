'use client';

import { createContext, use } from 'react';
import type { ReactNode } from 'react';

import type { OrgRole } from '@xecret/core/authz';

/**
 * Who is signed in, and which organisations they can act in.
 *
 * Fetched once by the dashboard shell from `GET /api/auth/me` and shared from
 * here, so the organisation switcher, the account menu and every screen agree
 * about the answer without each asking again.
 *
 * ── This is a convenience, never an authority ──
 * `role` decides which controls are *rendered*. It never decides what is
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

export interface SessionOrganization {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
}

/**
 * Whether this session may currently reach a secret.
 *
 * Two booleans rather than one tri-state, because the two questions have
 * different answers and different screens: `configured: false` means "choose a
 * PIN", `unlocked: false` means "enter yours", and a single `locked` flag would
 * make the shell guess which.
 */
export interface PinStatus {
  configured: boolean;
  unlocked: boolean;
  /** ISO 8601. When the current unlock lapses; `null` while locked. */
  unlockedUntil: string | null;
}

export interface SessionValue {
  user: SessionUser;
  organizations: readonly SessionOrganization[];
  pin: PinStatus;
  /** Locks this session without ending it, then re-reads the session. */
  lock: () => Promise<void>;
}

/** The body of `GET /api/auth/me`. `credential` is for the CLI and unused here. */
export interface MeResponse {
  user: SessionUser;
  organizations: readonly SessionOrganization[];
  pin: PinStatus;
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
 * Used to hide the controls that only an admin or owner can complete — creating
 * an environment, reclassifying production, deleting a project. Per-project and
 * per-environment access grants can narrow this further, and only the server
 * knows them, so this is deliberately the coarse half of the answer: it hides
 * what is certainly unavailable and shows what may be.
 */
export function isOrgAdmin(role: OrgRole): boolean {
  return role === 'owner' || role === 'admin';
}
