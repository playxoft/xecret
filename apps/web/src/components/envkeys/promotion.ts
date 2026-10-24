'use client';

import { uuidv7 } from '@xecret/core/ids';
import { api } from '@/lib/api';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';
import { policyViolations } from '@/components/policies/policy-checks';
import type { SecretPolicy } from '@xecret/core/policy';
import type { SecretListResponse } from '@/components/secrets/types';
import type { VaultKeyMaterial } from '@/components/vault/key-store';
import { openEnvironmentKeys, readRetiredKey } from './env-keys';
import type { EnvironmentRef, EnvKeyUnavailable } from './env-keys';
import { withEnvKey } from './env-key-store';
import type { EnvKeyMaterial } from './env-key-store';
import { decryptValue, encryptValue } from './secret-crypto';
import { OWN_VALUES_QUERY, referencesFor } from './secret-io';
import type {
  ClientEnvironmentBundle,
  ClientSecretCiphertext,
  ClientValueBody,
  DeclaredReferencePayload,
} from './types';

/**
 * Promoting one environment's values into another (P19 §3), from a browser.
 *
 * ── Why the client builds the diff ──
 * Both environments are end-to-end encrypted, so the server can read neither
 * value, and it could not tell "changed" from "unchanged" even if it tried:
 * each environment's value tags are keyed by that environment's own HMAC key,
 * so the same plaintext tags differently on each side. The only party that can
 * compare them is one holding both keys — this browser — so this module reads
 * both environments, opens both, and decides added / changed / removed /
 * unchanged with every value in hand. The screen shows the result masked.
 *
 * ── Why every promoted value is re-encrypted, not copied ──
 * A ciphertext is bound by its AAD to the organisation, the environment, the
 * row and the version that hold it, and opens only under its environment's
 * key. Bytes from staging stored in production would be a row nobody can ever
 * open. So each value is decrypted under the *source's* key and sealed again
 * under the **target's** active key, for the **target's** row — its existing id
 * where the name exists there, a fresh uuid where it does not — at the version
 * it will occupy: the stored version plus one, or 1. Its change-detection tag
 * is computed under the target's HMAC key, which is what lets the server answer
 * "unchanged" for a value the target already holds.
 *
 * ── What the server still decides ──
 * Everything that is not cryptography: the grants on both sides, that every
 * written name is one the source holds with the source's type, that every
 * removal is one the target holds and the source does not, the target's naming
 * policy, the template graph after the whole batch — and that the batch is one
 * transaction. A `dryRun` runs all of it and writes nothing, so the preview is
 * the promotion's own verdict rather than this module's guess.
 *
 * ── Plaintext lifetime ──
 * A snapshot holds every value of an environment, decrypted. It exists for the
 * duration of the promotion dialog — the dialog owns it in state and drops it
 * on close — and never leaves this process: nothing here logs, persists or
 * sends a plaintext, and every error message is built from names.
 */

/** How many listing pages a snapshot reads before giving up. See `listAllSecrets` in `secret-io.ts`. */
const MAX_LISTING_PAGES = 100;
const LISTING_PAGE_SIZE = 200;

/** One secret of an environment, read and opened for a change. */
export interface OpenedSecret {
  /** The row id: an AAD component, and the id a write to this row must carry. */
  id: string;
  name: string;
  /** The version currently stored. */
  version: number;
  /** The type the row declares. */
  valueType: string;
  /**
   * The plaintext, or `null` where this browser could not open it — a value
   * written before a rotation, under a key this session never held. Never an
   * empty string standing in for "unknown".
   */
  value: string | null;
}

/** An environment's own secrets, opened, and the key that opened them. */
export interface EnvironmentSnapshot {
  ref: EnvironmentRef;
  /** The environment's active key. A promotion *into* this environment encrypts under it. */
  material: EnvKeyMaterial;
  secrets: ReadonlyMap<string, OpenedSecret>;
}

/** Why an environment could not be read for a change. Its message names no value. */
export class SnapshotUnavailableError extends Error {
  constructor(
    readonly reason: EnvKeyUnavailable | 'server-mode',
    environment: string,
  ) {
    super(snapshotUnavailableMessage(reason, environment));
    this.name = 'SnapshotUnavailableError';
  }
}

