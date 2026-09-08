'use client';

import { uuidv7 } from '@xecret/core/ids';
import {
  buildImportPlan,
  detectFormat,
  parseDotenv,
  parseJson,
  parseShell,
  parseYaml,
} from '@xecret/core/importer';
import type {
  ConflictStrategy,
  ImportFormat,
  ImportPlan,
  ParseResult,
} from '@xecret/core/importer';
import { formatSecrets } from '@xecret/core/format';
import type { ExportFormat } from '@xecret/core/format';
import { api } from '@/lib/api';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';
import type {
  ImportPlanItem,
  ImportPlanResponse,
  SecretRestoreResponse,
  SecretWriteResponse,
} from '@/components/secrets/types';
import type { EnvKeyMaterial } from './env-key-store';
import { decryptValue, encodeNote, encryptValue } from './secret-crypto';
import type { SecretTarget } from './secret-crypto';
import type { ClientEnvironmentBundle } from './types';

/**
 * Every read and write of a secret, in whichever mode the environment is in.
 *
 * ── Why one interface rather than `if (e2ee)` in eight components ──
 * The dashboard's editor is a large, load-bearing piece of UI: the staged
 * changes, the reveal windows, the version drawer, the compare view, the import
 * preview. Threading a mode flag through all of it would put a branch between
 * every existing behaviour and its test, and — much worse — would give each
 * component its own opinion about which body shape to send. One mistake there is
 * a plaintext credential in a request to an `e2ee` environment, which is the one
 * failure this whole migration exists to prevent.
 *
 * So the mode is resolved once, here, and every component above talks in
 * plaintext to an object that knows how to get it. In `server` mode each method
 * is the request that was always sent. In `e2ee` mode the same method encrypts,
 * tags and posts the client body — and the component above cannot tell, which is
 * the point.
 *
 * ── What "ready" means ──
 * An `e2ee` environment whose key this browser has not opened cannot answer any
 * of these. Rather than each method failing at its own moment, the factory
 * refuses to produce a writable IO at all and the screen renders the reason —
 * locked vault, or a key nobody has shared yet. The lock screen already gates
 * the first; the second is a designed state with its own copy.
 */

/** Which row a value belongs to, as the table already knows it. */
export interface SecretRef {
  /** The `secrets` row id — an AAD component in `e2ee` mode. */
  id: string;
  name: string;
  /** The version currently stored. A write appends `version + 1`. */
  version: number;
}

export interface MetadataPatch {
  name?: string | undefined;
  /** `null` clears the note; `undefined` leaves it alone. */
  note?: string | null | undefined;
  valueType?: string | undefined;
}

export interface SecretIo {
  mode: 'server' | 'e2ee';
  /** The current plaintext of a secret. Audited on the server in both modes. */
  reveal: (secret: SecretRef) => Promise<string>;
  /** One historical version. May need a key that has been rotated away. */
  revealVersion: (secret: Pick<SecretRef, 'id' | 'name'>, version: number) => Promise<string>;
  /** Every current value, as one audited read. */
  pull: () => Promise<Record<string, string>>;
  create: (input: {
    name: string;
    value: string;
    note?: string | undefined;
    valueType: string;
  }) => Promise<SecretWriteResponse>;
  update: (
    secret: SecretRef,
    input: { value: string; valueType?: string | undefined },
  ) => Promise<SecretWriteResponse>;
  /** Metadata only. Appends no version, and needs no key in `server` mode. */
  patchMetadata: (secret: SecretRef, patch: MetadataPatch) => Promise<void>;
  restore: (secret: SecretRef, fromVersion: number) => Promise<SecretRestoreResponse>;
  /** Runs an import. `dryRun` previews without writing, in both modes. */
  runImport: (input: {
    content: string;
    filename: string | null;
    format: ImportFormat | 'auto';
    strategy: ConflictStrategy;
    dryRun: boolean;
    /** Names already in the environment. Only read on the `e2ee` path. */
    existingNames: readonly string[];
    /** The rows an overwrite appends to, by name. Only read on the `e2ee` path. */
    existing: ReadonlyMap<string, SecretRef>;
  }) => Promise<ImportPlanResponse>;
}

/** Where the environment is, and who is asking. */
export interface SecretIoContext {
  orgSlug: string;
  orgId: string;
  projectSlug: string;
  envSlug: string;
}

