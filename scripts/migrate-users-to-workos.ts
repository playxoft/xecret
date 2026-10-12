#!/usr/bin/env -S npx tsx
/**
 * Moves xecret's users from Firebase Auth to WorkOS, keeping their passwords.
 *
 * Runbook: docs/operations/workos-user-migration.md. Plan: `.local/workos-auth.md` §6.
 *
 *   # Prove the WorkOS environment verifies our hashes (creates, signs in as, deletes one synthetic user)
 *   npm run phase:migrate-users:staging -- --self-test
 *
 *   # Import: dry run (the default), then for real
 *   npm run phase:migrate-users:production -- --export <private dir>/users.json
 *   npm run phase:migrate-users:production -- --export <private dir>/users.json --apply --confirm-client <client_…>
 *
 *   # Backfill users.workos_user_id from the mapping the import wrote
 *   npm run phase:migrate-users:production -- --backfill --export <private dir>/users.json
 *   npm run phase:migrate-users:production -- --backfill --export <private dir>/users.json --apply --confirm-client <client_…>
 *
 * ## Three passes
 *
 *  - **import** (default): one WorkOS user per importable Firebase user, with
 *    its Firebase scrypt hash, keyed by `external_id = firebase uid`. Writes the
 *    `firebase_uid → workos_user_id` mapping next to the export.
 *  - **--backfill**: `UPDATE users SET workos_user_id = $w WHERE firebase_uid =
 *    $f AND workos_user_id IS NULL`, row by row, after re-checking every mapped
 *    id against WorkOS.
 *  - **--self-test**: proves the target WorkOS environment accepts and
 *    verifies a hash built exactly the way the import builds one.
 *
 * The rules for who is imported, and why, are in
 * `packages/db/src/firebase-migration/import-plan.ts`; the backfill's in
 * `backfill.ts` beside it. Both are unit-tested there.
 *
 * ## Safety rules this script enforces
 *
 *  - **Dry run unless `--apply`.** A dry run reads WorkOS (and, for the
 *    backfill, the database) and writes nothing anywhere.
 *  - **The WorkOS environment is verified, not assumed.** A WorkOS API key does
 *    not say which environment it belongs to (the current format is `sk_` and
 *    base64 of `key_<id>,<secret>`), but the application's client id does, and
 *    WorkOS will say whether a key and a client id belong together. So before
 *    anything else the script checks `WORKOS_API_KEY` against
 *    `WORKOS_CLIENT_ID`, and every `--apply` must name the client it is about
 *    to write to with `--confirm-client` — typed from the runbook, which lists
 *    both environments' ids. A legacy staging key (`sk_test_…`) is refused for
 *    `--env production` outright. The npm scripts above pair each Phase
 *    environment with its `--env`.
 *  - **A mapping is bound to its environment and client id**, and the backfill
 *    re-checks every id against the WorkOS environment in use. xecret's Development and
 *    Production share one database, so a Staging id in `users.workos_user_id`
 *    would block the real Production link. For the same reason a Staging
 *    backfill `--apply` is refused unless `--staging-database` says the
 *    database is not the shared one.
 *  - **The export and the mapping must live outside this repository.** The
 *    export holds every password hash.
 *  - **Nothing secret is printed.** Users are named by Firebase uid and WorkOS
 *    id; no hash, salt, parameter, key or address reaches the output.
 *  - **Never overwrites.** Existing WorkOS users are only read; a backfill only
 *    fills a NULL and reports `23505`/`23514` instead of forcing them.
 *
 * Exit codes: 0 done and clean; 1 refused or failed; 2 done, with problems to
 * review (listed after the summary).
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createDatabaseHandle } from '../packages/db/src/client.ts';
import {
  checkMappedUser,
  loadBackfillRows,
  planBackfill,
  writeBackfillLink,
} from '../packages/db/src/firebase-migration/backfill.ts';
import type {
  BackfillWriteResult,
  MappingRejection,
} from '../packages/db/src/firebase-migration/backfill.ts';
import { parseFirebaseExport } from '../packages/db/src/firebase-migration/firebase-export.ts';
import type { FirebaseExportUser } from '../packages/db/src/firebase-migration/firebase-export.ts';
import {
  firebaseScryptHash,
  firebaseScryptPhc,
  matchesPublishedExample,
  parseFirebaseScryptParams,
} from '../packages/db/src/firebase-migration/firebase-scrypt.ts';
import type { FirebaseScryptParams } from '../packages/db/src/firebase-migration/firebase-scrypt.ts';
import {
  buildCreateUserInput,
  classifyFirebaseUser,
  decideImport,
  WORKOS_EXTERNAL_ID_MAX_LENGTH,
} from '../packages/db/src/firebase-migration/import-plan.ts';
import type { ImportCandidate } from '../packages/db/src/firebase-migration/import-plan.ts';
import {
  emptyUserMapping,
  parseUserMapping,
  WORKOS_CLIENT_ID_PATTERN,
  serializeUserMapping,
  withMappingEntry,
} from '../packages/db/src/firebase-migration/mapping.ts';
import type {
  MigrationEnvironment,
  UserMapping,
} from '../packages/db/src/firebase-migration/mapping.ts';
import { createWorkosUsersApi } from '../packages/db/src/firebase-migration/workos-api.ts';
import type { WorkosUsersApi } from '../packages/db/src/firebase-migration/workos-api.ts';

// ── arguments ───────────────────────────────────────────────────────────────

type Mode = 'import' | 'backfill' | 'self-test';

interface Args {
  mode: Mode;
  env: MigrationEnvironment;
  exportPath: string | null;
  mappingPath: string | null;
  apply: boolean;
  confirmClient: string | null;
  stagingDatabase: boolean;
}

const USAGE = `Usage: migrate-users-to-workos.ts --env staging|production [mode] [options]

Modes (default: import)
  --self-test             Create, authenticate as, and delete one synthetic user.
  --backfill              Write users.workos_user_id from the mapping file.

Options
  --export <file>         firebase auth:export --format=json output (import, backfill).
  --mapping <file>        Default: workos-mapping.<env>.json next to the export.
  --apply                 Write. Without it every mode except --self-test is a dry run.
  --confirm-client <id>   Required with --apply: the WorkOS client id (client_…) of the
                          environment you mean to write to. Must match WORKOS_CLIENT_ID.
  --dry-run               The default; accepted for clarity.
  --staging-database      Allow a staging --backfill --apply: only when the database is NOT
                          shared with production. (xecret's is shared. Do not pass this there.)`;

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function parseArgs(argv: readonly string[]): Args {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const args: Args = {
    mode: 'import',
    env: 'staging',
    exportPath: null,
    mappingPath: null,
    apply: false,
    confirmClient: null,
    stagingDatabase: false,
  };
  let env: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) refuse(`${flag} needs a value.\n\n${USAGE}`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--env':
        env = value();
        break;
      case '--export':
        args.exportPath = resolve(value());
        break;
      case '--mapping':
        args.mappingPath = resolve(value());
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--confirm-client':
        args.confirmClient = value();
        break;
      case '--backfill':
      case '--self-test': {
        const mode: Mode = flag === '--backfill' ? 'backfill' : 'self-test';
        if (args.mode !== 'import' && args.mode !== mode)
          refuse('Choose one of --backfill and --self-test.');
        args.mode = mode;
        break;
      }
      case '--staging-database':
        args.stagingDatabase = true;
        break;
      default:
        refuse(`Unknown argument: ${flag}\n\n${USAGE}`);
    }
  }
  if (env !== 'staging' && env !== 'production') {
    refuse(`--env staging|production is required.\n\n${USAGE}`);
  }
  args.env = env;
  if (args.apply && dryRun) refuse('--apply and --dry-run contradict each other.');
  if (args.mode === 'self-test' && (args.apply || args.exportPath)) {
    refuse(
      '--self-test takes no --apply or --export: it always creates and deletes one synthetic user.',
    );
  }
  if (args.confirmClient !== null && !args.apply) {
    refuse('--confirm-client only goes with --apply.');
  }
  if (args.stagingDatabase && !(args.mode === 'backfill' && env === 'staging')) {
    refuse('--staging-database only applies to a staging --backfill.');
  }
  return args;
}

// ── environment and files ───────────────────────────────────────────────────

/** The legacy WorkOS staging key format. The current format carries no environment at all. */
const LEGACY_STAGING_KEY_PREFIX = 'sk_test_';

