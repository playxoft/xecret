import type { AccessLevel } from '@xecret/core/authz';
import type { TokenPolicy } from '@xecret/core/policy';

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

/**
 * A service token as the *listing* describes it: the token, and whether it
 * would pass the organisation's token policy if it were minted now (P19 §6).
 *
 * A separate type from `ServiceToken` because the mint response does not carry
 * the flag — a token the server has just minted passed the policy by
 * definition, and saying so would be a field with one possible value.
 */
export interface ServiceTokenListItem extends ServiceToken {
  /**
   * `false` for a token minted before the policy that falls outside it. It
   * keeps working — the policy is checked at minting, never at use — and the
   * list marks it so somebody can replace it deliberately.
   */
  meetsPolicy: boolean;
}

export interface ServiceTokenListResponse {
  data: readonly ServiceTokenListItem[];
  /** The token policy the flags above were decided against. */
  policy: TokenPolicy;
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
  /**
   * Mostly strings and numbers; a custom role's definition adds an action list
   * and a ceiling object, and `null` for "no ceiling". Read by key, with a
   * type check on each value, never rendered wholesale.
   */
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
}

export interface AuditListResponse {
  data: readonly AuditEvent[];
  nextCursor: string | null;
  window: { from: string; to: string };
}
