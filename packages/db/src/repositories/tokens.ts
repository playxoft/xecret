import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@xecret/core/ids';
import { generateToken } from '@xecret/core/auth';
import type { Bytes } from '@xecret/core/crypto';
import type { AccessLevel } from '@xecret/core/authz';
import { cliTokens, serviceTokens } from '../schema/tokens';
import { MAX_PAGE_SIZE, RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * CLI tokens and service tokens.
 *
 * These are two tables and two sets of functions on purpose, and they are not
 * unified behind a generic `findTokenByHash`. A CLI token carries a `user_id`
 * and therefore acts *as a person*; a service token carries none and is pinned
 * to one project and one environment. Threat T5 — a compromised CI pipeline — is
 * contained by exactly that difference, and a shared code path is how the
 * difference erodes: one nullable field, one `if (token.userId)`, and a stolen
 * build credential is suddenly a session. Duplication here is cheaper than the
 * abstraction it would take to make the two safe to merge.
 *
 * Nothing in this file ever returns `token_hash`. The listing select lists are
 * written out column by column rather than filtered afterwards, so the hash does
 * not travel just because a row was fetched.
 */

export interface CreateCliTokenParams {
  orgId: string;
  userId: string;
  /** Device name, shown in the revoke UI. */
  name: string;
  expiresAt?: Date | null | undefined;
  environment?: 'live' | 'test' | undefined;
}

export interface CreateServiceTokenParams {
  orgId: string;
  projectId: string;
  environmentId: string;
  name: string;
  accessLevel?: AccessLevel | undefined;
  /** CIDR ranges or exact addresses. Empty or absent means "any address". */
  ipAllowlist?: readonly string[] | null | undefined;
  expiresAt?: Date | null | undefined;
  createdBy: string;
  environment?: 'live' | 'test' | undefined;
}

export interface CliTokenSummary {
  id: string;
  userId: string;
  orgId: string;
  name: string;
  tokenPrefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
}

export interface ServiceTokenSummary {
  id: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  name: string;
  tokenPrefix: string;
  accessLevel: AccessLevel;
  ipAllowlist: string[] | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
}

/** A freshly minted token. `token` is displayed once and never recoverable. */
export interface IssuedToken<TRecord> {
  token: string;
  record: TRecord;
}

/** Everything authentication needs about a presented CLI token. */
export interface CliTokenPrincipal {
  id: string;
  userId: string;
  orgId: string;
  name: string;
  tokenPrefix: string;
  expiresAt: Date | null;
}

/**
 * Everything authorization needs about a presented service token.
 *
 * A service token's permissions are entirely determined by this row — there is
 * no membership to resolve and no grant to look up — so the lookup returns the
 * pinned scope in the same query. That is what keeps CI authentication to one
 * statement.
 */
export interface ServiceTokenPrincipal {
  id: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  name: string;
  tokenPrefix: string;
  accessLevel: AccessLevel;
  ipAllowlist: string[] | null;
  expiresAt: Date | null;
}

/**
 * Issues a CLI token.
 *
 * The token is generated here rather than accepted as a parameter so that there
 * is exactly one place where a credential comes into existence and it is the
 * same place that decides what is persisted. A caller cannot pass the plaintext
 * where the hash belongs, because the caller never holds it first.
 */
export async function createCliToken(
  exec: Executor,
  params: CreateCliTokenParams,
): Promise<IssuedToken<CliTokenSummary>> {
  const generated = await generateToken('cli', params.environment ?? 'live');

  const [record] = await exec
    .insert(cliTokens)
    .values({
      id: uuidv7(),
      userId: params.userId,
      orgId: params.orgId,
      name: params.name,
      tokenHash: generated.hash,
      tokenPrefix: generated.prefix,
      expiresAt: params.expiresAt ?? null,
    })
    .returning(cliTokenColumns);

  if (!record) {
    throw new RepositoryError('conflict', 'Failed to issue a CLI token');
  }

  return { token: generated.token, record };
}

/**
 * Resolves a presented CLI token.
 *
 * Takes no `orgId`: the token is what establishes the organisation, so demanding
 * one here would mean the caller had already decided the answer.
 *
 * Expiry is compared against `now()` in the database rather than a JavaScript
 * `Date`. A Worker's clock is not the database's, and "the credential is still
 * valid" must not depend on which of the two is running fast.
 */
export async function findCliTokenByHash(
  exec: Executor,
  tokenHash: Bytes,
): Promise<CliTokenPrincipal | undefined> {
  const [row] = await exec
    .select({
      id: cliTokens.id,
      userId: cliTokens.userId,
      orgId: cliTokens.orgId,
      name: cliTokens.name,
      tokenPrefix: cliTokens.tokenPrefix,
      expiresAt: cliTokens.expiresAt,
    })
    .from(cliTokens)
    .where(
      and(
        eq(cliTokens.tokenHash, tokenHash),
        isNull(cliTokens.revokedAt),
        or(isNull(cliTokens.expiresAt), sql`${cliTokens.expiresAt} > now()`),
      ),
    )
    .limit(1);

  return row;
}

/**
 * Lists a user's CLI tokens within an organisation, revoked ones included so the
 * UI can show recent revocations. **Never selects `token_hash`.**
 */
export async function listCliTokens(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<CliTokenSummary[]> {
  return exec
    .select(cliTokenColumns)
    .from(cliTokens)
    .where(and(eq(cliTokens.orgId, orgId), eq(cliTokens.userId, userId)))
    .orderBy(desc(cliTokens.createdAt))
    .limit(MAX_PAGE_SIZE);
}

/**
 * One CLI token by id, for the revocation route's ownership check.
 *
 * "May I revoke this?" depends on whose device it is: anyone may kill their
 * own, and killing someone else's requires `token.revoke`. Never selects
 * `token_hash`, like every read in this file.
 */
export async function findCliTokenById(
  exec: Executor,
  orgId: string,
  tokenId: string,
): Promise<CliTokenSummary | undefined> {
  const [row] = await exec
    .select(cliTokenColumns)
    .from(cliTokens)
    .where(and(eq(cliTokens.orgId, orgId), eq(cliTokens.id, tokenId)))
    .limit(1);

  return row;
}

/**
 * Revokes a CLI token.
 *
 * Returns whether this call was the one that revoked it. Revoking an already
 * revoked token is not an error — the caller wanted the credential dead and it
 * is — but the distinction matters for whether an audit event should be emitted.
 */
export async function revokeCliToken(
  exec: Executor,
  orgId: string,
  tokenId: string,
): Promise<boolean> {
  const rows = await exec
    .update(cliTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(cliTokens.orgId, orgId), eq(cliTokens.id, tokenId), isNull(cliTokens.revokedAt)))
    .returning({ id: cliTokens.id });

  return rows.length > 0;
}

/**
 * Records that a CLI token was used.
 *
 * **Must not be awaited on the critical path.** This is telemetry for the "your
 * devices" screen, not an authorization step, and the request has already been
 * decided by the time it runs. Hand it to `ctx.waitUntil()` and let it settle
 * after the response: a write that blocks a secret read in order to update a
 * "last seen" timestamp has the priorities exactly backwards. For the same
 * reason a failure here must never fail the request.
 */
export async function touchCliTokenUsage(
  exec: Executor,
  tokenId: string,
  ipAddress: string | null,
): Promise<void> {
  await exec
    .update(cliTokens)
    .set({ lastUsedAt: sql`now()`, lastUsedIp: ipAddress })
    .where(eq(cliTokens.id, tokenId));
}

/**
 * Issues a service token.
 *
 * `accessLevel` defaults to `read` and the schema defaults it too. Both halves
 * are deliberate: a CI credential that silently acquires write access because a
 * caller forgot a field is the kind of default that only gets noticed after it
 * has been exploited.
 */
export async function createServiceToken(
  exec: Executor,
  params: CreateServiceTokenParams,
): Promise<IssuedToken<ServiceTokenSummary>> {
  const generated = await generateToken('service', params.environment ?? 'live');

  const [record] = await exec
    .insert(serviceTokens)
    .values({
      id: uuidv7(),
      orgId: params.orgId,
      projectId: params.projectId,
      environmentId: params.environmentId,
      name: params.name,
      tokenHash: generated.hash,
      tokenPrefix: generated.prefix,
      accessLevel: params.accessLevel ?? 'read',
      // An empty array would mean "no address is permitted", which is not what a
      // caller passing `[]` intends. NULL is the schema's "unrestricted".
      ipAllowlist:
        params.ipAllowlist && params.ipAllowlist.length > 0 ? [...params.ipAllowlist] : null,
      createdBy: params.createdBy,
      expiresAt: params.expiresAt ?? null,
    })
    .returning(serviceTokenColumns);

  if (!record) {
    throw new RepositoryError('conflict', 'Failed to issue a service token');
  }

  return { token: generated.token, record };
}

/**
 * Resolves a presented service token, with its pinned scope.
 *
 * Everything needed to authorize the request comes back in this one row:
 * organisation, project, environment, and access level. There is no membership
 * join because a service token has no member — that absence is the blast-radius
 * control for threat T5, not an omission.
 */
export async function findServiceTokenByHash(
  exec: Executor,
  tokenHash: Bytes,
): Promise<ServiceTokenPrincipal | undefined> {
  const [row] = await exec
    .select({
      id: serviceTokens.id,
      orgId: serviceTokens.orgId,
      projectId: serviceTokens.projectId,
      environmentId: serviceTokens.environmentId,
      name: serviceTokens.name,
      tokenPrefix: serviceTokens.tokenPrefix,
      accessLevel: serviceTokens.accessLevel,
      ipAllowlist: serviceTokens.ipAllowlist,
      expiresAt: serviceTokens.expiresAt,
    })
    .from(serviceTokens)
    .where(
      and(
        eq(serviceTokens.tokenHash, tokenHash),
        isNull(serviceTokens.revokedAt),
        or(isNull(serviceTokens.expiresAt), sql`${serviceTokens.expiresAt} > now()`),
      ),
    )
    .limit(1);

  return row;
}

/** Lists an organisation's service tokens. **Never selects `token_hash`.** */
export async function listServiceTokens(
  exec: Executor,
  orgId: string,
  projectId?: string,
): Promise<ServiceTokenSummary[]> {
  const scope = projectId
    ? and(eq(serviceTokens.orgId, orgId), eq(serviceTokens.projectId, projectId))
    : eq(serviceTokens.orgId, orgId);

  return exec
    .select(serviceTokenColumns)
    .from(serviceTokens)
    .where(scope)
    .orderBy(desc(serviceTokens.createdAt))
    .limit(MAX_PAGE_SIZE);
}

/** Revokes a service token. Returns whether this call was the one that did it. */
export async function revokeServiceToken(
  exec: Executor,
  orgId: string,
  tokenId: string,
): Promise<boolean> {
  const rows = await exec
    .update(serviceTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(serviceTokens.orgId, orgId),
        eq(serviceTokens.id, tokenId),
        isNull(serviceTokens.revokedAt),
      ),
    )
    .returning({ id: serviceTokens.id });

  return rows.length > 0;
}

