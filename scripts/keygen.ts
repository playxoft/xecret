#!/usr/bin/env -S npx tsx
/**
 * Root KEK generation and escrow, for the key ceremony in
 * docs/security/key-recovery.md.
 *
 * Run this on an OFFLINE, freshly booted machine. It writes nothing to disk and
 * prints the key exactly once.
 *
 *   npx tsx scripts/keygen.ts
 *   npx tsx scripts/keygen.ts --version 2          # generating a rotation key
 *   npx tsx scripts/keygen.ts --recover --share ... --share ...
 *   npx tsx scripts/keygen.ts --verify --share ... --share ... --fingerprint ab12…
 *
 * ⚠ Losing this key destroys every customer's secrets permanently. A database
 *   backup does not help — ciphertext without the key is noise.
 */

import {
  KEY_LENGTH,
  randomBytes,
  toBase64Url,
  fromBase64Url,
} from '../packages/core/src/crypto/index.ts';
import { combine, split } from '../packages/core/src/crypto/shamir.ts';
import type { ShamirShare } from '../packages/core/src/crypto/shamir.ts';

const SHARE_PREFIX = 'xecret-share-v1';

/**
 * A short public identifier for a key.
 *
 * Safe to write down, commit, and paste into a runbook: it is a truncated
 * SHA-256 of the key, which reveals nothing about the key itself but lets a
 * recovered value be checked against the record in key-recovery.md §7. Verifying
 * a fingerprint before writing anything is what stops a wrong key silently
 * producing garbage.
 */
async function fingerprint(key: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', key);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function encodeShare(share: ShamirShare, fp: string): string {
  return `${SHARE_PREFIX}.${share.index}.${toBase64Url(share.data)}.${fp}`;
}

function decodeShare(encoded: string): { share: ShamirShare; fingerprint: string } {
  const parts = encoded.trim().split('.');

  if (parts.length !== 4 || parts[0] !== SHARE_PREFIX) {
    throw new Error(`Not a valid share. Expected "${SHARE_PREFIX}.<index>.<data>.<fingerprint>"`);
  }

  const index = Number(parts[1]);
  if (!Number.isInteger(index) || index < 1 || index > 255) {
    throw new Error(`Share index "${parts[1]}" is out of range`);
  }

  return { share: { index, data: fromBase64Url(parts[2]!) }, fingerprint: parts[3]! };
}

function parseArgs(argv: readonly string[]) {
  const shares: string[] = [];
  let mode: 'generate' | 'recover' | 'verify' = 'generate';
  let version = 1;
  let expectedFingerprint: string | undefined;
  let totalShares = 3;
  let threshold = 2;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--recover':
        mode = 'recover';
        break;
      case '--verify':
        mode = 'verify';
        break;
      case '--share':
        shares.push(argv[++i] ?? '');
        break;
      case '--version':
        version = Number(argv[++i]);
        break;
      case '--fingerprint':
        expectedFingerprint = argv[++i];
        break;
      case '--shares':
        totalShares = Number(argv[++i]);
        break;
      case '--threshold':
        threshold = Number(argv[++i]);
        break;
      case '--help':
      case '-h':
        mode = 'generate';
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { mode, shares, version, expectedFingerprint, totalShares, threshold };
}

