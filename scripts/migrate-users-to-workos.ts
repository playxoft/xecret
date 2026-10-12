#!/usr/bin/env -S npx tsx
/**
 * Moves xecret's users from Firebase Auth to WorkOS, keeping their passwords.
 *
 * Runbook: docs/operations/workos-user-migration.md — it has the order these
 * run in and why. Plan: `.local/workos-auth.md` §6.
 *
 *   npm run phase:migrate-users:production -- <mode> --export <private dir>/users.json [--apply …]
 *
 * ## Modes
 *
 *  - **import** (default): one WorkOS user per importable Firebase user, with
 *    its Firebase scrypt hash, keyed by `external_id = firebase uid`. Writes the
 *    `firebase_uid → workos_user_id` mapping next to the export.
 *  - **--backfill**: `UPDATE users SET workos_user_id = $w WHERE firebase_uid =
 *    $f AND workos_user_id IS NULL`, row by row, after re-checking every mapped
 *    id against WorkOS.
 *  - **--check-hash-params <uid>**: recomputes that Firebase user's exported
 *    hash from their password, typed at a hidden prompt. The only check that
 *    catches wrong project parameters; the import's `--apply` refuses to send
 *    password hashes until it has passed. No WorkOS call.
 *  - **--check-sign-in <uid>**: after the import, signs in to WorkOS as that
 *    imported user with their password, typed at a hidden prompt, then revokes
 *    the WorkOS session the sign-in opened.
 *  - **--soft-delete-disabled**: soft-deletes the rows of Firebase users an
 *    operator disabled — removing their memberships in organisations shared
 *    with others, and refusing a sole active owner of one — or keeps them
 *    (`--keep <uid>`), so that "disabled" survives the swap. Every decision is
 *    recorded next to the export and honoured by later runs. Before the
 *    deploy. No WorkOS call.
 *  - **--self-test**: proves the WorkOS environment accepts and verifies a hash
 *    built exactly the way the import builds one.
 *
 * The rules live in `packages/db/src/firebase-migration/`, unit-tested there.
 *
 * ## Safety rules this script enforces
 *
 *  - **Dry run unless `--apply`.** A dry run reads WorkOS and the database and
 *    writes nothing.
 *  - **The WorkOS environment is verified, not assumed.** Each `--env` is pinned
 *    to xecret's own WorkOS client id; `WORKOS_CLIENT_ID` must be it, and
 *    WorkOS must agree the API key belongs to that client (a key does not say
 *    which environment it is for — the current format is `sk_` and base64 of
 *    `key_<id>,<secret>` — but WorkOS tells a key and a client from different
 *    environments apart). Every `--apply` that writes to WorkOS or links to it
 *    must also name the client with `--confirm-client`, typed from the runbook:
 *    the script never prints it. The npm scripts pair each Phase environment
 *    with its `--env`.
 *  - **Password hashes are sent only after `--check-hash-params` passed** for
 *    the same parameters in the same environment (a marker next to the export).
 *  - **A mapping is bound to its environment and client id**, and the backfill
 *    re-checks every id against WorkOS. xecret's Development and Production
 *    share one database, so a Staging id in `users.workos_user_id` would block
 *    the real Production link; a Staging backfill `--apply` is refused unless
 *    `--staging-database` says the database is not the shared one.
 *  - **The export and the mapping must live outside this repository.** The
 *    export holds every password hash.
 *  - **Nothing secret is printed.** Users are named by Firebase uid, xecret
 *    user id and WorkOS id; no hash, salt, parameter, key, password or address
 *    reaches the output.
 *  - **Never overwrites.** Existing WorkOS users are only read; a backfill only
 *    fills a NULL and reports `23505`/`23514` instead of forcing them.
 *
 * ## Reading the outcome
 *
 * The last line is always `RESULT: ok`, `RESULT: problems` (finished; review
 * the list above it), `RESULT: refused` or `RESULT: failed`. Read that line:
 * `phase run` does not pass the exit code through faithfully (it reports 1 for
 * the 2 that means "problems"). Exit codes are 0 / 2 / 1 / 1 for scripts that
 * call this directly.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
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
import {
  describeDecision,
  DISABLED_DECISIONS_FILE,
  keptUids,
  parseDisabledDecisions,
  serializeDisabledDecisions,
} from '../packages/db/src/firebase-migration/disabled-decisions.ts';
import type { DisabledDecision } from '../packages/db/src/firebase-migration/disabled-decisions.ts';
import {
  planDisabledSoftDelete,
  planMembershipsFor,
  softDeleteDisabledRow,
} from '../packages/db/src/firebase-migration/disabled-users.ts';
import type { PlannedMembership } from '../packages/db/src/firebase-migration/disabled-users.ts';
import { parseFirebaseExport } from '../packages/db/src/firebase-migration/firebase-export.ts';
import type { FirebaseExportUser } from '../packages/db/src/firebase-migration/firebase-export.ts';
import {
  firebaseScryptHash,
  firebaseScryptPhc,
  hashParamsFingerprint,
  matchesPublishedExample,
  parseFirebaseScryptParams,
  verifyFirebasePassword,
} from '../packages/db/src/firebase-migration/firebase-scrypt.ts';
import type { FirebaseScryptParams } from '../packages/db/src/firebase-migration/firebase-scrypt.ts';
import {
  markerMismatch,
  parseHashParamsMarker,
  serializeHashParamsMarker,
} from '../packages/db/src/firebase-migration/hash-params-marker.ts';
import {
  HiddenInputCancelled,
  HiddenInputUnavailable,
  readHiddenLine,
} from '../packages/db/src/firebase-migration/hidden-prompt.ts';
import {
  buildCreateUserInput,
  classifyFirebaseUser,
  decideImport,
  WORKOS_EXTERNAL_ID_MAX_LENGTH,
} from '../packages/db/src/firebase-migration/import-plan.ts';
import type {
  ImportCandidate,
  SkipReason,
} from '../packages/db/src/firebase-migration/import-plan.ts';
import {
  emptyUserMapping,
  parseUserMapping,
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

type Mode =
  | 'import'
  | 'backfill'
  | 'self-test'
  | 'check-hash-params'
  | 'check-sign-in'
  | 'soft-delete-disabled';

const MODE_FLAGS: Record<string, Mode> = {
  '--backfill': 'backfill',
  '--self-test': 'self-test',
  '--check-hash-params': 'check-hash-params',
  '--check-sign-in': 'check-sign-in',
  '--soft-delete-disabled': 'soft-delete-disabled',
};

interface Args {
  mode: Mode;
  env: MigrationEnvironment;
  /** The Firebase uid for `--check-hash-params` / `--check-sign-in`. */
  uid: string | null;
  exportPath: string | null;
  mappingPath: string | null;
  apply: boolean;
  confirmClient: string | null;
  stagingDatabase: boolean;
  keep: Set<string>;
}