/** The `server`-mode IO: exactly the requests the dashboard always sent. */
export function serverSecretIo(context: SecretIoContext): SecretIo {
  const { orgSlug, projectSlug, envSlug } = context;

  return {
    mode: 'server',

    reveal: async (secret) => {
      const response = await api.get<{ secret: { value: string } }>(
        apiPath.secret(orgSlug, projectSlug, envSlug, secret.name),
      );
      return response.secret.value;
    },

    revealVersion: async (secret, version) => {
      const response = await api.get<{ secret: { value: string } }>(
        apiPath.secretVersion(orgSlug, projectSlug, envSlug, secret.name, version),
      );
      return response.secret.value;
    },

    pull: async () => {
      const document = await api.get<Record<string, unknown>>(
        withQuery(apiPath.pull(orgSlug, projectSlug, envSlug), { format: 'json' }),
      );
      return plaintextsOf(document);
    },

    create: (input) =>
      api.post<SecretWriteResponse>(apiPath.secrets(orgSlug, projectSlug, envSlug), {
        name: input.name,
        value: input.value,
        valueType: input.valueType,
        ...(input.note === undefined ? {} : { note: input.note }),
      }),

    update: (secret, input) =>
      api.patch<SecretWriteResponse>(apiPath.secret(orgSlug, projectSlug, envSlug, secret.name), {
        value: input.value,
        ...(input.valueType === undefined ? {} : { valueType: input.valueType }),
      }),

    patchMetadata: async (secret, patch) => {
      await api.put(apiPath.secret(orgSlug, projectSlug, envSlug, secret.name), {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.note === undefined ? {} : { note: patch.note }),
        ...(patch.valueType === undefined ? {} : { valueType: patch.valueType }),
      });
    },

    restore: (secret, fromVersion) =>
      api.post<SecretRestoreResponse>(
        apiPath.secretRestore(orgSlug, projectSlug, envSlug, secret.name),
        { version: fromVersion },
      ),

    runImport: (input) =>
      api.post<ImportPlanResponse>(apiPath.import(orgSlug, projectSlug, envSlug), {
        content: input.content,
        ...(input.format === 'auto' ? {} : { format: input.format }),
        ...(input.filename === null ? {} : { filename: input.filename }),
        strategy: input.strategy,
        dryRun: input.dryRun,
      }),
  };
}

/**
 * The `e2ee` IO: the same operations, with the cryptography on this side.
 *
 * `material` is the opened key. It is captured rather than looked up per call so
 * that an IO built for one key version cannot silently start using another
 * mid-batch — a rotation landing between two writes of one save produces a 409
 * from the server, which is a retry, rather than a set of rows sealed against
 * two different keys.
 */
