'use client';

import { decryptSecret, openGrant, zeroize } from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import { uuidv7 } from '@xecret/core/ids';
import { api } from '@/lib/api';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';
import { withVaultKeys } from '@/components/vault/key-store';
import type { VaultKeyMaterial } from '@/components/vault/key-store';
import type { EnvironmentRef } from './env-keys';
import { withEnvKey } from './env-key-store';
import type { EnvKeyMaterial } from './env-key-store';
import type { ChangeEntry } from './promotion';
import { encryptValue } from './secret-crypto';
import { referencesFor } from './secret-io';
import type { ClientSecretCiphertext, MyGrant } from './types';

/**
 * Point-in-time restore (P19 §4), from a browser: "put this environment back
 * the way it was at 14:30 yesterday".
 *
 * ── What the server does, and what it cannot ──
 * It decides the plan — which secrets were live at the instant, at which
 * version, which have been created or deleted since — because that is names and
 * timestamps, which it can read. It serves the historical ciphertexts and the
 * caller's own grants for every key they were written under, *including retired
 * ones*: a value written before a rotation is still sealed under the key that
 * was active then, and the grant for that key is what opens it.
 *
 * What it cannot do is the restore itself, because a restore is a
 * **re-encryption**, never a copy. Every ciphertext is bound by its AAD to the
 * row and the version that hold it; the bytes of version 3 stored as version 9
 * open for nobody, ever. So for each value the plan says to write, this module:
 *
 *  1. opens the grant for the key the value was written under (`from.envDataKeyId`),
 *     with the vault's own X25519 key — exactly as the active grant is opened;
 *  2. decrypts `from` under that key, with the AAD of the row and version it was
 *     written *as* (`from.id`, `from.version`);
 *  3. encrypts the same plaintext under the environment's **current** active key,
 *     for the row it lands on (`item.secretId`, or a fresh uuid for a secret
 *     re-created as a new row) at the version it will occupy
 *     (`item.expectedVersion`);
 *  4. tags it under the environment's HMAC key. The server compares that tag
 *     with the instant's own and refuses a mismatch — the EHK survives
 *     rotations, so the same plaintext tags the same — which is the check that
 *     catches a stale cache or a bug sending the wrong value back. The text is
 *     NFC-normalised inside the tag, as on every write;
 *  5. for a template, declares the references re-parsed from the text it just
 *     decrypted, checked by the server against the graph as it stands today.
 *
 * Every value the plan writes must be sent: the server refuses a restore that
 * leaves one out, rather than applying part of an instant. Deletions and
 * unchanged rows need nothing from here — the server performs the first itself.
 *
 * ── A value written under a key this person never held ──
 * Is listed by the plan as unavailable and left exactly as it is; the server
 * reports it as skipped. Nothing is guessed.
 *
 * ── Plaintext lifetime ──
 * The opened plan holds every restored value, decrypted, so the preview can
 * reveal one on request. It lives as long as the dialog that asked for it and
 * goes nowhere else. The opened historical keys are zeroed before this module
 * returns: they are needed for one decryption each and never again.
 */

export type RestoreAction = 'update' | 'recreate' | 'delete' | 'unchanged';

/** One line of the plan, as `GET …/restore-point?at=` serves it. */
export interface RestorePlanItem {
  name: string;
  action: RestoreAction;
  /** Today's row for an update or a deletion; `null` for a re-creation, whose id the client picks. */
  secretId: string | null;
  /** The version a write must be sealed for; `null` when nothing is written. */
  expectedVersion: number | null;
  /** The type the secret holds after the restore. */
  valueType: string;
  /** Whether the caller holds a grant for the key `from` was written under. */
  available: boolean;
  /** The value at the instant. `null` for a deletion. */
  from: ClientSecretCiphertext | null;
}

/** One key a restorable version was written under, and the caller's grant on it. */
export interface RestorePlanKey {
  /** The key's version — part of the AAD the grant was sealed with. */
  version: number;
  myGrant: MyGrant;
}

export interface RestorePlan {
  at: string;
  /** How far back this plan reaches: `days`, and the earliest instant it allows. */
  window: { days: number; earliest: string };
  items: RestorePlanItem[];
  keys: Record<string, RestorePlanKey>;
  counts: {
    update: number;
    recreate: number;
    delete: number;
    unchanged: number;
    unavailable: number;
  };
}

export interface RestorePlanResponse {
  plan: RestorePlan;
}

/** What `POST …/restore-point` answers. */
export interface RestoreApplyResponse {
  dryRun: boolean;
  at: string;
  counts: { updated: number; recreated: number; deleted: number; unchanged: number };
  items: { name: string; action: RestoreAction; applied: boolean }[];
  skipped: string[];
}

/** Whether the plan writes a value for this item — the items every restore must send. */
export function writesValue(item: RestorePlanItem): boolean {
  return item.expectedVersion !== null && item.available;
}

/** One line of the preview: the plan's item, and its value at the instant when it opened. */
export interface OpenedRestoreItem {
  item: RestorePlanItem;
  /**
   * The value at the instant, decrypted, for a reveal on request. `null` for a
   * deletion, for a row the plan leaves alone, and for one that did not open.
   */
  value: string | null;
  /**
   * Why this item cannot be restored by this person, or `null`.
   *
   * `unavailable` is the plan's own verdict: the value was written under a key
   * the caller holds no grant for, so it stays as it is. `unreadable` is this
   * browser's: the grant was served and the value still did not open, which
   * blocks the restore — every value the plan writes has to be sent.
   */
  problem: 'unavailable' | 'unreadable' | null;
}