/**
 * Records that a service token was used. Same rule as `touchCliTokenUsage`:
 * never awaited on the critical path, never allowed to fail a request.
 */
export async function touchServiceTokenUsage(
  exec: Executor,
  tokenId: string,
  ipAddress: string | null,
): Promise<void> {
  await exec
    .update(serviceTokens)
    .set({ lastUsedAt: sql`now()`, lastUsedIp: ipAddress })
    .where(eq(serviceTokens.id, tokenId));
}

/**
 * Decides whether a source address satisfies a service token's IP allowlist.
 *
 * Pure and synchronous so it is trivially unit-testable — this is an
 * authorization decision, and an authorization decision that needs a database to
 * exercise does not get tested at the edges where it fails.
 *
 * Semantics:
 *
 * - An absent or empty allowlist means **allow all**. `NULL` is the schema's
 *   "unrestricted"; `createServiceToken` normalises `[]` to `NULL` so the two
 *   cannot disagree.
 * - Exact addresses and CIDR ranges are both accepted, for IPv4 and IPv6.
 * - A malformed source address is denied, and a malformed allowlist entry simply
 *   never matches. Both fail closed. PostgreSQL validates `inet` on write so
 *   entries arrive well-formed, but "the database would have rejected it" is not
 *   a reason for a security predicate to trust its input.
 *
 * **IPv4-mapped IPv6 is deliberately not normalised.** `::ffff:203.0.113.5` does
 * not match an allowlist entry of `203.0.113.5`, and vice versa. Silently
 * equating the two would make an allowlist match an address the operator never
 * wrote down; an operator whose clients arrive over both families writes both
 * entries, which is explicit and auditable. Zone identifiers (`fe80::1%eth0`)
 * are rejected rather than stripped, for the same reason.
 */