async function generate(options: {
  version: number;
  totalShares: number;
  threshold: number;
}): Promise<void> {
  if (!Number.isInteger(options.version) || options.version < 1) {
    throw new Error('--version must be a positive integer');
  }

  const key = randomBytes(KEY_LENGTH);
  const fp = await fingerprint(key);
  const shares = split(key, options.totalShares, options.threshold);

  process.stdout.write(`
════════════════════════════════════════════════════════════════════════════
  xecret Root KEK — version ${options.version}
════════════════════════════════════════════════════════════════════════════

  Fingerprint (safe to record in key-recovery.md §7):

      ${fp}

────────────────────────────────────────────────────────────────────────────
  1. PASTE INTO PHASE.DEV
────────────────────────────────────────────────────────────────────────────

  Paste directly into the Phase.dev web UI. Never via a shell command — shell
  history persists. Never into a file.

  XECRET_ROOT_KEYS
      {"${options.version}":"${toBase64Url(key)}"}

  XECRET_ROOT_KEY_VERSION
      ${options.version}

  During a rotation, MERGE this key into the existing XECRET_ROOT_KEYS object
  rather than replacing it. Both versions must be readable until every org key
  has been re-wrapped, or rows still on the old version become unreadable.

────────────────────────────────────────────────────────────────────────────
  2. DISTRIBUTE ESCROW SHARES  (${options.threshold} of ${options.totalShares} reconstruct the key)
────────────────────────────────────────────────────────────────────────────

  Rules — each exists because breaking it collapses the scheme:
    · Never two shares in one physical location.
    · Never all shares digital.
    · Never a share in Phase.dev, a password manager, cloud storage, or chat.
    · A 2-of-3 scheme where one person holds two shares is a 1-of-1 scheme.

`);

  for (const share of shares) {
    process.stdout.write(`  Share ${share.index}:\n      ${encodeShare(share, fp)}\n\n`);
  }

  process.stdout.write(`────────────────────────────────────────────────────────────────────────────
  3. AFTERWARDS
────────────────────────────────────────────────────────────────────────────

  · Clear the clipboard, close this terminal, power the machine off.
  · Record the fingerprint and share locations in key-recovery.md §7.
  · Verify: deploy to staging, encrypt a canary, decrypt it, confirm the
    fingerprint matches. The ceremony is not complete until this passes.
  · Schedule the first quarterly restore drill.

════════════════════════════════════════════════════════════════════════════
`);

  key.fill(0);
  for (const share of shares) share.data.fill(0);
}

async function recover(encodedShares: readonly string[], expected?: string): Promise<void> {
  if (encodedShares.length < 2) {
    throw new Error('At least 2 shares are required. Pass each with --share "<value>"');
  }

  const decoded = encodedShares.map(decodeShare);

  const fingerprints = new Set(decoded.map((d) => d.fingerprint));
  if (fingerprints.size > 1) {
    throw new Error('Shares belong to different keys — their fingerprints disagree');
  }

  const key = combine(decoded.map((d) => d.share));
  const actual = await fingerprint(key);
  const claimed = [...fingerprints][0]!;
  const target = expected ?? claimed;

  if (actual !== target) {
    key.fill(0);
    throw new Error(
      `Fingerprint mismatch.\n  expected ${target}\n  computed ${actual}\n\n` +
        'STOP. Do not use this key. A wrong key silently produces garbage rather\n' +
        'than failing loudly. Re-check that the shares are correct and complete.',
    );
  }

  process.stdout.write(`
  Fingerprint verified: ${actual}

  XECRET_ROOT_KEYS entry:
      "${toBase64Url(key)}"

  Paste into Phase.dev, then destroy any transcript of this output.
`);

  key.fill(0);
}

async function verify(encodedShares: readonly string[], expected?: string): Promise<void> {
  const decoded = encodedShares.map(decodeShare);
  const key = combine(decoded.map((d) => d.share));
  const actual = await fingerprint(key);
  key.fill(0);

  const target = expected ?? decoded[0]?.fingerprint;
  const ok = actual === target;

  // Prints only the fingerprint, never the key — this is the mode to use for the
  // quarterly drill, where the goal is proving the shares still work.
  process.stdout.write(`  computed fingerprint: ${actual}\n  expected fingerprint: ${target}\n`);
  process.stdout.write(ok ? '\n  ✅ Shares reconstruct the expected key.\n' : '\n  ❌ MISMATCH.\n');

  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  switch (options.mode) {
    case 'recover':
      return recover(options.shares, options.expectedFingerprint);
    case 'verify':
      return verify(options.shares, options.expectedFingerprint);
    case 'generate':
      return generate(options);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});
