import {
  SECRET_NAME_MAX_LENGTH,
  checkSecretName,
  isReservedSecretName,
  normalizeSecretName,
} from '../validation/secret-name';
import type {
  ConflictStrategy,
  ImportItem,
  ImportItemStatus,
  ImportPlan,
  ParseResult,
} from './types';

/**
 * Turning a parsed file into the exact set of writes an import will perform.
 *
 * ## This module handles plaintext secret values
 *
 * Every `ImportItem` carries a decrypted value. An `ImportPlan` must never be
 * logged, serialised into an audit record, attached to an error report, or sent
 * anywhere other than the client that uploaded the file. `ImportItem`
 * deliberately has no `toJSON` or `toString`: a redacting one would make
 * `JSON.stringify(plan)` *look* safe while the value stayed one property access
 * away, and would train reviewers to stop noticing that this object is
 * dangerous. It is a plain object, and it is dangerous.
 *
 * ## The dry run is the import
 *
 * `buildImportPlan` is pure — no I/O, no clock, no randomness, no mutation of
 * its arguments. The preview the user approves ("42 will be added, 3
 * overwritten") and the write path that runs afterwards call this same
 * function with the same inputs, so the preview cannot disagree with what
 * happens. Any conditional the writer applies that the planner does not know
 * about reintroduces exactly the discrepancy this design exists to prevent:
 * the writer's only job is to execute `items`.
 */

/**
 * A rename appends `_2`, `_3`, … Reaching this many collisions on one name
 * means the source file is pathological, not that the scheme needs more room;
 * reporting it beats spinning.
 */
const MAX_RENAME_ATTEMPTS = 1000;

export function buildImportPlan(params: {
  parsed: ParseResult;
  existingNames: readonly string[];
  strategy: ConflictStrategy;
}): ImportPlan {
  const existing = new Set(params.existingNames);
  /** Names this plan has already committed to writing. */
  const claimed = new Set<string>();
  const items: ImportItem[] = [];
  const counts: Record<ImportItemStatus, number> = {
    create: 0,
    overwrite: 0,
    skip: 0,
    rename: 0,
    invalid: 0,
  };

  for (const entry of params.parsed.entries) {
    const item = planEntry(entry.key, entry.value, existing, claimed, params.strategy);
    if (item.status !== 'invalid' && item.status !== 'skip') claimed.add(item.targetName);
    counts[item.status] += 1;
    items.push(item);
  }

  return { items, warnings: [...params.parsed.warnings], counts };
}

function planEntry(
  sourceKey: string,
  value: string,
  existing: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
  strategy: ConflictStrategy,
): ImportItem {
  const targetName = normalizeSecretName(sourceKey);

  if (targetName === '') {
    return invalid(
      sourceKey,
      value,
      `"${sourceKey}" contains no letters, digits or underscores, so it cannot become a secret name.`,
    );
  }

  if (isReservedSecretName(targetName)) {
    // `PATH`, `LD_PRELOAD` and friends are read by the loader of every process
    // this secret would be injected into. Importing one would let anyone with
    // write access to an environment turn `xecret run` into arbitrary code
    // execution on every machine that uses it.
    return invalid(
      sourceKey,
      value,
      `"${targetName}" is reserved by the operating system. Importing it would change how programs launched with these secrets find their executables and libraries.`,
    );
  }

  const check = checkSecretName(targetName);
  if (!check.valid) {
    return invalid(
      sourceKey,
      value,
      check.message ?? `"${targetName}" is not a valid secret name.`,
    );
  }

  // A key that only changed case or punctuation still changed. Saying so keeps
  // anything from arriving under a name the user did not choose.
  const normalised =
    targetName === sourceKey ? '' : `"${sourceKey}" was normalised to "${targetName}".`;

  if (claimed.has(targetName)) {
    return planCollision(sourceKey, value, targetName, existing, claimed, strategy);
  }

  if (!existing.has(targetName)) {
    return item(sourceKey, targetName, value, 'create', normalised);
  }

  switch (strategy) {
    case 'skip':
      return item(
        sourceKey,
        targetName,
        value,
        'skip',
        `${normalised} "${targetName}" already exists and was left unchanged.`,
      );
    case 'overwrite':
      return item(
        sourceKey,
        targetName,
        value,
        'overwrite',
        `${normalised} "${targetName}" already exists and will be replaced with a new version.`,
      );
    case 'rename':
      return planRename(sourceKey, value, targetName, existing, claimed);
  }
}

/**
 * Two different source keys that normalise to one name — `my-api-key` and
 * `MY_API_KEY` in the same file, say.
 *
 * Collapsing them silently would import one value under a name the user
 * believes holds the other. Under `rename` the second gets a suffix; otherwise
 * it is skipped and the note names the winner, because writing the same name
 * twice in one run would make the preview's counts a lie.
 *
 * First-seen wins. The alternative (last wins, matching the `.env` duplicate
 * rule) is no more correct — these are *different* keys, so neither is the
 * author's stated intent — and would mean rewriting an item already emitted.
 * What matters is that the discarded one is reported, not which one it is.
 */
function planCollision(
  sourceKey: string,
  value: string,
  targetName: string,
  existing: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
  strategy: ConflictStrategy,
): ImportItem {
  if (strategy === 'rename') return planRename(sourceKey, value, targetName, existing, claimed);

  return item(
    sourceKey,
    targetName,
    value,
    'skip',
    `Another key in this file already imports as "${targetName}", so "${sourceKey}" was skipped.`,
  );
}

function planRename(
  sourceKey: string,
  value: string,
  targetName: string,
  existing: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
): ImportItem {
  for (let suffix = 2; suffix < MAX_RENAME_ATTEMPTS; suffix += 1) {
    const candidate = `${targetName}_${suffix}`;
    if (existing.has(candidate) || claimed.has(candidate)) continue;

    // The suffix can push a long name past the column limit, which would fail
    // at the database instead of here.
    if (candidate.length > SECRET_NAME_MAX_LENGTH) {
      return invalid(
        sourceKey,
        value,
        `"${targetName}" already exists and renaming it would exceed the ${SECRET_NAME_MAX_LENGTH} character limit.`,
      );
    }

    return item(
      sourceKey,
      candidate,
      value,
      'rename',
      `"${targetName}" is already taken, so this will be imported as "${candidate}".`,
    );
  }

  return invalid(
    sourceKey,
    value,
    `"${targetName}" and its first ${MAX_RENAME_ATTEMPTS} numbered variants are all taken.`,
  );
}

function item(
  sourceKey: string,
  targetName: string,
  value: string,
  status: ImportItemStatus,
  note: string,
): ImportItem {
  const trimmed = note.trim();
  return { sourceKey, targetName, value, status, note: trimmed === '' ? undefined : trimmed };
}

function invalid(sourceKey: string, value: string, note: string): ImportItem {
  // The value is carried even for an invalid item: the UI lets the user correct
  // the name in place, and re-uploading the file to recover a value they
  // already gave us is the kind of friction that makes people paste secrets
  // into a chat window instead.
  return { sourceKey, targetName: '', value, status: 'invalid', note };
}
