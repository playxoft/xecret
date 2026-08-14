/**
 * The secret payloads, as the API returns them.
 *
 * ── What is deliberately absent ──
 * There is no `value` field on `SecretSummary`, and there is none on
 * `SecretVersion` either. That is the contract, not an omission this file makes:
 * `GET …/secrets` never reads a ciphertext column, and `GET …/secrets/{name}/versions`
 * is metadata-only because a rotated secret is not a dead secret — version 3 of
 * `AWS_SECRET_ACCESS_KEY` keeps working until somebody disables it at AWS, so a
 * history endpoint that returned values would be serving live credentials under
 * an interface people reason about as an archive.
 *
 * A plaintext value exists in exactly one response in this product,
 * `GET …/secrets/{name}` — modelled below as `RevealedSecret`, which is the only
 * type here with a `value`, and whose one and only consumer is the reveal/copy
 * callback in `SecretValue`.
 */

import type { ImportItemStatus, ParseWarning } from '@xecret/core/importer';

/**
 * A secret as the masked listing describes it.
 *
 * `createdBy` is a user id, and it is the secret's **author** rather than
 * whoever last changed it — "who last changed it" is a property of the newest
 * `secret_versions` row, which the listing query deliberately does not join in
 * order to keep the page's cost constant in the number of secrets. The version
 * history answers it exactly.
 */
export interface SecretSummary {
  name: string;
  note: string | null;
  /**
   * The declared shape of the value — one of `SECRET_VALUE_TYPES`.
   *
   * A plain `string` rather than the union, because a row written by a newer
   * deployment may name a type this build has never heard of, and a listing that
   * refused to represent it could not show the user their own secret. Narrow it
   * with `toSecretValueType`, which falls back to `string`.
   */
  valueType: string;
  /** The current version. Starts at 1 and increases on every real change. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Exactly one of these two is set — a person, or the CI token that wrote it. */
  createdBy: string | null;
  createdByServiceTokenId: string | null;
}

export interface SecretListResponse {
  data: readonly SecretSummary[];
  /** Opaque. Pass it back as `cursor`; never do arithmetic on it. */
  nextCursor: string | null;
}

/** The one response in the product that carries a plaintext credential. */
export interface RevealedSecret {
  secret: {
    name: string;
    value: string;
    valueType: string;
    version: number;
    updatedAt: string;
    updatedBy: string | null;
    updatedByServiceTokenId: string | null;
  };
}

/** The plaintext of one historical version. See `…/versions/{version}`. */
export interface RevealedSecretVersion {
  secret: {
    name: string;
    value: string;
    version: number;
    current: boolean;
    createdAt: string;
    createdBy: string | null;
    createdByServiceTokenId: string | null;
  };
}

export interface SecretWriteResponse {
  secret: {
    name: string;
    version: number;
    /** `unchanged` when the submitted value matched the stored one. */
    status?: 'created' | 'updated' | 'unchanged';
  };
}

export interface SecretVersion {
  version: number;
  algorithm: string;
  /** Which environment data key wrote it. Opaque, and confers no access. */
  envKeyId: string;
  createdAt: string;
  createdBy: string | null;
  createdByServiceTokenId: string | null;
  current: boolean;
}

export interface SecretVersionListResponse {
  data: readonly SecretVersion[];
  nextCursor: string | null;
}

export interface SecretRestoreResponse {
  secret: {
    name: string;
    version: number;
    status: 'created' | 'updated' | 'unchanged';
    restoredFrom: number;
  };
}

export type ImportStrategy = 'skip' | 'overwrite' | 'rename';
export type ImportSourceFormat = 'dotenv' | 'json' | 'yaml' | 'shell';

/**
 * What one line of an import will do.
 *
 * `status` extends the planner's set with `unchanged`, which only a value
 * comparison can produce: the server computes each value's HMAC and finds it
 * equal to the stored one, so the write would append a version recording no
 * change. Distinguishing it matters — a column of no-op version bumps makes
 * "when did this credential last actually change?" unanswerable.
 *
 * **There is no value here, and there must never be one.** The dry run answers
 * "what will happen", and the browser already holds the file it just uploaded;
 * echoing the values back would put every secret in the network log, in any
 * proxy that terminates TLS on a corporate network, and in whatever error
 * reporter the dashboard ships with, in exchange for nothing at all.
 */
export interface ImportPlanItem {
  sourceKey: string;
  name: string;
  status: ImportItemStatus | 'unchanged';
  note: string | null;
}

export type ImportPlanCounts = Readonly<Record<ImportItemStatus | 'unchanged', number>>;

export interface ImportPlanResponse {
  dryRun: boolean;
  /** What the server detected, or what the request asked for. */
  format: ImportSourceFormat;
  strategy: ImportStrategy;
  counts: ImportPlanCounts;
  items: readonly ImportPlanItem[];
  warnings: readonly ParseWarning[];
}

export type ExportFormat = 'env' | 'json' | 'yaml' | 'shell' | 'docker';
