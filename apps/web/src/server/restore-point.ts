import { cheapestPlanWithLimit } from '@xecret/core/entitlements';
import type { DeclaredReference } from '@xecret/core/references';
import {
  findGrantsForPrincipalOnKeys,
  loadEnvironmentSecrets,
  loadEnvironmentSecretsAt,
  toBytes,
} from '@xecret/db/repositories';
import type { SecretMaterial } from '@xecret/db/repositories';
import { timingSafeEqual } from '@xecret/core/crypto';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { grantRecipient } from './env-keys-service';
import { errors } from './errors';
import { encodePublicKey } from './schemas/env-keys';
import { toClientSecret } from './schemas/secrets';
import type { ClientSecretPayload } from './schemas/secrets';
import { decodeBlob } from './schemas/vault';
import type { ExistingSecret } from './secrets-service';
import type { EnvironmentScope } from './tenancy';

/**
 * Point-in-time restore (P19 §4, `pointInTimeRestore`, window `plans.pitrDays`):
 * "put this environment back the way it was at 14:30 yesterday".
 *
 * ── What "the way it was" means, precisely ──
 * Every secret that was live at the instant, at the version that was current
 * then — including one deleted since — and none of the secrets created after it.
 * Matched to today's rows by the row first, then by name: a secret deleted and
 * re-created under the same name since is the same variable to everything that
 * reads it, so its value is written onto the row that holds the name today.
 *
 * Names are not versioned. A secret renamed since the instant keeps today's
 * name; a restore puts back values, not labels.
 *
 * ── Restore never deletes history ──
 * It writes forward, and every act it takes leaves the record it found:
 *  - a changed value becomes a **new version** of its row;
 *  - a secret created since is **soft-deleted** — its versions kept;
 *  - a secret deleted since is **created again**, as a new row holding the old
 *    value, beside the deleted one. Not revived: clearing the old row's
 *    `deleted_at` would erase the fact that it was deleted, and the next restore
 *    to a moment in between would believe it never had been.
 * So a restore is itself restorable — undoing one is restoring to the moment
 * before it — and the test suite does exactly that.
 *
 * ── Who does the cryptography ──
 * The client. The server serves the historical ciphertexts and the caller's own
 * grants for the keys they were written under — a retired key's grant opens the
 * history it was rotated away from — and the client decrypts each, re-encrypts it
 * under today's key for the row and version it will land on, and sends it back.
 * The server checks each against the instant's value tag, which survives an EDK
 * rotation (it is keyed from the environment's HMAC key), so a client that sent
 * the wrong value — a bug, a stale cache — is refused rather than restored.
 *
 * A version written under a key the caller holds no grant for cannot be
 * restored by that caller, and the plan says so: it is listed, left as it is,
 * and reported, rather than silently skipped.
 */

const DAY_MS = 86_400_000;

export type RestoreAction = 'update' | 'recreate' | 'delete' | 'unchanged';

export interface RestoreItem {
  name: string;
  action: RestoreAction;
  /**
   * The row the change lands on: today's row for an update or a deletion, `null`
   * for a re-creation, whose new row's id the client chooses — it is in the AAD
   * the client seals under, so it is the client's to pick, as for any create.
   */
  secretId: string | null;
  /** The version a write must be sealed for; `null` when nothing is written. */
  expectedVersion: number | null;
  /** The type the secret holds after the restore. */
  valueType: string;
  /** The value at the instant, for the client to open. `null` for a deletion. */
  from: (ClientSecretPayload & { template?: true; references?: DeclaredReference[] }) | null;
  /** Whether the caller holds a grant for the key `from` was written under. */
  available: boolean;
  /** Internal: what the no-op and integrity checks compare against. */
  expectedHmac: Uint8Array | null;
  /** Internal: the row an update appends to. */
  existing: ExistingSecret | undefined;
}

export interface RestorePlan {
  at: Date;
  items: RestoreItem[];
  /** The caller's grants for every key a restorable version was written under. */
  keys: Record<
    string,
    {
      version: number;
      myGrant: {
        recipientPublicKey: string;
        edkSealed: string;
        ehkSealed: string;
        signature: string;
        signedByUserId: string;
      };
    }
  >;
}

/**
 * The window check. Refuses an instant in the future, and one older than the
 * plan's `pitrDays`, with the cheapest plan whose window would reach it.
 */
export function assertWithinWindow(scope: EnvironmentScope, at: Date, now: Date): void {
  if (at.getTime() > now.getTime()) {
    throw errors.validation([{ field: 'at', message: 'A restore point cannot be in the future.' }]);
  }
  const days = scope.entitlements.limits.pitrDays;
  const ageDays = Math.ceil((now.getTime() - at.getTime()) / DAY_MS);
  if (ageDays <= days) return;

  const upgradeTo = cheapestPlanWithLimit('pitrDays', ageDays);
  throw errors.planLimit(
    days === 0
      ? 'Point-in-time restore is not included in this plan.'
      : `This plan restores to at most ${days} days ago; that point is ${ageDays} days ago.` +
          (upgradeTo === null ? '' : ` The ${upgradeTo} plan reaches it.`),
    {
      resource: 'pitrDays',
      limit: days,
      current: ageDays,
      plan: scope.entitlements.plan,
      upgradeTo,
    },
  );
}

