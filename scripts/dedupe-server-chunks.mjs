#!/usr/bin/env node
/**
 * Collapses byte-identical server chunks to one copy before OpenNext bundles
 * them into the Worker.
 *
 * Runs straight after `next build`, as the second half of the `buildCommand`
 * in `apps/web/open-next.config.ts` — so every `opennextjs-cloudflare build`
 * gets it: CI, `npm run deploy`, `npm run preview`. Nothing else calls it.
 *
 * ── Why ──
 * Turbopack writes the server chunk every API route loads — drizzle, postgres,
 * the route wrapper, about half a megabyte — under a different file name for
 * each group of routes: the same bytes, twenty names. OpenNext gives every
 * chunk file its own `require()` in the Worker, and gzip only looks 32 KB back,
 * so each name cost its full ~165 KB of the gzipped budget. 3.1 MB of a 5.85 MB
 * Worker was that one chunk, repeated; a feature that moved two routes' imports
 * once added a twenty-first copy and failed the budget on its own.
 *
 * ── What it does ──
 * Within each chunks directory, a file whose content matches an earlier one —
 * ignoring the trailing comment naming its own source map, the only line the
 * copies differ in — becomes a one-line re-export of that earlier one. Its name
 * stays, so every route that asks for it still finds it, and the code is
 * bundled once. Behaviour does not change: the Turbopack runtime installs a
 * module only if nothing with its id is installed yet, so whichever copy loaded
 * second was already being ignored.
 *
 * Only the standalone copy is touched, because it is what OpenNext copies into
 * `.open-next`; `.next/server` stays exactly as Next wrote it. Directories are
 * kept apart (`chunks/` and `chunks/ssr/` are loaded by two different runtimes)
 * and the runtimes themselves are never rewritten — OpenNext patches them by
 * name.
 *
 * ── Why a missing directory is an error ──
 * Where OpenNext takes its server files from is an internal of OpenNext 1.x,
 * not a documented contract. If an upgrade moves it, a step that quietly found
 * nothing to do would ship the fat Worker again under a green build. So this
 * refuses to run against a layout it does not recognise, and
 * `check-duplicate-chunks.mjs` checks the finished bundle for the same thing
 * from the other end.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// `.next/standalone` mirrors the monorepo from its root, which is why the app's
// path appears twice.
const CHUNKS_DIR = join(REPO_ROOT, 'apps/web/.next/standalone/apps/web/.next/server/chunks');

/** Turbopack's chunk loader. Loaded and patched by name, so never a candidate. */
const RUNTIME = '[turbopack]_runtime.js';

/**
 * How every Turbopack server chunk starts — a CommonJS array of module
 * factories.
 *
 * The `[` is what makes a second run a no-op. A stub this script wrote starts
 * `module.exports=require(`, so it is never taken for a chunk; matching on
 * `module.exports=` alone re-pointed stubs at other stubs when the step ran
 * twice over one build.
 */
const CHUNK_PREFIX = 'module.exports=[';

/** The trailing `//# sourceMappingURL=<own name>.map`, which differs between copies. */
const SOURCE_MAP_COMMENT = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/;

if (!existsSync(CHUNKS_DIR)) {
  console.error(
    `No server chunks at ${relative(REPO_ROOT, CHUNKS_DIR)}.\n` +
      'This runs after `next build` in standalone mode, as OpenNext sets it up. If the ' +
      'directory has moved, OpenNext has changed where it copies server files from — ' +
      'update the path here rather than skipping this step.',
  );
  process.exit(1);
}

let scanned = 0;
let deduplicated = 0;
let bytesRemoved = 0;

for (const dir of directoriesUnder(CHUNKS_DIR)) {
  /** Content digest → the first file name that had it. */
  const firstWith = new Map();

  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && entry.name !== RUNTIME)
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    const path = join(dir, name);
    const source = readFileSync(path, 'utf8');
    if (!source.startsWith(CHUNK_PREFIX)) continue;
    scanned += 1;

    const digest = createHash('sha256')
      .update(source.replace(SOURCE_MAP_COMMENT, ''))
      .digest('hex');
    const first = firstWith.get(digest);
    if (first === undefined) {
      firstWith.set(digest, name);
      continue;
    }

    writeFileSync(path, `module.exports=require(${JSON.stringify(`./${first}`)});\n`);
    deduplicated += 1;
    bytesRemoved += Buffer.byteLength(source);
  }
}

console.log(
  `Deduplicated ${deduplicated} of ${scanned} server chunks ` +
    `(${(bytesRemoved / 1024).toFixed(0)} KiB of repeated code now bundled once).`,
);

/** `root` and every directory beneath it. */
function directoriesUnder(root) {
  const found = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...directoriesUnder(join(root, entry.name)));
  }
  return found;
}