const USAGE = `Usage: migrate-users-to-workos.ts --env staging|production [mode] [options]

Modes (default: import)
  --check-hash-params <uid>  Recompute that Firebase user's exported hash from their password
                             (hidden prompt). Must pass before an import --apply. No WorkOS call.
  --soft-delete-disabled     Soft-delete the rows of disabled Firebase users. No WorkOS call.
  --check-sign-in <uid>      Sign in to WorkOS as that imported user (hidden password prompt).
  --backfill                 Write users.workos_user_id from the mapping file.
  --self-test                Create, authenticate as, and delete one synthetic WorkOS user.

Options
  --export <file>            firebase auth:export --format=json output.
  --mapping <file>           Default: workos-mapping.<env>.json next to the export.
  --apply                    Write. Without it, import, backfill and soft-delete are dry runs.
  --confirm-client <id>      Required with an import or backfill --apply: the WorkOS client id of
                             the environment you mean to write to, typed from the runbook.
  --keep <uid>               With --soft-delete-disabled: keep this disabled user's row active
                             (repeatable). Only after deciding they may get access back. An
                             --apply records it; later runs honour it without --keep.
  --dry-run                  The default; accepted for clarity.
  --staging-database         Allow a staging --backfill --apply: only when the database is NOT
                             shared with production. (xecret's is shared. Do not pass this there.)

The last line is RESULT: ok | problems | refused | failed.`;

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
    uid: null,
    exportPath: null,
    mappingPath: null,
    apply: false,
    confirmClient: null,
    stagingDatabase: false,
    keep: new Set(),
  };
  let env: string | null = null;
  let dryRun = false;
  let modeFlag: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    // Every flag but --keep means one thing once. A repeat is a mistake —
    // `--env staging … --env production` most of all — never a last-one-wins.
    if (flag !== '--keep') {
      if (seen.has(flag)) refuse(`${flag} is given twice.`);
      seen.add(flag);
    }
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        refuse(`${flag} needs a value.\n\n${USAGE}`);
      }
      i += 1;
      return next;
    };
    const mode = MODE_FLAGS[flag];
    if (mode !== undefined) {
      if (modeFlag !== null) refuse(`Choose one mode: ${modeFlag} and ${flag} were both given.`);
      modeFlag = flag;
      args.mode = mode;
      if (mode === 'check-hash-params' || mode === 'check-sign-in') args.uid = value();
      continue;
    }
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
      case '--keep':
        args.keep.add(value());
        break;
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
  const writes =
    args.mode === 'import' || args.mode === 'backfill' || args.mode === 'soft-delete-disabled';
  if (args.apply && !writes) refuse(`--apply does not apply to --${args.mode}.`);
  if (args.confirmClient !== null && !(args.apply && args.mode !== 'soft-delete-disabled')) {
    refuse('--confirm-client only goes with an import or backfill --apply.');
  }
  if (args.keep.size > 0 && args.mode !== 'soft-delete-disabled') {
    refuse('--keep only goes with --soft-delete-disabled.');
  }
  if (args.mode === 'self-test' && args.exportPath) refuse('--self-test takes no --export.');
  if (args.stagingDatabase && !(args.mode === 'backfill' && env === 'staging')) {
    refuse('--staging-database only applies to a staging --backfill.');
  }
  return args;
}