function snapshotUnavailableMessage(reason: EnvKeyUnavailable | 'server-mode', name: string) {
  switch (reason) {
    case 'server-mode':
      return `${name} uses server-side encryption. Promotion needs both environments to be end-to-end encrypted.`;
    case 'locked':
      return `Unlock your vault to read ${name}.`;
    case 'pending':
      return `You have access to ${name} but nobody has shared its key with you yet.`;
    case 'unkeyed':
      return `${name} has no active key, so nothing in it can be read.`;
    case 'downgraded':
      return `${name} is reporting server-side encryption after this browser has seen it end-to-end encrypted. Nothing is read until that is explained.`;
  }
}

/** Every row of an environment's listing, for the types the bundle does not carry. */
async function listTypes(ref: EnvironmentRef): Promise<Map<string, string>> {
  const path = apiPath.secrets(ref.orgSlug, ref.projectSlug, ref.envSlug);
  const types = new Map<string, string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LISTING_PAGES; page += 1) {
    const response: SecretListResponse = await api.get<SecretListResponse>(
      withQuery(path, { limit: LISTING_PAGE_SIZE, ...(cursor === null ? {} : { cursor }) }),
    );
    for (const secret of response.data) types.set(secret.name, secret.valueType);
    cursor = response.nextCursor;
    if (cursor === null) return types;
  }
  throw new Error('This environment has more secrets than a promotion can read.');
}

/**
 * Opens one stored ciphertext with the key it names.
 *
 * The active key first; a retired one only if this session still holds it —
 * the store keeps every key version it has opened, which is exactly what a
 * value written before a rotation needs. Anything else is `null`: not readable
 * here, said so on screen, and never guessed at.
 */
async function openStored(
  orgId: string,
  material: EnvKeyMaterial,
  sealed: ClientSecretCiphertext,
): Promise<string | null> {
  const key =
    sealed.envDataKeyId === material.envDataKeyId
      ? material
      : readRetiredKey(material.environmentId, sealed.envDataKeyId);
  if (key === null) return null;
  try {
    return await decryptValue({
      material: key,
      target: { orgId, environmentId: material.environmentId, secretId: sealed.id },
      version: sealed.version,
      ciphertext: sealed.ciphertext,
    });
  } catch {
    // A ciphertext that does not open under the key it names — tampered with,
    // or bound to another row — is as unreadable as one under a key this
    // session never held, and is reported the same way: it is not promoted, and
    // nothing is guessed in its place. Nothing about the failure is kept; see
    // `lib/api.ts` on why a thrown value's message is never trusted here.
    return null;
  }
}

/**
 * Reads one environment's own secrets and opens every one it can.
 *
 * One audited pull — the same `GET …/pull?bundle=2&layers=none` reveal-all makes, so the
 * read is attributed to this person exactly as any other — plus the masked
 * listing for each row's declared type, which the bundle does not carry. The
 * key is opened from the grant that came *with* the ciphertexts, so a rotation
 * cannot land between reading the key and reading the values.
 *
 * Only the environment's own rows: an inherited value belongs to the parent and
 * is promoted from there, and a template is promoted as its text, references
 * and all, to be resolved wherever it lands.
 */