export function isIpAllowed(allowlist: readonly string[] | null | undefined, ip: string): boolean {
  if (!allowlist || allowlist.length === 0) return true;

  const address = parseIpAddress(ip);
  if (!address) return false;

  return allowlist.some((entry) => matchesAllowlistEntry(entry, address));
}

/** Explicit column list. `token_hash` is absent by construction, not by filter. */
const cliTokenColumns = {
  id: cliTokens.id,
  userId: cliTokens.userId,
  orgId: cliTokens.orgId,
  name: cliTokens.name,
  tokenPrefix: cliTokens.tokenPrefix,
  createdAt: cliTokens.createdAt,
  expiresAt: cliTokens.expiresAt,
  lastUsedAt: cliTokens.lastUsedAt,
  lastUsedIp: cliTokens.lastUsedIp,
  revokedAt: cliTokens.revokedAt,
};

/** Explicit column list. `token_hash` is absent by construction, not by filter. */
const serviceTokenColumns = {
  id: serviceTokens.id,
  orgId: serviceTokens.orgId,
  projectId: serviceTokens.projectId,
  environmentId: serviceTokens.environmentId,
  name: serviceTokens.name,
  tokenPrefix: serviceTokens.tokenPrefix,
  accessLevel: serviceTokens.accessLevel,
  ipAllowlist: serviceTokens.ipAllowlist,
  createdBy: serviceTokens.createdBy,
  createdAt: serviceTokens.createdAt,
  expiresAt: serviceTokens.expiresAt,
  lastUsedAt: serviceTokens.lastUsedAt,
  lastUsedIp: serviceTokens.lastUsedIp,
  revokedAt: serviceTokens.revokedAt,
};