interface WorkosTarget {
  readonly api: WorkosUsersApi;
  readonly clientId: string;
}

/**
 * The WorkOS environment this run talks to, verified before any other request.
 * See "The WorkOS environment is verified, not assumed" in the header.
 */
async function connectWorkos(args: Args): Promise<WorkosTarget> {
  const apiKey = process.env['WORKOS_API_KEY'];
  const clientId = process.env['WORKOS_CLIENT_ID'];
  if (!apiKey || !clientId) {
    refuse(
      'WORKOS_API_KEY and WORKOS_CLIENT_ID must both be set. Run through the npm script for the environment, e.g. ' +
        '`npm run phase:migrate-users:staging -- …`.',
    );
  }
  if (!WORKOS_CLIENT_ID_PATTERN.test(clientId)) {
    refuse('WORKOS_CLIENT_ID is not a WorkOS client id (client_…).');
  }
  if (args.env === 'production' && apiKey.startsWith(LEGACY_STAGING_KEY_PREFIX)) {
    refuse(
      '--env production, but WORKOS_API_KEY is a staging key (sk_test_…). Check the Phase environment.',
    );
  }
  const api = createWorkosUsersApi({ apiKey });
  if ((await api.checkClientPairing(clientId)) !== 'same-environment') {
    refuse(
      `WorkOS says WORKOS_API_KEY and WORKOS_CLIENT_ID (${clientId}) belong to different environments. ` +
        'Fix the Phase environment before running anything.',
    );
  }
  if (args.apply && args.confirmClient !== clientId) {
    refuse(
      args.confirmClient === null
        ? `--apply writes to the WorkOS environment of ${clientId}. Add --confirm-client with the client id ` +
            `of the environment you mean to write to, from the runbook (docs/operations/workos-user-migration.md).`
        : `--confirm-client ${args.confirmClient} is not this run's environment (${clientId}). Nothing was written.`,
    );
  }
  return { api, clientId };
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

/** The export holds every password hash; neither it nor the mapping belongs in a working tree. */
function assertOutsideRepository(path: string, what: string): void {
  const rel = relative(REPOSITORY_ROOT, path);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    refuse(
      `${what} (${path}) is inside the repository. Keep it in a private directory outside it.`,
    );
  }
}

