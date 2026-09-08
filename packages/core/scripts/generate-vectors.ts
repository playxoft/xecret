/**
 * Writes `src/crypto/client/vectors/e2ee-vectors.json` from the implementation.
 *
 *     npm run -w @xecret/core vectors:generate
 *
 * All the cryptography lives in `src/crypto/client/vectors/build.ts`, which is
 * pure, browser-safe, and covered by the test suite. This file is the shell that
 * stamps the metadata and puts the result on disk — the only part that needs
 * Node, and therefore the only part that lives outside `src/`.
 *
 * Regeneration rewrites every value. A diff that touches vectors unrelated to
 * the change being made means the change was not as local as it looked: **read
 * that diff**. An unexplained change in a vector file is the earliest and
 * cheapest signal that a format changed by accident, and far cheaper to read
 * here than to diagnose as an undecryptable blob in production.
 */

// Node imports: this script runs under `tsx` at development time and is never
// bundled, which is why the lint config treats `packages/*/scripts/**` as
// operator scripts rather than as shipped package source.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildVectorFile } from '../src/crypto/client/vectors/build';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'crypto', 'client', 'vectors', 'e2ee-vectors.json');

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // A checkout without git history still produces usable vectors; it just
    // cannot say which commit produced them.
    return 'unknown';
  }
}

const file = await buildVectorFile({
  generatedAt: new Date().toISOString(),
  generator: `packages/core/scripts/generate-vectors.ts@${gitSha()}`,
});

writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
console.log(`Wrote ${file.vectors.length} vectors to ${target}`);
