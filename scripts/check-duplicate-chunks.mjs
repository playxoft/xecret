#!/usr/bin/env node
/**
 * Fails the build if the Worker bundles the same server chunk more than once.
 *
 * Turbopack can write one chunk's bytes under several file names, and OpenNext
 * bundles every name, so each extra name costs the chunk's full gzipped size.
 * Unchecked, that made 3.1 MB of a 5.85 MB Worker one chunk, twenty times. The
 * build now collapses the copies (`dedupe-server-chunks.mjs`, run by the
 * `buildCommand` in `apps/web/open-next.config.ts`), and this is the check that
 * it still does: it reads what actually went into the Worker, so it fails
 * whether the copies came back because the step stopped running, because an
 * OpenNext upgrade moved the files it rewrites, or because of something new.
 *
 * The input list is the esbuild metafile OpenNext writes next to the server
 * bundle. Files are compared by content, less the trailing comment naming each
 * one's own source map. Chunks under 8 KiB are ignored: a handful of small
 * repeats costs less than the noise of reporting them.
 *
 * Run after `opennextjs-cloudflare build`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_DIR = resolve(process.cwd(), 'apps/web');
const METAFILE = resolve(
  WEB_DIR,
  '.open-next/server-functions/default/apps/web/handler.mjs.meta.json',
);

const MIN_BYTES = 8 * 1024;
const SOURCE_MAP_COMMENT = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/;

if (!existsSync(METAFILE)) {
  console.error(
    `No bundle metafile at ${METAFILE}.\n` +
      'Run `npx opennextjs-cloudflare build` in apps/web first. If it has run, OpenNext ' +
      'now writes its metafile somewhere else — update the path here.',
  );
  process.exit(1);
}

const metafile = JSON.parse(readFileSync(METAFILE, 'utf8'));
const inputs = Object.values(metafile.outputs).flatMap((output) => Object.keys(output.inputs));
const chunks = [...new Set(inputs)].filter((input) => input.includes('/.next/server/chunks/'));

if (chunks.length === 0) {
  console.error('The metafile lists no server chunks, so there is nothing to compare.');
  process.exit(1);
}

/** Content digest → the chunks with that content, and its size. */
const byContent = new Map();
for (const chunk of chunks) {
  const source = readFileSync(resolve(WEB_DIR, chunk), 'utf8').replace(SOURCE_MAP_COMMENT, '');
  const bytes = Buffer.byteLength(source);
  if (bytes < MIN_BYTES) continue;

  const digest = createHash('sha256').update(source).digest('hex');
  const entry = byContent.get(digest) ?? { bytes, paths: [] };
  entry.paths.push(chunk.replace(/^.*\/\.next\/server\//, ''));
  byContent.set(digest, entry);
}

const repeated = [...byContent.values()].filter((entry) => entry.paths.length > 1);
const kib = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;

if (repeated.length > 0) {
  const wasted = repeated.reduce((sum, e) => sum + e.bytes * (e.paths.length - 1), 0);
  console.error(`FAIL: the Worker bundles ${kib(wasted)} of server code more than once.\n`);
  for (const { bytes, paths } of repeated.sort((a, b) => b.bytes - a.bytes)) {
    console.error(`  ${paths.length} copies of ${kib(bytes)}:`);
    for (const path of paths) console.error(`    ${path}`);
  }
  console.error(
    '\nThe build should collapse these (scripts/dedupe-server-chunks.mjs). Check that it ' +
      'still runs as the buildCommand in apps/web/open-next.config.ts, and that it still ' +
      'finds the files OpenNext bundles.',
  );
  process.exit(1);
}

console.log(`OK — no server chunk over ${kib(MIN_BYTES)} is bundled twice.`);