export function clientSecretIo(context: SecretIoContext, material: EnvKeyMaterial): SecretIo {
  const { orgSlug, projectSlug, envSlug } = context;

  const targetFor = (secretId: string): SecretTarget => ({
    orgId: context.orgId,
    environmentId: material.environmentId,
    secretId,
  });

  /** Opens one stored ciphertext, given the row it came from. */
  async function open(sealed: {
    id: string;
    ciphertext: string;
    envDataKeyId: string;
    version: number;
  }): Promise<string> {
    if (sealed.envDataKeyId !== material.envDataKeyId) {
      // A version written before a rotation names the retired key. This session
      // may still hold it — the store keeps entries per key version — but the IO
      // is built around one key, so the honest answer is a named failure rather
      // than a decryption that fails for reasons nobody can read.
      throw new RotatedAwayError();
    }

    return decryptValue({
      material,
      target: targetFor(sealed.id),
      version: sealed.version,
      ciphertext: sealed.ciphertext,
    });
  }

  return {
    mode: 'e2ee',

    reveal: async (secret) => {
      const response = await api.get<{
        secret: { id: string; ciphertext: string; envDataKeyId: string; version: number };
      }>(apiPath.secret(orgSlug, projectSlug, envSlug, secret.name));
      return open(response.secret);
    },

    revealVersion: async (secret, version) => {
      const response = await api.get<{
        secret: { id: string; ciphertext: string; envDataKeyId: string; version: number };
      }>(apiPath.secretVersion(orgSlug, projectSlug, envSlug, secret.name, version));
      return open(response.secret);
    },

    pull: async () => {
      // The bundle carries the caller's grant *with* the values, so a rotation
      // cannot land between reading the key and reading the ciphertext. This IO
      // was built around one key, and the bundle's own `activeEdk` is checked
      // per row by `open` — a mismatch means the rotation happened first, and
      // the caller re-reads.
      const bundle = await api.get<ClientEnvironmentBundle>(
        apiPath.pull(orgSlug, projectSlug, envSlug),
      );

      const plaintexts: Record<string, string> = {};
      for (const secret of bundle.secrets) {
        plaintexts[secret.name] = await open(secret);
      }
      return plaintexts;
    },

    create: async (input) => {
      // The client mints the id, because the AAD binds it and the value is
      // encrypted before any request exists. See `id` on `createClientSecretBody`.
      const id = uuidv7();
      const target = targetFor(id);
      const value = await encryptValue({ material, target, version: 1, plaintext: input.value });
      const encNote = await encodeNote({ material, target, note: input.note });

      return api.post<SecretWriteResponse>(apiPath.secrets(orgSlug, projectSlug, envSlug), {
        id,
        name: input.name,
        value,
        valueType: input.valueType,
        ...(encNote === undefined ? {} : { encNote }),
      });
    },

    update: async (secret, input) => {
      const value = await encryptValue({
        material,
        target: targetFor(secret.id),
        // The version this ciphertext will be *stored* as. The server rejects a
        // row that lands at any other number, because the AAD would name one
        // version and the row another — unopenable, for ever, with a 200.
        version: secret.version + 1,
        plaintext: input.value,
      });

      return api.patch<SecretWriteResponse>(
        apiPath.secret(orgSlug, projectSlug, envSlug, secret.name),
        {
          value,
          ...(input.valueType === undefined ? {} : { valueType: input.valueType }),
        },
      );
    },

    patchMetadata: async (secret, patch) => {
      const encNote = await encodeNote({
        material,
        target: targetFor(secret.id),
        note: patch.note,
      });

      await api.put(apiPath.secret(orgSlug, projectSlug, envSlug, secret.name), {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        // `encNote` rather than `note`: sending a plaintext note to an `e2ee`
        // environment is refused rather than ignored, and rightly — a note is
        // free text people put credentials in.
        ...(encNote === undefined ? {} : { encNote }),
        ...(patch.valueType === undefined ? {} : { valueType: patch.valueType }),
      });
    },

    restore: async (secret, fromVersion) => {
      // A restore is a **re-encryption**, never a copy: the AAD binds `version`,
      // so the old bytes stored as a new version would fail to open for the rest
      // of their life. So the old version is read, decrypted, and encrypted
      // again for the version about to be written.
      const previous = await api.get<{
        secret: { id: string; ciphertext: string; envDataKeyId: string; version: number };
      }>(apiPath.secretVersion(orgSlug, projectSlug, envSlug, secret.name, fromVersion));

      const plaintext = await open(previous.secret);

      const value = await encryptValue({
        material,
        target: targetFor(secret.id),
        version: secret.version + 1,
        plaintext,
      });

      return api.post<SecretRestoreResponse>(
        apiPath.secretRestore(orgSlug, projectSlug, envSlug, secret.name),
        { version: fromVersion, value },
      );
    },

    runImport: async (input) => {
      // Parsed **here**. A file uploaded to be parsed would be every secret in
      // it, in plaintext, in a request body — which is the thing this mode
      // exists to prevent. The same `@xecret/core/importer` the server runs, so
      // the detection, the naming rules and the conflict strategy are unchanged;
      // only where they run has moved.
      const detected =
        input.format === 'auto'
          ? detectFormat(input.filename ?? '', input.content).format
          : input.format;

      const parsed = parseWith(detected, input.content);
      const plan = buildImportPlan({
        parsed,
        existingNames: [...input.existingNames],
        strategy: input.strategy,
      });

      const writable = plan.items.filter(
        (item) =>
          item.status === 'create' || item.status === 'overwrite' || item.status === 'rename',
      );

      const entries = [];
      for (const item of writable) {
        const target = input.existing.get(item.targetName);
        const id = target?.id ?? uuidv7();
        entries.push({
          id,
          name: item.targetName,
          value: await encryptValue({
            material,
            target: targetFor(id),
            version: target === undefined ? 1 : target.version + 1,
            plaintext: item.value,
          }),
        });
      }

      const result =
        entries.length === 0
          ? { dryRun: input.dryRun, counts: { create: 0, overwrite: 0, unchanged: 0 }, items: [] }
          : await api.post<{
              dryRun: boolean;
              counts: { create: number; overwrite: number; unchanged: number };
              items: { name: string; status: string }[];
            }>(apiPath.import(orgSlug, projectSlug, envSlug), {
              entries,
              dryRun: input.dryRun,
            });

      return mergeImportPlan({ detected, strategy: input.strategy, plan, result });
    },
  };
}