function matchesAllowlistEntry(entry: string, address: Uint8Array): boolean {
  const separator = entry.indexOf('/');
  const network = parseIpAddress(separator === -1 ? entry : entry.slice(0, separator));

  // Length is the address family: 4 bytes or 16. An IPv4 entry can never match
  // an IPv6 client, however similar the two look written down.
  if (!network || network.length !== address.length) return false;

  if (separator === -1) return sharesPrefix(network, address, network.length * 8);

  const prefixLength = parsePrefixLength(entry.slice(separator + 1), network.length * 8);
  if (prefixLength === undefined) return false;

  return sharesPrefix(network, address, prefixLength);
}

function parsePrefixLength(value: string, maximum: number): number | undefined {
  if (!/^(0|[1-9][0-9]{0,2})$/.test(value)) return undefined;
  const bits = Number(value);
  return bits <= maximum ? bits : undefined;
}

function sharesPrefix(network: Uint8Array, address: Uint8Array, prefixBits: number): boolean {
  const wholeBytes = prefixBits >> 3;

  for (let i = 0; i < wholeBytes; i += 1) {
    if (network[i] !== address[i]) return false;
  }

  const remainingBits = prefixBits & 7;
  if (remainingBits === 0) return true;

  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((network[wholeBytes] ?? 0) & mask) === ((address[wholeBytes] ?? 0) & mask);
}

/** Parses an address into 4 bytes (IPv4) or 16 (IPv6). `undefined` if malformed. */
function parseIpAddress(value: string): Uint8Array | undefined {
  return value.includes(':') ? parseIpv6(value) : parseIpv4(value);
}

function parseIpv4(value: string): Uint8Array | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;

  const bytes = new Uint8Array(4);

  for (let i = 0; i < 4; i += 1) {
    // Leading zeros are rejected rather than trimmed: `010` is octal to some
    // resolvers and decimal to others, and an allowlist entry that means two
    // different things depending on who reads it is not an allowlist entry.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[i]!)) return undefined;

    const octet = Number(parts[i]);
    if (octet > 255) return undefined;
    bytes[i] = octet;
  }

  return bytes;
}

function parseIpv6(value: string): Uint8Array | undefined {
  if (value.includes('%')) return undefined;

  const halves = value.split('::');
  if (halves.length > 2) return undefined;

  const compressed = halves.length === 2;
  const head = expandIpv6Groups(halves[0] ?? '');
  const tail = expandIpv6Groups(compressed ? (halves[1] ?? '') : '');
  if (!head || !tail) return undefined;

  const gap = 16 - head.length - tail.length;
  // `::` stands for at least one omitted group; without it the address must
  // already be exactly eight groups.
  if (compressed ? gap < 2 : gap !== 0) return undefined;

  const bytes = new Uint8Array(16);
  bytes.set(head, 0);
  bytes.set(tail, 16 - tail.length);
  return bytes;
}

function expandIpv6Groups(text: string): Uint8Array | undefined {
  if (text === '') return new Uint8Array(0);

  const groups = text.split(':');
  const bytes: number[] = [];

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i]!;

    if (group.includes('.')) {
      // An embedded IPv4 literal is only legal as the final group, as in
      // `::ffff:203.0.113.5`.
      if (i !== groups.length - 1) return undefined;

      const embedded = parseIpv4(group);
      if (!embedded) return undefined;
      bytes.push(...embedded);
      continue;
    }

    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;

    const word = Number.parseInt(group, 16);
    bytes.push((word >>> 8) & 0xff, word & 0xff);
  }

  return bytes.length > 16 ? undefined : Uint8Array.from(bytes);
}