function requireExportPath(args: Args): string {
  if (!args.exportPath) refuse(`--export <file> is required.\n\n${USAGE}`);
  assertOutsideRepository(args.exportPath, 'The Firebase export');
  if (!existsSync(args.exportPath)) refuse(`No export at ${args.exportPath}.`);
  return args.exportPath;
}

function mappingPathFor(args: Args, exportPath: string): string {
  const path = args.mappingPath ?? join(dirname(exportPath), `workos-mapping.${args.env}.json`);
  assertOutsideRepository(path, 'The mapping file');
  return path;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    // The message can quote the file; the file can hold hashes. Name it instead.
    refuse(
      `${path} is not readable JSON (${error instanceof SyntaxError ? 'syntax error' : 'read error'}).`,
    );
  }
}

async function loadExport(path: string): Promise<FirebaseExportUser[]> {
  return parseFirebaseExport(await readJson(path));
}

async function loadMapping(
  path: string,
  env: MigrationEnvironment,
  clientId: string,
  required: boolean,
): Promise<UserMapping> {
  if (!existsSync(path)) {
    if (required) refuse(`No mapping at ${path}. Run the import with --apply first.`);
    return emptyUserMapping(env, clientId);
  }
  const mapping = parseUserMapping(await readJson(path));
  if (mapping.environment !== env || mapping.clientId !== clientId) {
    refuse(
      `${path} maps users in WorkOS ${mapping.environment} (${mapping.clientId}), not ${env} (${clientId}). Never mix the two.`,
    );
  }
  return mapping;
}

/** Written whole, then renamed over the old one: a crash leaves the previous mapping, never half of one. */
async function saveMapping(path: string, mapping: UserMapping): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(serializeUserMapping(mapping, new Date().toISOString()), null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  await rename(temporary, path);
}