export async function readSnapshot(params: {
  ref: EnvironmentRef;
  orgId: string;
  vault: VaultKeyMaterial | null;
  /** The environment's name, for the refusal a person reads. */
  label: string;
}): Promise<EnvironmentSnapshot> {
  const { ref, orgId, vault, label } = params;
  const bundle = await api.get<Partial<ClientEnvironmentBundle>>(
    withQuery(apiPath.pull(ref.orgSlug, ref.projectSlug, ref.envSlug), {
      ...OWN_VALUES_QUERY,
      // A `server`-mode environment answers the flat JSON document for this,
      // rather than a `.env` file this client cannot parse — and is refused
      // below, by the absence of the bundle marker.
      format: 'json',
    }),
  );
  if (bundle.bundle !== true || bundle.keys === undefined || bundle.secrets === undefined) {
    throw new SnapshotUnavailableError('server-mode', label);
  }

  const opened = await openEnvironmentKeys(bundle.keys, vault);
  if (opened.status !== 'open') throw new SnapshotUnavailableError(opened.reason, label);
  const material = opened.material;
  const sealedSecrets = bundle.secrets;

  const types = await listTypes(ref);

  return withEnvKey(material, async () => {
    const secrets = new Map<string, OpenedSecret>();
    for (const sealed of sealedSecrets) {
      secrets.set(sealed.name, {
        id: sealed.id,
        name: sealed.name,
        version: sealed.version,
        // The listing's type where it has one. A row the listing has not caught
        // up with is a template if the bundle says so, and otherwise text — the
        // type every row starts as — and the server refuses a promotion whose
        // type disagrees with the source's, so a stale guess cannot land.
        valueType: types.get(sealed.name) ?? (sealed.template === true ? 'template' : 'string'),
        value: await openStored(orgId, material, sealed),
      });
    }
    return { ref, material, secrets };
  });
}

export type PromotionStatus = 'added' | 'changed' | 'unchanged' | 'removed' | 'unreadable';

/** One line of a promotion's preview. */
export interface PromotionItem {
  name: string;
  status: PromotionStatus;
  /** What the source holds, when it holds the name. */
  source: OpenedSecret | null;
  /** What the target holds, when it holds the name. */
  target: OpenedSecret | null;
  /** Whether the two declare different types — a change even where the values agree. */
  typeChanged: boolean;
  /**
   * Whether the target's current value could not be opened here, so the
   * comparison is unknown and the promotion is offered as a change. The server
   * still answers `unchanged` if it was the same value, by its tag.
   */
  targetUnknown: boolean;
}

/**
 * Two values the same, as the server's tag would judge them.
 *
 * The tag is computed over the NFC normalisation of the text (`computeValueHmac`
 * normalises before it hashes), so "é" typed as one code point and "é" typed as
 * two are the same value to the server — and must be the same here, or the
 * preview would promise a change the apply reports as unchanged.
 */
export function sameValue(a: string, b: string): boolean {
  return a.normalize('NFC') === b.normalize('NFC');
}

/**
 * The diff: every name either environment holds, in name order.
 *
 * - `added` — the source holds it and the target does not;
 * - `changed` — both hold it and the values or the types differ, or the
 *   target's value could not be read to tell;
 * - `unchanged` — both hold the same value under the same type;
 * - `removed` — the target holds it and the source does not. Offered, never
 *   assumed: a promotion removes nothing it was not told to;
 * - `unreadable` — the source holds it under a key this browser cannot open,
 *   so there is nothing to promote. Listed so its absence is explained.
 */