function sameTag(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return false;
  const left = toBytes(a);
  const right = toBytes(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameDeclaration(a: SecretMaterial, b: SecretMaterial): boolean {
  return (
    JSON.stringify(a.declaredReferences ?? null) === JSON.stringify(b.declaredReferences ?? null)
  );
}

function existingOf(material: SecretMaterial): ExistingSecret {
  return {
    secretId: material.secretId,
    version: material.version,
    valueHmac: material.valueHmac,
    valueType: material.valueType,
    declaredReferences: material.declaredReferences,
  };
}

/**
 * The type a restored value holds: a template exactly when the version restored
 * declared references — so a value written as text is not read as a template
 * because the row became one since, nor the reverse — and otherwise the row's
 * own type, which is not versioned.
 */
function restoredType(rowType: string, version: SecretMaterial): string {
  if (version.declaredReferences !== null) return 'template';
  return rowType === 'template' ? 'string' : rowType;
}

function fromPayload(material: SecretMaterial): RestoreItem['from'] {
  const payload: NonNullable<RestoreItem['from']> = toClientSecret(material);
  if (material.declaredReferences !== null) {
    payload.template = true;
    payload.references = material.declaredReferences;
  }
  return payload;
}

/** What restoring `scope` to `at` would do. Three statements, whatever the size. */
export async function planRestore(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  at: Date,
): Promise<RestorePlan> {
  const orgId = scope.organization.id;
  const then = await loadEnvironmentSecretsAt(services.db, orgId, scope.environment.id, at);
  const now = await loadEnvironmentSecrets(services.db, orgId, scope.environment.id);

  const liveById = new Map(now.map((secret) => [secret.secretId, secret]));
  const liveByName = new Map(now.map((secret) => [secret.name, secret]));
  const claimed = new Set<string>();
  const recreated = new Set<string>();

  const items: RestoreItem[] = [];
  for (const version of then) {
    const row = liveById.get(version.secretId) ?? liveByName.get(version.name);
    // A row is written once. Two secrets of the instant reaching one row today
    // takes renames on both sides of a deletion; the second is left as it is.
    if (row !== undefined) {
      if (claimed.has(row.secretId)) continue;
      claimed.add(row.secretId);
      const unchanged = sameTag(row.valueHmac, version.valueHmac) && sameDeclaration(row, version);
      items.push({
        name: row.name,
        action: unchanged ? 'unchanged' : 'update',
        secretId: row.secretId,
        expectedVersion: unchanged ? null : row.version + 1,
        valueType: restoredType(row.valueType, version),
        from: fromPayload(version),
        available: true,
        expectedHmac: version.valueHmac,
        existing: existingOf(row),
      });
      continue;
    }

    // Deleted since, and its name free: created again, as a new row.
    if (recreated.has(version.name)) continue;
    recreated.add(version.name);
    items.push({
      name: version.name,
      action: 'recreate',
      secretId: null,
      expectedVersion: 1,
      valueType: restoredType(version.valueType, version),
      from: fromPayload(version),
      available: true,
      expectedHmac: version.valueHmac,
      existing: undefined,
    });
  }

  for (const row of now) {
    if (claimed.has(row.secretId)) continue;
    items.push({
      name: row.name,
      action: 'delete',
      secretId: row.secretId,
      expectedVersion: null,
      valueType: row.valueType,
      from: null,
      available: true,
      expectedHmac: null,
      existing: existingOf(row),
    });
  }

  // The keys the restorable versions were sealed under, and the caller's grant
  // on each — active or retired. One statement.
  const writing = (item: RestoreItem) =>
    (item.action === 'update' || item.action === 'recreate') && item.expectedVersion !== null;
  const needed = [
    ...new Set(
      items
        .filter(writing)
        .map((item) => item.from?.envDataKeyId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const recipient = grantRecipient(principal);
  const grants = await findGrantsForPrincipalOnKeys(services.db, {
    orgId,
    environmentId: scope.environment.id,
    envDataKeyIds: needed,
    recipientKind: recipient.kind,
    recipientId: recipient.id,
  });

  const keys: RestorePlan['keys'] = {};
  for (const [keyId, held] of grants) {
    keys[keyId] = {
      version: held.keyVersion,
      myGrant: {
        recipientPublicKey: encodePublicKey(toBytes(held.grant.recipientPublicKey)),
        edkSealed: decodeBlob(toBytes(held.grant.edkSealed)),
        ehkSealed: decodeBlob(toBytes(held.grant.ehkSealed)),
        signature: decodeBlob(toBytes(held.grant.signature)),
        signedByUserId: held.grant.signedByUserId,
      },
    };
  }
  for (const item of items) {
    const keyId = item.from?.envDataKeyId;
    if (writing(item) && (typeof keyId !== 'string' || keys[keyId] === undefined)) {
      item.available = false;
    }
  }

  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { at, items, keys };
}

/** A plan as the API serves it: without the internal comparison fields. */
export function toRestorePlanPayload(plan: RestorePlan, scope: EnvironmentScope, now: Date) {
  const days = scope.entitlements.limits.pitrDays;
  const count = (action: RestoreAction) =>
    plan.items.filter((item) => item.action === action).length;
  return {
    at: plan.at.toISOString(),
    window: { days, earliest: new Date(now.getTime() - days * DAY_MS).toISOString() },
    items: plan.items.map((item) => ({
      name: item.name,
      action: item.action,
      secretId: item.secretId,
      expectedVersion: item.expectedVersion,
      valueType: item.valueType,
      available: item.available,
      from: item.from,
    })),
    keys: plan.keys,
    counts: {
      update: count('update'),
      recreate: count('recreate'),
      delete: count('delete'),
      unchanged: count('unchanged'),
      unavailable: plan.items.filter((item) => !item.available).length,
    },
  };
}

/** Whether `valueHmac` (from the client) is the instant's tag. */
export function matchesInstant(item: RestoreItem, valueHmac: Uint8Array): boolean {
  if (item.expectedHmac === null) return true;
  return sameTag(item.expectedHmac, valueHmac);
}
