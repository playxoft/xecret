#!/usr/bin/env node
/**
 * Fails the build if the Worker bundle approaches the Cloudflare limit.
 *
 * Workers Paid allows 10 MB gzipped. We budget 6 MB so there is headroom to add
 * features without a release-day emergency. Bundle size on Workers is a hard
 * wall, not a performance nicety: exceed it and deploys stop working entirely.
 *
 * The size is taken from `wrangler deploy --dry-run`, which reports exactly what
 * would be uploaded after tree-shaking. Measuring .open-next/worker.js directly
 * is meaningless — it is a ~2 KB entry shim — and measuring the whole output
 * directory wildly overstates it (22 MB on disk resolves to under 1 MB uploaded).
 *
 * Run after `opennextjs-cloudflare build`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const HARD_LIMIT_KIB = 10 * 1024; // Cloudflare Workers Paid
const BUDGET_KIB = 6 * 1024; // ours, deliberately lower

const WEB_DIR = resolve(process.cwd(), 'apps/web');

if (!existsSync(resolve(WEB_DIR, '.open-next/worker.js'))) {
  console.error(
    'No Worker bundle found.\nRun `npx opennextjs-cloudflare build` in apps/web first.',
  );
  process.exit(1);
}

let output;
try {
  output = execFileSync(
    'npx',
    ['wrangler', 'deploy', '--dry-run', '--outdir', '.wrangler/size-check', '--env', ''],
    { cwd: WEB_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  console.error('wrangler dry-run failed:\n', error.stdout ?? error.message);
  process.exit(1);
}

// e.g. "Total Upload: 4561.53 KiB / gzip: 956.62 KiB"
const match = output.match(/gzip:\s*([\d.]+)\s*KiB/);
if (!match) {
  console.error('Could not parse the bundle size from wrangler output:\n', output);
  process.exit(1);
}

const gzipKiB = Number.parseFloat(match[1]);
const mb = (kib) => `${(kib / 1024).toFixed(2)} MB`;

console.log(`Worker bundle (gzipped): ${mb(gzipKiB)}`);
console.log(
  `Budget:                  ${mb(BUDGET_KIB)}  (${((gzipKiB / BUDGET_KIB) * 100).toFixed(1)}% used)`,
);
console.log(`Cloudflare hard limit:   ${mb(HARD_LIMIT_KIB)}`);

if (gzipKiB > HARD_LIMIT_KIB) {
  console.error(
    `\nFAIL: exceeds the Cloudflare limit by ${mb(gzipKiB - HARD_LIMIT_KIB)}. This cannot deploy.`,
  );
  process.exit(1);
}

if (gzipKiB > BUDGET_KIB) {
  console.error(
    `\nFAIL: exceeds our ${mb(BUDGET_KIB)} budget by ${mb(gzipKiB - BUDGET_KIB)}.\n` +
      'Remove a dependency, or raise the budget deliberately — never raise it just to make CI pass.',
  );
  process.exit(1);
}

console.log('\nOK — within budget.');