// ── output ──────────────────────────────────────────────────────────────────

function row(label: string, value: number | string, indent = 2): void {
  const left = `${' '.repeat(indent)}${label} `;
  console.log(`${left.padEnd(60, '.')} ${value}`);
}

function header(args: Args, clientId: string, extra: string): void {
  const mode =
    args.mode === 'self-test'
      ? 'self-test'
      : args.apply
        ? 'APPLY (writes)'
        : 'dry run (writes nothing)';
  console.log(
    `\nxecret · Firebase → WorkOS · ${args.mode} · WorkOS ${args.env} (${clientId}, key verified) · ${mode}`,
  );
  if (extra) console.log(extra);
  console.log('');
}

class Tally {
  private readonly counts = new Map<string, number>();
  add(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── import ──────────────────────────────────────────────────────────────────

async function lookUp(api: WorkosUsersApi, candidate: ImportCandidate) {
  const byExternalId =
    candidate.uid.length <= WORKOS_EXTERNAL_ID_MAX_LENGTH
      ? await api.getUserByExternalId(candidate.uid)
      : null;
  const byEmail = byExternalId === null ? await api.findUserByEmail(candidate.email) : null;
  return decideImport(candidate, byExternalId, byEmail);
}

async function runImport(args: Args): Promise<number> {
  const exportPath = requireExportPath(args);
  const mappingPath = mappingPathFor(args, exportPath);
  const { api, clientId } = await connectWorkos(args);
  const users = await loadExport(exportPath);
  let mapping = await loadMapping(mappingPath, args.env, clientId, false);

  let params: FirebaseScryptParams | null = null;
  let paramsProblem: string | null = null;
  try {
    params = parseFirebaseScryptParams(process.env);
  } catch (error) {
    paramsProblem = errorMessage(error);
  }

  const classified = users.map((user) => ({ user, classification: classifyFirebaseUser(user) }));
  const passwordUsers = classified
    .map(({ classification }) => classification)
    .filter((c) => c.action === 'import' && c.candidate.kind === 'password').length;
  if (args.apply && passwordUsers > 0 && params === null) {
    refuse(
      `${paramsProblem} ${passwordUsers} user(s) have passwords, and they cannot be imported without the project's hash parameters.`,
    );
  }

  header(
    args,
    clientId,
    `export: ${users.length} Firebase users · mapping: ${mappingPath}${existsSync(mappingPath) ? '' : ' (new)'}`,
  );

  const tally = new Tally();
  const problems: string[] = [];
  const verb = args.apply ? '' : 'would be ';

  for (const { user, classification } of classified) {
    if (classification.action === 'skip') {
      tally.add(`skip:${classification.reason}`);
      if (classification.reason === 'disabled' || classification.reason === 'malformed-password') {
        problems.push(`${classification.uid}: skipped (${classification.reason}) — decide by hand`);
      }
      continue;
    }
    const { candidate } = classification;
    tally.add(`kind:${candidate.kind}`);
    if (user.mfaEnrolled) tally.add('mfa');

    let phc: string | null = null;
    if (candidate.password !== null && params !== null) {
      try {
        phc = firebaseScryptPhc(candidate.password.hash, candidate.password.salt, params);
      } catch (error) {
        tally.add('error');
        problems.push(`${candidate.uid}: ${errorMessage(error)}`);
        continue;
      }
    }

    try {
      const decision = await lookUp(api, candidate);
      const recordedAt = new Date().toISOString();
      switch (decision.action) {
        case 'create': {
          tally.add('create');
          if (!args.apply) break;
          const created = await api.createUser(buildCreateUserInput(candidate, phc));
          mapping = withMappingEntry(mapping, candidate.uid, {
            workosUserId: created.id,
            outcome: 'created',
            passwordImported: phc !== null,
            recordedAt,
          });
          await saveMapping(mappingPath, mapping);
          break;
        }
        case 'already-imported':
        case 'reuse-existing': {
          tally.add(decision.action);
          if (decision.action === 'reuse-existing' && candidate.kind === 'password') {
            tally.add('reuse-password-not-carried');
          }
          if (!args.apply) break;
          mapping = withMappingEntry(mapping, candidate.uid, {
            workosUserId: decision.workosUserId,
            outcome: decision.action,
            passwordImported: decision.action === 'reuse-existing' ? false : null,
            recordedAt,
          });
          await saveMapping(mappingPath, mapping);
          break;
        }
        case 'conflict':
          tally.add('conflict');
          problems.push(
            `${candidate.uid}: conflict (${decision.reason}) with WorkOS ${decision.workosUserId} — not touched`,
          );
          break;
      }
    } catch (error) {
      tally.add('error');
      problems.push(`${candidate.uid}: ${errorMessage(error)}`);
    }
  }

  console.log('Firebase export');
  row('importable · verified, with password', tally.get('kind:password'));
  row('importable · verified, Google-only (no password)', tally.get('kind:google-only'));
  row('importable · verified, other provider (no password)', tally.get('kind:other-provider-only'));
  row('skipped · email unverified', tally.get('skip:email-unverified'));
  row('skipped · disabled', tally.get('skip:disabled'));
  row('skipped · no email', tally.get('skip:no-email'));
  row('skipped · malformed password hash', tally.get('skip:malformed-password'));
  if (tally.get('mfa') > 0) row('note · had Firebase MFA (factor not migrated)', tally.get('mfa'));
  console.log(`\nWorkOS ${args.env}`);
  row(`${args.apply ? 'created' : 'would create'}`, tally.get('create'));
  row('already imported (found by external_id)', tally.get('already-imported'));
  row('already in WorkOS, verified (reused, not modified)', tally.get('reuse-existing'));
  if (tally.get('reuse-password-not-carried') > 0) {
    row(
      '  of which had a Firebase password (not carried)',
      tally.get('reuse-password-not-carried'),
    );
  }
  row('conflicts (reported, not touched)', tally.get('conflict'));
  row('errors', tally.get('error'));
  console.log(
    `\nPassword hashes: ${params ? 'parameters present and valid' : `NOT AVAILABLE — ${paramsProblem}`}`,
  );
  if (!params && passwordUsers > 0) {
    console.log(`  --apply will refuse: ${passwordUsers} password user(s) need them.`);
  }
  console.log(
    args.apply
      ? `Mapping: ${mapping.entries.size} entries in ${mappingPath}`
      : `Mapping: ${verb}written to ${mappingPath} by --apply`,
  );
  return printProblems(problems);
}

function printProblems(problems: readonly string[]): number {
  if (problems.length === 0) {
    console.log('\nNo problems.');
    return 0;
  }
  console.log(`\nProblems to review (${problems.length}):`);
  for (const problem of problems) console.log(`  - ${problem}`);
  return 2;
}

// ── backfill ────────────────────────────────────────────────────────────────

async function runBackfill(args: Args): Promise<number> {
  const exportPath = requireExportPath(args);
  const mappingPath = mappingPathFor(args, exportPath);
  if (args.apply && args.env === 'staging' && !args.stagingDatabase) {
    refuse(
      "A staging backfill writes Staging WorkOS ids into users.workos_user_id. xecret's Development and Production " +
        'share one database, where that would block every Production link. Refused. (A self-hoster with a separate ' +
        'staging database can pass --staging-database.)',
    );
  }
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) refuse('DATABASE_URL is not set.');
  const { api, clientId } = await connectWorkos(args);

  const users = await loadExport(exportPath);
  const mapping = await loadMapping(mappingPath, args.env, clientId, true);
  const emailByUid = new Map(users.map((u) => [u.uid, u.email]));
  const reasonByUid = new Map(
    users.map((u) => {
      const c = classifyFirebaseUser(u);
      return [u.uid, c.action === 'skip' ? c.reason : 'not yet imported'];
    }),
  );

  header(
    args,
    clientId,
    `export: ${users.length} Firebase users · mapping: ${mapping.entries.size} entries (${mappingPath})`,
  );

  // Every mapped id is re-checked against the WorkOS environment whose key is
  // in use before it may become a link. See checkMappedUser.
  const accepted = new Map<string, string>();
  const rejected = new Map<string, MappingRejection>();
  for (const [uid, entry] of mapping.entries) {
    const rejection = checkMappedUser(
      uid,
      entry,
      emailByUid.get(uid) ?? null,
      await api.getUser(entry.workosUserId),
    );
    if (rejection === null) accepted.set(uid, entry.workosUserId);
    else rejected.set(uid, rejection);
  }

  const { db, end } = createDatabaseHandle({ connectionString: databaseUrl });
  try {
    const rows = await loadBackfillRows(db);
    const plan = planBackfill({
      rows,
      exportUids: new Set(users.map((u) => u.uid)),
      mapping: accepted,
      rejected,
    });
    const tally = new Tally();
    const problems: string[] = [];
    for (const item of plan.items) {
      tally.add(item.action);
      switch (item.action) {
        case 'update':
          if (item.deleted) tally.add('update-deleted');
          break;
        case 'linked-elsewhere':
          problems.push(
            `user ${item.userId} (firebase ${item.firebaseUid}): already linked to ${item.currentWorkosUserId}, mapping says ${item.mappedWorkosUserId} — not overwritten`,
          );
          break;
        case 'held-by-other-row':
          problems.push(
            `user ${item.userId} (firebase ${item.firebaseUid}): ${item.workosUserId} is already on user ${item.holderUserId} — would be 23505`,
          );
          break;
        case 'mapping-rejected':
          problems.push(
            `user ${item.userId} (firebase ${item.firebaseUid}): mapping entry rejected (${item.reason})`,
          );
          break;
        case 'not-imported': {
          const reason = reasonByUid.get(item.firebaseUid) ?? 'unknown';
          tally.add(`not-imported:${reason}`);
          problems.push(
            `user ${item.userId} (firebase ${item.firebaseUid})${item.deleted ? ' [deleted]' : ''}: not imported (${reason}) — stays unlinked`,
          );
          break;
        }
        case 'no-firebase-user':
          problems.push(
            `user ${item.userId} (firebase ${item.firebaseUid})${item.deleted ? ' [deleted]' : ''}: no such Firebase user in the export`,
          );
          break;
        case 'already-linked':
          break;
      }
    }

    console.log(`Database (${rows.length} users)`);
    row(`${args.apply ? 'to link now' : 'would link'}`, tally.get('update'));
    if (tally.get('update-deleted') > 0)
      row('  of which soft-deleted', tally.get('update-deleted'));
    row('already linked to the mapped id', tally.get('already-linked'));
    row('linked to a different id (reported)', tally.get('linked-elsewhere'));
    row('mapped id held by another row (reported, 23505)', tally.get('held-by-other-row'));
    row('mapping entry rejected by WorkOS check (reported)', tally.get('mapping-rejected'));
    row('Firebase user not imported (reported)', tally.get('not-imported'));
    row('no Firebase user in the export (reported)', tally.get('no-firebase-user'));
    row('rows without a Firebase uid (nothing to do)', plan.rowsWithoutFirebaseUid);
    row('Firebase users with no xecret row', plan.firebaseUidsWithoutRow.length);
    console.log(
      `\nMapping check against WorkOS ${args.env}: ${accepted.size} ok, ${rejected.size} rejected`,
    );
    const rowUids = new Set(rows.map((r) => r.firebaseUid));
    for (const [uid, reason] of rejected) {
      if (!rowUids.has(uid))
        problems.push(`firebase ${uid}: mapping entry rejected (${reason}); no xecret row`);
    }

    if (args.apply) {
      const results = new Tally();
      for (const item of plan.items) {
        if (item.action !== 'update') continue;
        const result: BackfillWriteResult = await writeBackfillLink(
          db,
          item.firebaseUid,
          item.workosUserId,
        );
        results.add(result.result);
        if (result.result === 'updated' || result.result === 'already-linked') continue;
        const detail =
          result.result === 'unique-violation'
            ? `23505: ${item.workosUserId} is already on user ${result.holderUserId ?? '?'}`
            : result.result === 'format-violation'
              ? `23514: ${item.workosUserId} is not a WorkOS user id`
              : result.result === 'linked-elsewhere'
                ? `linked to ${result.currentWorkosUserId ?? 'nothing'} meanwhile — not overwritten`
                : 'row disappeared';
        problems.push(`user ${item.userId} (firebase ${item.firebaseUid}): ${detail}`);
      }
      console.log('\nWrites');
      row('linked', results.get('updated'));
      row('already linked (a sign-in got there first)', results.get('already-linked'));
      row('refused: 23505 unique violation', results.get('unique-violation'));
      row('refused: 23514 format check', results.get('format-violation'));
      row(
        'changed underneath (reported)',
        results.get('linked-elsewhere') + results.get('row-missing'),
      );
    }
    return printProblems(problems);
  } finally {
    await end();
  }
}

// ── self-test ───────────────────────────────────────────────────────────────

const SELF_TEST_DOMAIN = 'example.net';

/** WorkOS refusals that are decided before, or instead of, the password (reference/authkit/authentication-errors). */
const NOT_ABOUT_THE_PASSWORD = new Set([
  'sso_required',
  'organization_selection_required',
  'email_verification_required',
  'mfa_challenge',
  'mfa_enrollment',
  'radar_email_challenge',
  'radar_sms_challenge',
]);

async function runSelfTest(args: Args): Promise<number> {
  const params = parseFirebaseScryptParams(process.env);
  const { api, clientId } = await connectWorkos(args);

  header(args, clientId, '');
  let failed = 0;
  const step = (name: string, ok: boolean, detail = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const reproduces = matchesPublishedExample();
  step("local firebase-scrypt reproduces Firebase's published example", reproduces);
  if (!reproduces) return 1;

  const tag = randomBytes(6).toString('hex');
  // example.net, not example.com: a WorkOS staging environment's built-in SSO
  // test organisation claims example.com, so every password attempt there is
  // answered `sso_required` before the password is even looked at.
  const email = `migration-selftest+${tag}@${SELF_TEST_DOMAIN}`;
  const password = randomBytes(18).toString('base64url');
  const salt = new Uint8Array(randomBytes(12));
  const phc = firebaseScryptPhc(firebaseScryptHash(password, salt, params), salt, params);
  step(
    'hash built with the project parameters',
    true,
    'throwaway password, random salt; neither printed',
  );

  let userId: string | null = null;
  try {
    const user = await api.createUser({
      email,
      emailVerified: true,
      firstName: 'Migration',
      lastName: 'Self-test',
      externalId: `migration-selftest-${tag}`,
      firebaseScryptHash: phc,
    });
    userId = user.id;
    step(
      'WorkOS accepted the firebase-scrypt PHC hash (Create User)',
      true,
      `${user.id}, ${email}`,
    );

    const right = await api.authenticateWithPassword({ clientId, email, password });
    step(
      'the right password authenticates',
      right.ok && right.userId === user.id,
      right.ok ? `as ${right.userId}` : `HTTP ${right.status} ${right.code ?? ''}`,
    );

    // Meaningful only if the right password got through: otherwise a refusal
    // may come from a gate in front of the password check (SSO, MFA, Radar)
    // and say nothing about whether the hash is checked at all.
    const wrong = await api.authenticateWithPassword({ clientId, email, password: `${password}x` });
    step(
      'a wrong password is refused, by the password check',
      right.ok && !wrong.ok && !NOT_ABOUT_THE_PASSWORD.has(wrong.code ?? ''),
      wrong.ok ? `authenticated as ${wrong.userId}!` : `HTTP ${wrong.status} ${wrong.code ?? ''}`,
    );
  } catch (error) {
    step('self-test request', false, errorMessage(error));
  } finally {
    if (userId !== null) {
      await api.deleteUser(userId);
      step('synthetic user deleted', (await api.getUser(userId)) === null, userId);
    }
  }
  console.log(failed === 0 ? '\nSelf-test passed.' : `\nSelf-test FAILED (${failed} step(s)).`);
  return failed === 0 ? 0 : 1;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.mode) {
    case 'import':
      return runImport(args);
    case 'backfill':
      return runBackfill(args);
    case 'self-test':
      return runSelfTest(args);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      error instanceof Refusal ? `\nRefused: ${error.message}` : `\nFailed: ${errorMessage(error)}`,
    );
    process.exit(1);
  },
);