export function buildPromotionDiff(
  source: EnvironmentSnapshot,
  target: EnvironmentSnapshot,
): PromotionItem[] {
  const names = [...new Set([...source.secrets.keys(), ...target.secrets.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  return names.map((name) => {
    const from = source.secrets.get(name) ?? null;
    const to = target.secrets.get(name) ?? null;
    const typeChanged = from !== null && to !== null && from.valueType !== to.valueType;

    if (from === null) {
      return {
        name,
        status: 'removed',
        source: null,
        target: to,
        typeChanged,
        targetUnknown: false,
      };
    }
    if (from.value === null) {
      return {
        name,
        status: 'unreadable',
        source: from,
        target: to,
        typeChanged,
        targetUnknown: false,
      };
    }
    if (to === null) {
      return {
        name,
        status: 'added',
        source: from,
        target: null,
        typeChanged,
        targetUnknown: false,
      };
    }
    if (to.value === null) {
      return {
        name,
        status: 'changed',
        source: from,
        target: to,
        typeChanged,
        targetUnknown: true,
      };
    }
    const changed = typeChanged || !sameValue(from.value, to.value);
    return {
      name,
      status: changed ? 'changed' : 'unchanged',
      source: from,
      target: to,
      typeChanged,
      targetUnknown: false,
    };
  });
}

/** Which items a promotion offers by default: every addition and change, no removal. */
export function defaultSelection(items: readonly PromotionItem[]): Set<string> {
  return new Set(
    items
      .filter((item) => item.status === 'added' || item.status === 'changed')
      .map((item) => item.name),
  );
}

/** One write in a promotion or a restore body — `changeEntrySchema` on the server. */
export interface ChangeEntry {
  id: string;
  name: string;
  expectedVersion: number;
  value: ClientValueBody;
  valueType?: string;
  references?: DeclaredReferencePayload[];
}

/** `POST …/{target}/promote`. */
export interface PromotionBody {
  source: string;
  writes: ChangeEntry[];
  removals: string[];
  dryRun: boolean;
}

/** What `POST …/promote` answers. */
export interface PromotionResponse {
  dryRun: boolean;
  source: string;
  counts: { created: number; updated: number; unchanged: number; deleted: number };
  items: { name: string; status: 'created' | 'updated' | 'unchanged' | 'deleted' }[];
}

/**
 * The organisation's secret policy (P19 §8) over a promotion, before anything
 * is encrypted — the target's side of a production-scoped rule. A name new to
 * the target is held to the naming rule; every promoted value to the value
 * rules. Answers each refused name with why, never with the value.
 */
export function promotionPolicyProblems(
  policy: SecretPolicy | null,
  items: readonly PromotionItem[],
  selected: ReadonlySet<string>,
  targetIsProduction: boolean,
): { name: string; message: string }[] {
  const problems: { name: string; message: string }[] = [];
  for (const item of items) {
    if (!selected.has(item.name)) continue;
    if (item.status !== 'added' && item.status !== 'changed') continue;
    if (item.source === null || item.source.value === null) continue;
    const violations = policyViolations(policy, {
      name: item.name,
      newName: item.target === null,
      value: item.source.value,
      valueType: item.source.valueType,
      isProduction: targetIsProduction,
    });
    if (violations.length > 0) {
      problems.push({
        name: item.name,
        message: violations.map((violation) => violation.message).join(' '),
      });
    }
  }
  return problems;
}

/**
 * The body a promotion sends: every selected addition and change re-encrypted
 * for the target, and every selected removal named.
 *
 * Built under a lease on the target's key (`withEnvKey`), so a lock arriving
 * mid-batch cannot zero the key between two entries — see `env-key-store.ts`
 * for what AES-GCM under a zeroed key does. The source's key is not needed
 * here at all: its values were opened when the snapshot was read.
 */
export async function buildPromotionBody(params: {
  orgId: string;
  sourceSlug: string;
  target: EnvironmentSnapshot;
  items: readonly PromotionItem[];
  selected: ReadonlySet<string>;
  dryRun: boolean;
}): Promise<PromotionBody> {
  const { orgId, target } = params;
  const material = target.material;

  return withEnvKey(material, async () => {
    const writes: ChangeEntry[] = [];
    const removals: string[] = [];

    for (const item of params.items) {
      if (!params.selected.has(item.name)) continue;

      if (item.status === 'removed') {
        removals.push(item.name);
        continue;
      }
      if (item.status !== 'added' && item.status !== 'changed') continue;
      if (item.source === null || item.source.value === null) continue;

      // The target's row where the name exists there — its id is in the AAD of
      // every value that row holds — and a fresh uuid where it does not, which
      // the server stores the new row under.
      const id = item.target?.id ?? uuidv7();
      const expectedVersion = item.target === null ? 1 : item.target.version + 1;
      const value = await encryptValue({
        material,
        target: { orgId, environmentId: material.environmentId, secretId: id },
        version: expectedVersion,
        plaintext: item.source.value,
      });

      writes.push({
        id,
        name: item.name,
        expectedVersion,
        value,
        // The source's type, stated: the server refuses a promotion that
        // would change it, and a template carries its references with it.
        valueType: item.source.valueType,
        ...referencesFor(item.source.valueType, item.source.value),
      });
    }

    return { source: params.sourceSlug, writes, removals, dryRun: params.dryRun };
  });
}

/** Sends a promotion — the preview with `dryRun: true`, then the apply. */
export function postPromotion(target: EnvironmentRef, body: PromotionBody) {
  return api.post<PromotionResponse>(
    apiPath.promote(target.orgSlug, target.projectSlug, target.envSlug),
    body,
  );
}
