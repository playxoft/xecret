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

import { KEY_LENGTH, randomBytes, toBase64Url } from '../packages/core/src/crypto/index.ts';
import {
  decodeShare,
  recoverKeyFromShares,
  splitKeyIntoShares,
} from '../packages/core/src/crypto/escrow.ts';

/**
 * The share format, the fingerprint, and the verification that makes a recovery
 * trustworthy all live in `packages/core/src/crypto/escrow.ts`, where they are
 * unit-tested. This file is the presentation layer: argument parsing and the
 * printed ceremony instructions, nothing more.
 *
 * That split is deliberate. Recovery logic buried in a CLI script is recovery
 * logic nothing imports, and therefore recovery logic nothing tests.
 */

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
  const { fingerprint: fp, shares } = await splitKeyIntoShares(
    key,
    options.totalShares,
    options.threshold,
  );

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

  for (const [position, share] of shares.entries()) {
    process.stdout.write(`  Share ${position + 1}:\n      ${share}\n\n`);
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
}

async function recover(encodedShares: readonly string[], expected?: string): Promise<void> {
  const { key, fingerprint: fp } = await recoverKeyFromShares(encodedShares, expected);

  process.stdout.write(`
  Fingerprint verified: ${fp}

  XECRET_ROOT_KEYS entry:
      "${toBase64Url(key)}"

  Paste into Phase.dev, then destroy any transcript of this output.
`);

  key.fill(0);
}

/**
 * The quarterly drill.
 *
 * Prints the fingerprint and nothing else — never the key. The point of the
 * drill is proving the shares still reconstruct, and printing key material to
 * prove it would make the drill itself the largest risk in the calendar.
 */
async function verify(encodedShares: readonly string[], expected?: string): Promise<void> {
  const target = expected ?? decodeShare(encodedShares[0] ?? '').fingerprint;

  try {
    const { key, fingerprint: fp } = await recoverKeyFromShares(encodedShares, target);
    key.fill(0);

    process.stdout.write(
      `  computed fingerprint: ${fp}\n  expected fingerprint: ${target}\n\n  ✅ Shares reconstruct the expected key.\n`,
    );
  } catch (error) {
    process.stdout.write(
      `  expected fingerprint: ${target}\n\n  ❌ ${error instanceof Error ? error.message : 'MISMATCH.'}\n`,
    );
    process.exitCode = 1;
  }
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
