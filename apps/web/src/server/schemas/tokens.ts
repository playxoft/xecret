import * as z from 'zod/mini';
import type { AuditAction, AuditMetadata } from '@xecret/core/audit';
import type { AccessLevel } from '@xecret/core/authz';
import { fromBase64Url, toBase64Url } from '@xecret/core/crypto';
import { environmentSlugSchema, slugReferenceSchema } from '@xecret/core/validation';
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
  .check(
    z.trim(),
    z.minLength(1),
    z.maxLength(64),
    z.regex(/^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/, 'Enter an IP address or CIDR range.'),
  );

/**
 * A 32-byte X25519 public key, base64url — 43 characters.
 *
 * Shape only, as everywhere else in this file: the server validates the
 * alphabet and the length and never decodes the meaning. It cannot check that
 * this key has a private half anybody holds, and a token whose key nobody can
 * use simply fails to decrypt, loudly, on first use.
 */
const tokenPublicKeySchema = z
  .string()
  .check(
    z.regex(/^[A-Za-z0-9_-]+$/, 'A public key is 32 bytes, base64url encoded.'),
    z.length(43, 'A public key is 32 bytes, base64url encoded.'),
  );

export const serviceTokenCreateSchema = z.strictObject(
  {
    name: z
      .string()
      .check(
        z.trim(),
        z.minLength(1, 'Give the token a name.'),
        z.maxLength(TOKEN_NAME_MAX_LENGTH),
      ),
    projectSlug: slugReferenceSchema,
    environmentSlug: environmentSlugSchema,
    accessLevel: z.optional(serviceAccessSchema),
    /** ISO 8601. Absent means the token does not expire. */
    expiresAt: z.optional(z.iso.datetime()),
    ipAllowlist: z.optional(z.array(allowlistEntrySchema).check(z.maxLength(32))),
    /**
     * The token's own X25519 public key, base64url (spec §13.1).
     *
     * Present when the target environment is `e2ee`: the browser minted the
     * token's key half, kept it, and uploaded only this. The server never sees
     * the private half and could not seal a grant to this key even if it wanted
     * to — that is the browser's next request, to `…/keys/grants`.
     *
     * Absent for a `server`-mode environment, where a token needs no keypair,
     * and absent from every token minted before Phase 4.
     */
    publicKey: z.optional(tokenPublicKeySchema),
  },
  UNEXPECTED_FIELD,
);

export type ServiceTokenCreateRequest = z.infer<typeof serviceTokenCreateSchema>;

/**
 * The transported public key as the 32 raw bytes the `bytea` column holds.
 *
 * The schema has already pinned the alphabet and the length, so this cannot
 * fail on well-formed input; it is a decode, not a second validation.
 */
export function decodeTokenPublicKey(value: string): Uint8Array {
  return fromBase64Url(value);
}

/**
 * The keypair and the environment's mode have to agree, in both directions.
 *
 * ── The direction that only confuses a caller ──
 * A keypair belongs to a token only where there is something to seal to it.
 * Sending one to a `server`-mode environment is refused rather than ignored, for
 * the same reason the secret routes refuse `note` on an `e2ee` environment:
 * silently dropping a field a caller sent deliberately is how a client comes to
 * believe it did something it did not.
 *
 * ── The direction that produces a dead credential ──
 * A token minted for an `e2ee` environment with no public key has nothing an
 * environment key can ever be sealed to. It authenticates, it appears in the
 * listing, it is handed to somebody who pastes it into a pipeline — and it
 * decrypts nothing, permanently, because a token's key half is generated in the
 * browser at mint time and cannot be added afterwards. The token cannot be
 * un-minted either.
 *
 * A client reaches that by believing the environment is server-mode: a stale
 * project listing, a cache that had not loaded. Refusing here is what turns it
 * into a message somebody can act on instead of a credential that fails on its
 * first CI run with nothing pointing at why.
 *
 * A validation error rather than a conflict: the body does not describe a token
 * that can exist, and the field that is wrong can be named.
 */
export function assertKeypairMatchesMode(
  publicKey: string | undefined,
  encryptionMode: string,
): void {
  const e2ee = encryptionMode === 'e2ee';

  if (publicKey !== undefined && !e2ee) {
    throw errors.validation([
      {
        field: 'publicKey',
        message: 'This environment uses server-side encryption; a token needs no keypair.',
      },
    ]);
  }

  if (publicKey === undefined && e2ee) {
    throw errors.validation([
      {
        field: 'publicKey',
        message:
          'This environment is end-to-end encrypted, so a token must arrive with the public ' +
          'half of a keypair its client generated. Reload the dashboard and mint it again.',
      },
    ]);
  }
}

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
/**
 * `actorId=a`, `actorIds=a,b,c` — one actor or several.
 *
 * A comma-separated list rather than a repeated parameter because
 * `parseQuery` reads the query string through `Object.fromEntries`, where a
 * repeated name silently collapses to its last value: a UI filtering on three
 * people would have got one, with nothing to say it had happened. The single
 * `actorId` stays accepted — it is what the API reference has always
 * documented, and the two are merged in the route.
 *
 * Bounded at fifty so a query cannot be handed an `IN` list of unbounded
 * length, and each entry is still a uuid: a non-uuid here is a client bug
 * worth a 400, not an empty page somebody has to debug.
 */
/**
 * The bound, exported because the route enforces it a second time: `actorId`
 * and `actorIds` are merged there, and fifty plus one is fifty-one.
 */
export const ACTOR_FILTER_LIMIT = 50;

const actorIdListSchema = z.pipe(
  z.pipe(
    z.string().check(z.maxLength(2000)),
    z.transform((value: string) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    ),
  ),
  z
    .array(z.uuid())
    .check(
      z.maxLength(ACTOR_FILTER_LIMIT, `Filter by at most ${ACTOR_FILTER_LIMIT} actors at a time.`),
    ),
);

export const auditQuerySchema = z.object({
  actorId: z.optional(z.uuid()),
  actorIds: z.optional(actorIdListSchema),
  action: z.optional(z.string().check(z.maxLength(64))),
  projectSlug: z.optional(slugReferenceSchema),
  environmentSlug: z.optional(environmentSlugSchema),
  outcome: z.optional(z.enum(['success', 'denied', 'error'])),
  from: z.optional(z.iso.datetime()),
  to: z.optional(z.iso.datetime()),
  cursor: z.optional(z.string().check(z.maxLength(200))),
  limit: z.optional(z.pipe(z.coerce.number(), z.int().check(z.gte(1), z.lte(200)))),
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