// ── environment and files ───────────────────────────────────────────────────

/**
 * xecret's WorkOS application in each environment. Pinned here so that no
 * combination of Phase environment and `--env` can point a run at the wrong
 * one; a self-hoster running this against their own WorkOS team edits these.
 */
const PINNED_CLIENT_ID: Record<MigrationEnvironment, string> = {
  staging: 'client_01M36CECEQ1FY9TA1F952FY958',
  production: 'client_01M36CECX3Z66Q2FYY2FN8WG73',
};

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
      'WORKOS_API_KEY and WORKOS_CLIENT_ID must both be set. Run through the npm script for the ' +
        'environment, e.g. `npm run phase:migrate-users:staging -- …`.',
    );
  }
  if (clientId !== PINNED_CLIENT_ID[args.env]) {
    refuse(
      `WORKOS_CLIENT_ID is not xecret's ${args.env} WorkOS client. Check --env against the Phase ` +
        'environment the command runs under.',
    );
  }
  const api = createWorkosUsersApi({ apiKey });
  if ((await api.checkClientPairing(clientId)) !== 'same-environment') {
    refuse(
      `WorkOS says WORKOS_API_KEY does not belong to the ${args.env} client. Fix the Phase ` +
        'environment before running anything.',
    );
  }
  if (args.apply && args.confirmClient !== clientId) {
    refuse(
      args.confirmClient === null
        ? `--apply needs --confirm-client with the ${args.env} client id, typed from the runbook ` +
            '(docs/operations/workos-user-migration.md §2).'
        : `--confirm-client is not the ${args.env} client. Nothing was written.`,
    );
  }
  return { api, clientId };
}

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) refuse('DATABASE_URL is not set.');
  return url;
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

/** The export holds every password hash; nothing written beside it belongs in a working tree. */
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

function markerPathFor(args: Args, exportPath: string): string {
  return join(dirname(exportPath), `hash-params-verified.${args.env}.json`);
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
    refuse(`${path} maps users in WorkOS ${mapping.environment}, not ${env}. Never mix the two.`);
  }
  return mapping;
}