export interface OpenedRestore {
  items: OpenedRestoreItem[];
  /** The entries the restore sends, re-encrypted for today's rows and key. */
  writes: ChangeEntry[];
  /**
   * Names the plan writes and this browser could not prepare. While any are
   * listed the restore cannot be applied: the server refuses a restore that
   * leaves out a value it owes.
   */
  blocked: string[];
}

/** Opens one plan key with the vault's own private key. */
function openPlanKey(params: {
  vault: VaultKeyMaterial;
  environmentId: string;
  key: RestorePlanKey;
}): Promise<{ edk: Bytes; ehk: Bytes }> {
  return openGrant({
    recipient: {
      environmentId: params.environmentId,
      edkVersion: params.key.version,
      recipientKind: 'member',
      recipientId: params.vault.userId,
    },
    recipientPrivateKey: params.vault.encPrivateKey,
    grant: { edkSealed: params.key.myGrant.edkSealed, ehkSealed: params.key.myGrant.ehkSealed },
  });
}

/**
 * Turns a plan into the preview and the writes that apply it.
 *
 * Runs under both leases — the vault's, because grants are opened with its
 * private key, and the environment's, because every write is encrypted under
 * its current key — so a lock arriving mid-plan cannot zero either between two
 * entries. See `withEnvKey` for what encrypting under a zeroed key does.
 *
 * Built once and sent twice: the same entries go to the dry run and to the
 * apply, so the preview's verdict is a verdict on exactly the bytes applied.
 */
export async function openRestorePlan(params: {
  plan: RestorePlan;
  vault: VaultKeyMaterial;
  orgId: string;
  /** The environment's current, active key. Every restored value is sealed under it. */
  material: EnvKeyMaterial;
}): Promise<OpenedRestore> {
  const { plan, vault, orgId, material } = params;
  const environmentId = material.environmentId;

  return withVaultKeys(vault, () =>
    withEnvKey(material, async () => {
      const opened = new Map<string, { edk: Bytes; ehk: Bytes } | null>();

      /** The historical key a value was written under, opened once however many values use it. */
      async function keyFor(keyId: string): Promise<{ edk: Bytes; ehk: Bytes } | null> {
        if (opened.has(keyId)) return opened.get(keyId) ?? null;
        const served = plan.keys[keyId];
        let key: { edk: Bytes; ehk: Bytes } | null = null;
        if (served !== undefined) {
          try {
            key = await openPlanKey({ vault, environmentId, key: served });
          } catch {
            // A grant that does not open with this vault — sealed to a keypair
            // a vault reset replaced — is as good as no grant. Nothing of the
            // failure is kept.
            key = null;
          }
        }
        opened.set(keyId, key);
        return key;
      }

      const items: OpenedRestoreItem[] = [];
      const writes: ChangeEntry[] = [];
      const blocked: string[] = [];

      try {
        for (const item of plan.items) {
          const from = item.from;

          if (!item.available) {
            items.push({ item, value: null, problem: 'unavailable' });
            continue;
          }
          // A deletion has nothing to open; an unchanged row opens only if its
          // key was served, which the plan does for the keys it writes with.
          if (from === null) {
            items.push({ item, value: null, problem: null });
            continue;
          }

          const key = await keyFor(from.envDataKeyId);
          let plaintext: string | null = null;
          if (key !== null) {
            try {
              plaintext = await decryptSecret({
                edk: key.edk,
                context: {
                  field: 'value',
                  orgId,
                  environmentId,
                  // The row and version the value was written *as* — not the
                  // ones it is about to occupy.
                  secretId: from.id,
                  version: from.version,
                },
                blob: from.ciphertext,
              });
            } catch {
              plaintext = null;
            }
          }

          if (!writesValue(item)) {
            items.push({ item, value: plaintext, problem: null });
            continue;
          }

          if (plaintext === null) {
            items.push({ item, value: null, problem: 'unreadable' });
            blocked.push(item.name);
            continue;
          }

          // Today's row for an update; a new row, version 1, for a secret
          // re-created beside its deleted self. The server holds both to the plan.
          const secretId = item.secretId ?? uuidv7();
          const version = item.expectedVersion ?? 1;
          const value = await encryptValue({
            material,
            target: { orgId, environmentId, secretId },
            version,
            plaintext,
          });

          writes.push({
            id: secretId,
            name: item.name,
            expectedVersion: version,
            value,
            valueType: item.valueType,
            ...referencesFor(item.valueType, plaintext),
          });
          items.push({ item, value: plaintext, problem: null });
        }
      } finally {
        // Each historical key opened one decryption's worth of history and is
        // not wanted again. The current key belongs to the store and is left
        // alone.
        for (const key of opened.values()) {
          if (key === null) continue;
          zeroize(key.edk);
          zeroize(key.ehk);
        }
      }

      return { items, writes, blocked };
    }),
  );
}

/**
 * `<input type="datetime-local">` speaks local wall-clock time with no zone;
 * the API speaks ISO 8601 with an offset. These two convert between them in
 * the browser's own zone, which is the zone the person picking a time means.
 */
export function localInputToIso(value: string): string | null {
  if (value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Reads the plan for an instant. A plan refusal past the window names the plan that reaches it. */
export function fetchRestorePlan(target: EnvironmentRef, at: string): Promise<RestorePlanResponse> {
  return api.get<RestorePlanResponse>(
    withQuery(apiPath.restorePoint(target.orgSlug, target.projectSlug, target.envSlug), { at }),
  );
}

/** Sends a restore — the preview with `dryRun: true`, then the apply. */
export function postRestore(
  target: EnvironmentRef,
  body: { at: string; writes: ChangeEntry[]; dryRun: boolean },
): Promise<RestoreApplyResponse> {
  return api.post<RestoreApplyResponse>(
    apiPath.restorePoint(target.orgSlug, target.projectSlug, target.envSlug),
    body,
  );
}
