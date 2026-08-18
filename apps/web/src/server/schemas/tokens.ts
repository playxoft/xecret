import { z } from 'zod';
import type { AuditAction, AuditMetadata } from '@xecret/core/audit';
import type { AccessLevel } from '@xecret/core/authz';
import { fromBase64Url, toBase64Url } from '@xecret/core/crypto';
import { environmentSlugSchema, slugSchema } from '@xecret/core/validation';
import type {
  AuditCursor,
  AuditLogRecord,
  CliTokenSummary,
  ServiceTokenSummary,
} from '@xecret/db/repositories';
import { errors } from '../errors';

/**
 * The request schemas and response shapes of the token and audit routes.
 *
 * The one rule that towers over the rest here: **a token's value appears in
 * exactly one response — the creation's — and its hash appears in none.** The
 * serialisers below take the repository's summary types, which never carry the
 * hash, so there is nothing to leak even by mistake. The display prefix is
 * shown; `verifyToken(prefix)` fails, so it confers nothing.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

export const TOKEN_NAME_MAX_LENGTH = 100;

/**
 * `read` or `write` — never `admin`. The authorization engine's
 * `SERVICE_TOKEN_ACTIONS` allowlist tops out at `write`, so an `admin` service
 * token would hold a level nothing can spend; refusing it here keeps the token
 * list honest about what a credential can actually do.
 */
const serviceAccessSchema = z.enum(['read', 'write']);

/**
 * An IP allowlist entry: an address or CIDR range, loosely shaped here and
 * decided authoritatively by `isIpAllowed` at authentication time. The bound
 * on count exists because each entry is compared per request.
 */
const allowlistEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/, 'Enter an IP address or CIDR range.');

export const serviceTokenCreateSchema = z.strictObject(
  {
    name: z.string().trim().min(1, 'Give the token a name.').max(TOKEN_NAME_MAX_LENGTH),
    projectSlug: slugSchema,
    environmentSlug: environmentSlugSchema,
    accessLevel: serviceAccessSchema.optional(),
    /** ISO 8601. Absent means the token does not expire. */
    expiresAt: z.iso.datetime().optional(),
    ipAllowlist: z.array(allowlistEntrySchema).max(32).optional(),
  },
  UNEXPECTED_FIELD,
);

export type ServiceTokenCreateRequest = z.infer<typeof serviceTokenCreateSchema>;

/** Validates and interprets `expiresAt`, refusing a token born expired. */
export function resolveExpiry(value: string | undefined, now: Date): Date | null {
  if (value === undefined) return null;

  const expiresAt = new Date(value);
  if (expiresAt.getTime() <= now.getTime()) {
    throw errors.validation([{ field: 'expiresAt', message: 'An expiry must be in the future.' }]);
  }
  return expiresAt;
}

export interface ServiceTokenPayload {
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

export interface CliTokenPayload {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  isCurrent: boolean;
}

/**
 * Scope arrives as slugs resolved by the route, because the summary row holds
 * ids and this API never publishes project or environment ids.
 */
export function toServiceToken(
  token: ServiceTokenSummary,
  scope: { projectSlug: string; environmentSlug: string },
): ServiceTokenPayload {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    projectSlug: scope.projectSlug,
    environmentSlug: scope.environmentSlug,
    accessLevel: token.accessLevel,
    ipAllowlist: token.ipAllowlist,
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  };
}

export function toCliToken(token: CliTokenSummary, currentTokenId: string | null): CliTokenPayload {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
    /** True for the credential making this very request — "this device". */
    isCurrent: currentTokenId !== null && token.id === currentTokenId,
  };
}

/**
 * The audit query. Plain `z.object`, like every query schema: an unknown query
 * parameter is ignored, not refused.
 */
export const auditQuerySchema = z.object({
  actorId: z.uuid().optional(),
  action: z.string().max(64).optional(),
  projectSlug: slugSchema.optional(),
  environmentSlug: environmentSlugSchema.optional(),
  outcome: z.enum(['success', 'denied', 'error']).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * The keyset cursor, as an opaque string.
 *
 * base64url over `createdAt|id` — encoded so a client cannot mistake it for
 * something to do arithmetic on, and decoded defensively because a client can
 * still hand back anything it likes. A malformed cursor is a 400, not a crash.
 */
export function encodeAuditCursor(cursor: AuditCursor): string {
  const packed = `${cursor.createdAt.toISOString()}|${cursor.id}`;
  return toBase64Url(new TextEncoder().encode(packed));
}

export function decodeAuditCursor(value: string): AuditCursor {
  const malformed = () => errors.badRequest('The cursor is not one this endpoint issued.');

  let packed: string;
  try {
    packed = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(value));
  } catch {
    throw malformed();
  }

  const separator = packed.indexOf('|');
  if (separator === -1) throw malformed();

  const createdAt = new Date(packed.slice(0, separator));
  const id = packed.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw malformed();

  return { createdAt, id };
}

export interface AuditEventPayload {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: AuditAction;
  resourceType: string | null;
  resourceId: string | null;
  projectId: string | null;
  environmentId: string | null;
  outcome: string;
  ipAddress: string | null;
  requestId: string | null;
  metadata: AuditMetadata;
  createdAt: string;
}

/**
 * The row, almost verbatim: everything in it was written by the audit builder,
 * which already sanitised and redacted on the way in. `userAgent` is withheld —
 * it is stored for incident response, and a screenful of browser strings buys
 * the UI nothing.
 */
export function toAuditEvent(record: AuditLogRecord): AuditEventPayload {
  return {
    id: record.id,
    actorType: record.actorType,
    actorId: record.actorId,
    actorLabel: record.actorLabel,
    action: record.action as AuditAction,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    projectId: record.projectId,
    environmentId: record.environmentId,
    outcome: record.outcome,
    ipAddress: record.ipAddress,
    requestId: record.requestId,
    metadata: record.metadata,
    createdAt: record.createdAt.toISOString(),
  };
}