/** Written whole, then renamed over the old one: a crash leaves the previous file, never half of one. */
async function writeJsonAtomically(path: string, json: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function saveMapping(path: string, mapping: UserMapping): Promise<void> {
  await writeJsonAtomically(path, serializeUserMapping(mapping, new Date().toISOString()));
}

function readScryptParams(): FirebaseScryptParams {
  try {
    return parseFirebaseScryptParams(process.env);
  } catch (error) {
    refuse(
      `${errorMessage(error)} The Firebase hash parameters come from Phase (FIREBASE_SCRYPT_*).`,
    );
  }
}

/** What the marker next to the export says about these parameters, for this environment. */
async function hashParamsStatus(
  args: Args,
  exportPath: string,
  params: FirebaseScryptParams,
): Promise<{ verified: true; uid: string; at: string } | { verified: false; why: string }> {
  const path = markerPathFor(args, exportPath);
  if (!existsSync(path)) return { verified: false, why: 'never checked' };
  const marker = parseHashParamsMarker(await readJson(path));
  const mismatch = markerMismatch(marker, args.env, hashParamsFingerprint(params));
  if (mismatch === 'other-environment')
    return { verified: false, why: 'checked for the other environment' };
  if (mismatch === 'other-parameters') {
    return { verified: false, why: 'checked for different parameters than the ones in use now' };
  }
  return { verified: true, uid: marker.firebaseUid, at: marker.verifiedAt };
}

async function promptPassword(prompt: string): Promise<string> {
  try {
    return await readHiddenLine(process.stdin, process.stdout, prompt);
  } catch (error) {
    if (error instanceof HiddenInputUnavailable || error instanceof HiddenInputCancelled) {
      refuse(error.message);
    }
    throw error;
  }
}

// ── output ──────────────────────────────────────────────────────────────────

type Outcome = 'ok' | 'problems' | 'failed';

function row(label: string, value: number | string, indent = 2): void {
  const left = `${' '.repeat(indent)}${label} `;
  console.log(`${left.padEnd(60, '.')} ${value}`);
}

function header(args: Args, workos: 'verified' | 'none', extra: string): void {
  const mode = args.apply ? 'APPLY (writes)' : 'dry run (writes nothing)';
  const writes = ['import', 'backfill', 'soft-delete-disabled'].includes(args.mode);
  const target =
    workos === 'verified'
      ? `WorkOS ${args.env} (pinned client, key verified)`
      : `${args.env} · no WorkOS calls`;
  console.log(
    `\nxecret · Firebase → WorkOS · ${args.mode} · ${target}${writes ? ` · ${mode}` : ''}`,
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

function printList(title: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  console.log(`\n${title} (${lines.length}):`);
  for (const line of lines) console.log(`  - ${line}`);
}

function finish(problems: readonly string[], notes: readonly string[] = []): Outcome {
  printList('Notes', notes);
  if (problems.length === 0) {
    console.log('\nNo problems.');
    return 'ok';
  }
  printList('Problems to review', problems);
  return 'problems';
}

/** True before the deploy and after it: the decision belongs before, and is still owed after. */
const DISABLED_ADVICE =
  'soft-delete its row with --soft-delete-disabled unless it was kept on purpose with --keep (runbook §4)';

// ── --check-hash-params ─────────────────────────────────────────────────────

async function runCheckHashParams(args: Args): Promise<Outcome> {
  const exportPath = requireExportPath(args);
  const uid = args.uid ?? refuse('--check-hash-params needs a Firebase uid.');
  const params = readScryptParams();
  const user = (await loadExport(exportPath)).find((u) => u.uid === uid);
  if (!user) refuse(`No Firebase user ${uid} in the export.`);
  if (user.password === null)
    refuse(`Firebase user ${uid} has no password. Use an account that does.`);
  if (user.password === 'malformed')
    refuse(`Firebase user ${uid}'s password fields do not decode.`);

  header(args, 'none', `export: ${exportPath}`);
  if (!matchesPublishedExample()) {
    console.log("FAIL  local firebase-scrypt does not reproduce Firebase's published example");
    return 'failed';
  }
  const password = await promptPassword(`Password of Firebase user ${uid} (not shown): `);
  const match = verifyFirebasePassword(password, user.password, params);
  if (!match) {
    console.log(
      "Hash parameters: NO MATCH. Either that password is not the account's current one, or the " +
        "FIREBASE_SCRYPT_* values are not this project's. Do not --apply the import.",
    );
    return 'failed';
  }
  const markerPath = markerPathFor(args, exportPath);
  await writeJsonAtomically(
    markerPath,
    serializeHashParamsMarker({
      environment: args.env,
      fingerprint: hashParamsFingerprint(params),
      firebaseUid: uid,
      verifiedAt: new Date().toISOString(),
    }),
  );
  console.log(`Hash parameters: MATCH. Recorded in ${markerPath}.`);
  return 'ok';
}

// ── --soft-delete-disabled ──────────────────────────────────────────────────

function decisionsPathFor(exportPath: string): string {
  return join(dirname(exportPath), DISABLED_DECISIONS_FILE);
}

async function loadDecisions(exportPath: string): Promise<Map<string, DisabledDecision>> {
  const path = decisionsPathFor(exportPath);
  return existsSync(path) ? new Map(parseDisabledDecisions(await readJson(path))) : new Map();
}

/** Organisation names are customer text: one line, printable, short. */
function safeName(name: string): string {
  const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
}

function describeMembership({ membership: m, action }: PlannedMembership): string {
  const others = m.totalMembers - 1;
  const what =
    action === 'solo'
      ? 'alone in it: left as it is'
      : action === 'remove'
        ? 'membership will be removed'
        : 'BLOCKS: their only active owner among the others — make another member an owner first, or --keep';
  return `org ${m.orgId} "${safeName(m.orgName)}" ${m.role}${m.status === 'active' ? '' : ` (${m.status})`}, ${others} other member(s): ${what}`;
}

async function runSoftDeleteDisabled(args: Args): Promise<Outcome> {
  const exportPath = requireExportPath(args);
  const databaseUrl = requireDatabaseUrl();
  const users = await loadExport(exportPath);
  const disabledUids = new Set(users.filter((u) => u.disabled).map((u) => u.uid));
  const decisionsPath = decisionsPathFor(exportPath);
  const decisions = await loadDecisions(exportPath);
  // A keep recorded by an earlier --apply counts as if --keep were given again.
  const recordedKeeps = keptUids(decisions);
  const keep = new Set([...args.keep, ...recordedKeeps]);

  const { db, end } = createDatabaseHandle({ connectionString: databaseUrl });
  try {
    const plan = planDisabledSoftDelete({ rows: await loadBackfillRows(db), disabledUids, keep });
    const unknown = plan.unknownKeep.filter((uid) => args.keep.has(uid));
    if (unknown.length > 0) {
      refuse(`--keep names no disabled Firebase user with a row: ${unknown.join(', ')}.`);
    }
    header(
      args,
      'none',
      `export: ${users.length} Firebase users, ${disabledUids.size} disabled · decisions: ${decisionsPath}`,
    );

    const pending = plan.items.filter((i) => i.state === 'active' && !i.kept);
    const kept = plan.items.filter((i) => i.state === 'active' && i.kept);
    const describe = (i: (typeof plan.items)[number]) =>
      `user ${i.userId} (firebase ${i.firebaseUid})${i.linkedWorkosUserId ? ` [linked to ${i.linkedWorkosUserId}]` : ''}`;
    row('disabled, row active: to soft-delete', pending.length);
    row('disabled, row active: kept', kept.length);
    row('disabled, row already soft-deleted', plan.items.length - pending.length - kept.length);
    row('disabled, no xecret row (nothing to lock)', plan.withoutRow.length);

    // Every row still to decide, with what would happen to each of its memberships.
    const planned = new Map<string, PlannedMembership[]>();
    for (const item of pending) planned.set(item.userId, await planMembershipsFor(db, item.userId));
    if (pending.length > 0) {
      console.log(`\nTo soft-delete${args.apply ? '' : ' (dry run)'}:`);
      for (const item of pending) {
        console.log(`  ${describe(item)}`);
        const memberships = planned.get(item.userId) ?? [];
        if (memberships.length === 0) console.log('      no organisation memberships');
        for (const p of memberships) console.log(`      ${describeMembership(p)}`);
      }
    }

    // A kept row is a decision already made: a note, not a problem.
    const notes = kept.map((i) => {
      const recorded = decisions.get(i.firebaseUid);
      const when =
        recorded?.decision === 'kept' ? describeDecision(recorded) : 'kept by --keep on this run';
      return `${describe(i)}: ${when} — they can sign in through WorkOS`;
    });

    if (!args.apply) {
      const problems = pending.map((i) => {
        const blocked = (planned.get(i.userId) ?? []).some((p) => p.action === 'blocks');
        return blocked
          ? `${describe(i)}: --apply would REFUSE it: sole active owner of an organisation with other members (listed above)`
          : `${describe(i)}: would be soft-deleted by --apply` +
              (i.linkedWorkosUserId ? ' (already signed in through WorkOS: has access now)' : '');
      });
      return finish(problems, notes);
    }

    const problems: string[] = [];
    const now = () => new Date().toISOString();
    // The decisions file is written after every change. If a write fails, the
    // database change has still happened: say so loudly, keep going, and print
    // the entry so it can be added by hand.
    const record = async (uid: string, decision: DisabledDecision) => {
      decisions.set(uid, decision);
      try {
        await writeJsonAtomically(decisionsPath, serializeDisabledDecisions(decisions));
      } catch (error) {
        problems.push(
          `firebase ${uid}: the decision was made but NOT written to ${decisionsPath} (${errorMessage(error)}). ` +
            `Add it by hand: "${uid}": ${JSON.stringify(decision)}`,
        );
      }
    };

    for (const item of kept) {
      if (decisions.get(item.firebaseUid)?.decision !== 'kept') {
        await record(item.firebaseUid, { decision: 'kept', userId: item.userId, decidedAt: now() });
      }
    }
    for (const item of plan.items.filter((i) => i.state === 'already-deleted')) {
      if (!decisions.has(item.firebaseUid)) {
        await record(item.firebaseUid, {
          decision: 'already-deleted',
          userId: item.userId,
          decidedAt: now(),
        });
      }
    }
    for (const uid of plan.withoutRow) {
      if (!decisions.has(uid)) await record(uid, { decision: 'no-row', decidedAt: now() });
    }

    let done = 0;
    for (const item of pending) {
      // Printed before the write, so the screen says which row was being acted on
      // even if what follows fails.
      console.log(`\n  soft-deleting ${describe(item)} …`);
      const result = await softDeleteDisabledRow(db, item.userId, item.firebaseUid);
      if (result.result === 'not-active') {
        problems.push(`${describe(item)}: changed since it was read — not touched`);
        continue;
      }
      if (result.result === 'blocked') {
        problems.push(
          `${describe(item)}: REFUSED, nothing written — sole active owner among others in ${result.orgIds.join(', ') || 'an organisation (changed meanwhile)'}. ` +
            'Make another member an owner first (runbook §5), or --keep them.',
        );
        continue;
      }
      done += 1;
      console.log(
        `    done: revoked ${result.revokedSessions} session(s), ${result.revokedCliTokens} CLI token(s); ` +
          `removed from ${result.removedFromOrgs.length} organisation(s)` +
          (result.soloOrgs.length > 0
            ? `; ${result.soloOrgs.length} solo organisation(s) left as they are`
            : ''),
      );
      await record(item.firebaseUid, {
        decision: 'soft-deleted',
        userId: item.userId,
        decidedAt: now(),
        revokedSessions: result.revokedSessions,
        revokedCliTokens: result.revokedCliTokens,
        removedFromOrgs: result.removedFromOrgs,
      });
    }
    console.log(`\nSoft-deleted ${done}. Decisions: ${decisionsPath}`);
    return finish(problems, notes);
  } finally {
    await end();
  }
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

async function runImport(args: Args): Promise<Outcome> {
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
  const verification = params ? await hashParamsStatus(args, exportPath, params) : null;
  if (args.apply && passwordUsers > 0) {
    if (params === null) {
      refuse(
        `${paramsProblem} ${passwordUsers} user(s) have passwords, and they cannot be imported without the project's hash parameters.`,
      );
    }
    if (verification === null || !verification.verified) {
      refuse(
        `The hash parameters are not verified for ${args.env} (${verification?.verified === false ? verification.why : 'no parameters'}). ` +
          `Run --check-hash-params <your own Firebase uid> with this --export first (runbook §4).`,
      );
    }
  }

  header(
    args,
    'verified',
    `export: ${users.length} Firebase users · mapping: ${mappingPath}${existsSync(mappingPath) ? '' : ' (new)'}`,
  );

  const tally = new Tally();
  const problems: string[] = [];
  const notes: string[] = [];
  // The import never reads the database; what was decided for each disabled
  // user is in the decisions file --soft-delete-disabled --apply keeps.
  const decisions = await loadDecisions(exportPath);

  for (const { user, classification } of classified) {
    if (classification.action === 'skip') {
      tally.add(`skip:${classification.reason}`);
      if (classification.reason === 'disabled') {
        const decision = decisions.get(classification.uid);
        if (decision) notes.push(`${classification.uid}: disabled — ${describeDecision(decision)}`);
        else
          problems.push(
            `${classification.uid}: disabled, and nothing decided yet — ${DISABLED_ADVICE}`,
          );
      }
      if (classification.reason === 'malformed-password') {
        problems.push(`${classification.uid}: skipped (malformed password) — decide by hand`);
      }
      continue;
    }
    const { candidate } = classification;
    tally.add(`kind:${candidate.kind}`);
    if (user.mfaEnrolled) {
      tally.add('mfa');
      notes.push(
        `${candidate.uid}: had Firebase MFA, which is not migrated — ask them to enrol again in WorkOS`,
      );
    }

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
  row('had Firebase MFA (factor not migrated)', tally.get('mfa'));
  console.log(`\nWorkOS ${args.env}`);
  row(args.apply ? 'created' : 'would create', tally.get('create'));
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
  console.log('');
  if (params === null) {
    console.log(`Hash parameters: NOT AVAILABLE — ${paramsProblem}`);
  } else if (verification?.verified) {
    console.log(
      `Hash parameters: verified by --check-hash-params (Firebase user ${verification.uid}, ${verification.at})`,
    );
  } else {
    console.log(
      `Hash parameters: present, NOT VERIFIED (${verification?.verified === false ? verification.why : '?'})`,
    );
  }
  if (passwordUsers > 0 && !verification?.verified) {
    problems.push(
      `--apply will refuse until --check-hash-params passes: ${passwordUsers} password user(s)`,
    );
  }
  console.log(
    args.apply
      ? `Mapping: ${mapping.entries.size} entries in ${mappingPath}`
      : `Mapping: would be written to ${mappingPath} by --apply`,
  );
  return finish(problems, notes);
}

// ── --check-sign-in ─────────────────────────────────────────────────────────

async function runCheckSignIn(args: Args): Promise<Outcome> {
  const exportPath = requireExportPath(args);
  const mappingPath = mappingPathFor(args, exportPath);
  const uid = args.uid ?? refuse('--check-sign-in needs a Firebase uid.');
  const { api, clientId } = await connectWorkos(args);
  const users = await loadExport(exportPath);
  const mapping = await loadMapping(mappingPath, args.env, clientId, true);
  const entry = mapping.entries.get(uid);
  if (!entry) refuse(`Firebase user ${uid} is not in the mapping: it was not imported.`);
  if (entry.passwordImported === false) {
    refuse(
      `Firebase user ${uid}'s password was not imported (no password, or a reused WorkOS user). Use an account that had one.`,
    );
  }

  header(args, 'verified', `checking imported user ${entry.workosUserId} (firebase ${uid})`);
  const workosUser = await api.getUser(entry.workosUserId);
  const firebaseEmail = users.find((u) => u.uid === uid)?.email ?? null;
  const rejection = checkMappedUser(uid, entry, firebaseEmail, workosUser);
  if (workosUser === null || rejection !== null) {
    console.log(
      `The mapped WorkOS user does not check out: ${rejection ?? 'workos-user-missing'}.`,
    );
    return 'failed';
  }
  const password = await promptPassword(`Password of Firebase user ${uid} (not shown): `);
  const result = await api.authenticateWithPassword({
    clientId,
    email: workosUser.email,
    password,
  });
  if (result.ok) {
    // The check signed in for real; leave nothing signed in behind it.
    let revoked = false;
    if (result.sessionId !== null) {
      try {
        await api.revokeSession(result.sessionId);
        revoked = true;
      } catch (error) {
        console.log(`WorkOS session ${result.sessionId} was NOT revoked: ${errorMessage(error)}`);
      }
    }
    console.log(
      revoked
        ? `WorkOS session ${result.sessionId} revoked.`
        : 'Revoke the session in the WorkOS dashboard (Users → this user → Sessions).',
    );
    if (result.userId !== entry.workosUserId) {
      console.log(
        `Sign-in: signed in as ${result.userId}, which is not the mapped user. Stop and investigate.`,
      );
      return 'failed';
    }
    console.log(
      `Sign-in: OK, as ${result.userId}. The imported password works in WorkOS ${args.env}.`,
    );
    return revoked ? 'ok' : 'problems';
  }
  console.log(
    `Sign-in: REFUSED (HTTP ${result.status} ${result.code ?? ''}). Do not run the backfill; see runbook §4 step 9.`,
  );
  return 'failed';
}

// ── backfill ────────────────────────────────────────────────────────────────

function describeSkip(reason: SkipReason, deleted: boolean): string {
  if (reason !== 'disabled') return `the import skips this user (${reason})`;
  return deleted
    ? 'the Firebase account is disabled; the row is soft-deleted, so they are locked out again'
    : 'the Firebase account is DISABLED, and this person has access again';
}

async function runBackfill(args: Args): Promise<Outcome> {
  const exportPath = requireExportPath(args);
  const mappingPath = mappingPathFor(args, exportPath);
  if (args.apply && args.env === 'staging' && !args.stagingDatabase) {
    refuse(
      "A staging backfill writes Staging WorkOS ids into users.workos_user_id. xecret's Development and Production " +
        'share one database, where that would block every Production link. Refused. (A self-hoster with a separate ' +
        'staging database can pass --staging-database.)',
    );
  }
  const databaseUrl = requireDatabaseUrl();
  const { api, clientId } = await connectWorkos(args);

  const users = await loadExport(exportPath);
  const mapping = await loadMapping(mappingPath, args.env, clientId, true);
  const emailByUid = new Map(users.map((u) => [u.uid, u.email]));
  const skipReasons = new Map<string, SkipReason>();
  for (const user of users) {
    const classification = classifyFirebaseUser(user);
    if (classification.action === 'skip') skipReasons.set(user.uid, classification.reason);
  }

  header(
    args,
    'verified',
    `export: ${users.length} Firebase users · mapping: ${mapping.entries.size} entries (${mappingPath})`,
  );

  // Every mapped id is re-checked against the WorkOS environment whose key is
  // in use before it may become a link. See checkMappedUser.
  const accepted = new Map<string, string>();
  const mappedEmails = new Map<string, string>();
  const rejected = new Map<string, MappingRejection>();
  for (const [uid, entry] of mapping.entries) {
    const workosUser = await api.getUser(entry.workosUserId);
    const rejection = checkMappedUser(uid, entry, emailByUid.get(uid) ?? null, workosUser);
    if (rejection === null && workosUser !== null) {
      accepted.set(uid, entry.workosUserId);
      mappedEmails.set(uid, workosUser.email);
    } else if (rejection !== null) {
      rejected.set(uid, rejection);
    }
  }

  const decisions = await loadDecisions(exportPath);
  const { db, end } = createDatabaseHandle({ connectionString: databaseUrl });
  try {
    const rows = await loadBackfillRows(db);
    const plan = planBackfill({
      rows,
      exportUids: new Set(users.map((u) => u.uid)),
      mapping: accepted,
      rejected,
      skipReasons,
      mappedEmails,
    });
    const tally = new Tally();
    const problems: string[] = [];
    const notes: string[] = [];
    for (const item of plan.items) {
      tally.add(item.action);
      const who = `user ${item.userId} (firebase ${item.firebaseUid})`;
      const decision = decisions.get(item.firebaseUid);
      switch (item.action) {
        case 'update':
          if (item.deleted) tally.add('update-deleted');
          break;
        case 'already-linked':
          break;
        case 'linked-elsewhere':
          problems.push(
            `${who}: already linked to ${item.currentWorkosUserId}, mapping says ${item.mappedWorkosUserId} — not overwritten`,
          );
          break;
        case 'held-by-other-row':
          problems.push(
            `${who}: ${item.workosUserId} is already on user ${item.holderUserId} — would be 23505`,
          );
          break;
        case 'mapping-rejected':
          problems.push(`${who}: mapping entry rejected (${item.reason})`);
          break;
        case 'linked-but-not-importable':
          if (item.reason === 'disabled' && decision?.decision === 'kept') {
            notes.push(
              `${who}: disabled, ${describeDecision(decision)}; linked to ${item.currentWorkosUserId} by a WorkOS sign-in`,
            );
            break;
          }
          problems.push(
            `${item.reason === 'disabled' && !item.deleted ? '!! ' : ''}${who}${item.deleted ? ' [deleted]' : ''}: LINKED to ${item.currentWorkosUserId} by a WorkOS sign-in, but ${describeSkip(item.reason, item.deleted)}` +
              (item.reason === 'disabled' && !item.deleted ? ` — ${DISABLED_ADVICE}` : ''),
          );
          break;
        case 'not-importable':
          tally.add(`not-importable:${item.reason}`);
          if (item.reason === 'disabled' && (decision !== undefined || item.deleted)) {
            notes.push(
              `${who}${item.deleted ? ' [deleted]' : ''}: disabled, not linked — ${decision ? describeDecision(decision) : 'row soft-deleted'}` +
                (item.mappingIgnored ? '; its mapping entry was ignored' : ''),
            );
            break;
          }
          problems.push(
            `${who}${item.deleted ? ' [deleted]' : ''}: not imported (${item.reason}) — stays unlinked` +
              (item.mappingIgnored ? '; its mapping entry was ignored' : '') +
              (item.reason === 'disabled' && !item.deleted ? `; ${DISABLED_ADVICE}` : ''),
          );
          break;
        case 'not-imported':
          problems.push(
            `${who}${item.deleted ? ' [deleted]' : ''}: importable but not in the mapping — re-run the import`,
          );
          break;
        case 'linked-not-imported':
          problems.push(
            `${who}: not in the mapping, but a WorkOS sign-in linked it to ${item.currentWorkosUserId} — nothing to write`,
          );
          break;
        case 'no-firebase-user':
          problems.push(
            `${who}${item.deleted ? ' [deleted]' : ''}: no such Firebase user in the export`,
          );
          break;
      }
    }
    for (const warning of plan.emailHolders) {
      problems.push(
        `user ${warning.userId} (firebase ${warning.firebaseUid}): ${warning.workosUserId}'s address is held by user ${warning.holderUserId} — the first sign-in will be a 409 until the two rows are sorted out`,
      );
    }

    console.log(`Database (${rows.length} users)`);
    row(args.apply ? 'to link now' : 'would link', tally.get('update'));
    if (tally.get('update-deleted') > 0)
      row('  of which soft-deleted', tally.get('update-deleted'));
    row('already linked to the mapped id', tally.get('already-linked'));
    row('linked to a different id (reported)', tally.get('linked-elsewhere'));
    row('mapped id held by another row (reported, 23505)', tally.get('held-by-other-row'));
    row('mapping entry rejected by WorkOS check (reported)', tally.get('mapping-rejected'));
    row('not imported: disabled (reported)', tally.get('not-importable:disabled'));
    row(
      'not imported: other skip reasons (reported)',
      tally.get('not-importable') - tally.get('not-importable:disabled'),
    );
    row(
      'not imported, but linked by a sign-in (reported)',
      tally.get('linked-but-not-importable') + tally.get('linked-not-imported'),
    );
    row('importable but not in the mapping (reported)', tally.get('not-imported'));
    row('no Firebase user in the export (reported)', tally.get('no-firebase-user'));
    row('mapped address held by another row (reported)', plan.emailHolders.length);
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
    return finish(problems, notes);
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

async function runSelfTest(args: Args): Promise<Outcome> {
  const params = readScryptParams();
  const { api, clientId } = await connectWorkos(args);

  header(args, 'verified', '');
  let failed = 0;
  const step = (name: string, ok: boolean, detail = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const reproduces = matchesPublishedExample();
  step("local firebase-scrypt reproduces Firebase's published example", reproduces);
  if (!reproduces) return 'failed';

  const tag = randomBytes(6).toString('hex');
  // example.net, not example.com: a WorkOS staging environment's built-in SSO
  // test organisation claims example.com, so every password attempt there is
  // answered `sso_required` before the password is even looked at.
  const email = `migration-selftest+${tag}@${SELF_TEST_DOMAIN}`;
  const password = randomBytes(18).toString('base64url');
  const salt = new Uint8Array(randomBytes(12));
  const phc = firebaseScryptPhc(firebaseScryptHash(password, salt, params), salt, params);
  step(
    'hash built with the parameters in use',
    true,
    'throwaway password, random salt; neither printed',
  );
  console.log(
    "      (self-consistent: it cannot tell the wrong project's parameters from the right ones — that is --check-hash-params)",
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
      try {
        await api.deleteUser(userId);
        step('synthetic user deleted', (await api.getUser(userId)) === null, userId);
      } catch (error) {
        step(
          'synthetic user deleted',
          false,
          `${errorMessage(error)} — delete ${userId} (${email}) by hand: runbook §6`,
        );
      }
    }
  }
  console.log(failed === 0 ? '\nSelf-test passed.' : `\nSelf-test FAILED (${failed} step(s)).`);
  return failed === 0 ? 'ok' : 'failed';
}

// ── main ────────────────────────────────────────────────────────────────────

const RUNNERS: Record<Mode, (args: Args) => Promise<Outcome>> = {
  import: runImport,
  backfill: runBackfill,
  'self-test': runSelfTest,
  'check-hash-params': runCheckHashParams,
  'check-sign-in': runCheckSignIn,
  'soft-delete-disabled': runSoftDeleteDisabled,
};

const EXIT_CODE: Record<Outcome | 'refused', number> = {
  ok: 0,
  problems: 2,
  refused: 1,
  failed: 1,
};

async function main(): Promise<Outcome> {
  const args = parseArgs(process.argv.slice(2));
  return RUNNERS[args.mode](args);
}

main().then(
  (outcome) => {
    console.log(`\nRESULT: ${outcome}`);
    process.exit(EXIT_CODE[outcome]);
  },
  (error: unknown) => {
    const refused = error instanceof Refusal;
    console.error(refused ? `\nRefused: ${error.message}` : `\nFailed: ${errorMessage(error)}`);
    console.log(`\nRESULT: ${refused ? 'refused' : 'failed'}`);
    process.exit(1);
  },
);