/**
 * Assembles the export document from values this browser has decrypted.
 *
 * Separate from {@link SecretIo} because it needs the pull's output rather than
 * the IO itself, and because it is the one operation with no server counterpart
 * at all: `GET …/export` answers 409 `client_side_only` for an `e2ee`
 * environment. Formatting takes plaintext, the client already holds it — it
 * decrypted it to show it — and `@xecret/core/format` is the same module the
 * Worker runs, so the file is byte-identical to the one `server` mode produces.
 */
export function renderExport(
  plaintexts: Readonly<Record<string, string>>,
  format: ExportFormat,
): string {
  const secrets = Object.entries(plaintexts)
    .map(([name, value]) => ({ name, value }))
    // Sorted by name, matching what the server-rendered document does, so
    // switching an environment to `e2ee` does not reshuffle everybody's file.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return formatSecrets(secrets, format);
}

/**
 * A ciphertext sealed against a key this IO does not hold.
 *
 * Its own class because the screen for it is different from every other
 * decryption failure: it is not corruption and not a permissions problem, it is
 * "this version predates a rotation, and the key that would open it was never
 * stored anywhere".
 */
export class RotatedAwayError extends Error {
  constructor() {
    super('This version was written under a key that has since been rotated away.');
    this.name = 'RotatedAwayError';
  }
}

function parseWith(format: ImportFormat, content: string): ParseResult {
  switch (format) {
    case 'json':
      return parseJson(content);
    case 'yaml':
      return parseYaml(content);
    case 'shell':
      return parseShell(content);
    default:
      return parseDotenv(content);
  }
}

/**
 * The locally-built plan and the server's counts, as one `ImportPlanResponse`.
 *
 * The dialog renders one shape in both modes. What differs is where each half
 * came from: the items, the warnings and the naming decisions are the local
 * planner's, because that is where the file was read; `unchanged` is the
 * server's, because only it holds the stored HMACs to compare against.
 */
function mergeImportPlan(params: {
  detected: ImportFormat;
  strategy: ConflictStrategy;
  plan: ImportPlan;
  result: {
    dryRun: boolean;
    counts: { create: number; overwrite: number; unchanged: number };
    items: { name: string; status: string }[];
  };
}): ImportPlanResponse {
  const serverStatus = new Map(params.result.items.map((item) => [item.name, item.status]));

  const items: ImportPlanItem[] = params.plan.items.map((item) => {
    const reported = serverStatus.get(item.targetName);
    const status =
      reported === 'unchanged' && (item.status === 'overwrite' || item.status === 'create')
        ? ('unchanged' as const)
        : item.status;

    return {
      sourceKey: item.sourceKey,
      name: item.targetName,
      status,
      note: item.note ?? null,
    };
  });

  const counts = {
    create: 0,
    overwrite: 0,
    skip: params.plan.counts.skip,
    rename: params.plan.counts.rename,
    invalid: params.plan.counts.invalid,
    unchanged: 0,
  };
  for (const item of items) {
    if (item.status === 'unchanged') counts.unchanged += 1;
    else if (item.status === 'create') counts.create += 1;
    else if (item.status === 'overwrite') counts.overwrite += 1;
  }

  return {
    dryRun: params.result.dryRun,
    format: params.detected,
    strategy: params.strategy,
    counts,
    items,
    warnings: params.plan.warnings,
  };
}

/**
 * The pull document's string members.
 *
 * Non-strings are dropped rather than coerced: `String(…)` on an unexpected
 * shape would put `[object Object]` in a field somebody is about to paste into a
 * terminal.
 */
function plaintextsOf(document: Record<string, unknown>): Record<string, string> {
  const plaintexts: Record<string, string> = {};
  for (const [name, value] of Object.entries(document)) {
    if (typeof value === 'string') plaintexts[name] = value;
  }
  return plaintexts;
}
