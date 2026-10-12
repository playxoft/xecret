/**
 * Writes `src/vault-archive/vectors/vault-archive-vectors.json` from the
 * implementation.
 *
 *     npm run -w @xecret/core archive-vectors:generate
 *
 * The same shape as `generate-vectors.ts`: everything with cryptography or a
 * ZIP in it lives in `src/vault-archive/vectors/build.ts`, which is pure and
 * covered by the test suite. This shell stamps the metadata and writes the file.
 *
 * Regeneration rewrites every value. A diff in this file that the change being
 * made does not explain means the format moved: read it before committing it.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArchiveVectorFile } from '../src/vault-archive/vectors/build';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'vault-archive', 'vectors', 'vault-archive-vectors.json');

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const file = await buildArchiveVectorFile({
  generatedAt: new Date().toISOString(),
  generator: `packages/core/scripts/generate-archive-vectors.ts@${gitSha()}`,
});

writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
console.log(`Wrote ${file.vectors.length} archive vectors to ${target}`);
