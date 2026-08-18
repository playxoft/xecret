import type { AccessLevel } from '@xecret/core/authz';

/**
 * Wire shapes of the token and audit endpoints. What is *not* representable
 * here is the point: no token value (returned once at creation, then gone) and
 * no token hash (never serialised by any endpoint).
 */

export interface ServiceToken {
  id: string;
  name: string;
  tokenPrefix: string;
  projectSlug: string;
  environmentSlug: string;
  accessLevel: AccessLevel;
  ipAllowlist: string[] | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CliToken {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** The credential making this very request — "this device". */
  isCurrent: boolean;
}

export interface ServiceTokenListResponse {
  data: readonly ServiceToken[];
}

export interface CliTokenListResponse {
  data: readonly CliToken[];
}

export interface CreateServiceTokenResponse {
  /** Shown once, copied, never retrievable again. */
  token: string;
  serviceToken: ServiceToken;
}

export interface AuditEvent {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  projectId: string | null;
  environmentId: string | null;
  outcome: 'success' | 'denied' | 'error';
  ipAddress: string | null;
  requestId: string | null;
  metadata: Readonly<Record<string, string | number | undefined>>;
  createdAt: string;
}

export interface AuditListResponse {
  data: readonly AuditEvent[];
  nextCursor: string | null;
  window: { from: string; to: string };
}
