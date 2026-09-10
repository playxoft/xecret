/**
 * Writes `src/importer/fixtures/import-fixtures.json` from the implementation.
 *
 *     npm run -w @xecret/core import-fixtures:generate
 *
 * The same arrangement as `generate-vectors.ts`, and for the same reason: all
 * the behaviour lives in `src/importer/fixtures/build.ts`, which is pure and
 * covered by the test suite, and this file is the shell that stamps the metadata
 * and puts the result on disk.
 *
 * Regeneration rewrites every expectation. A diff that touches a case unrelated
 * to the change being made means a parser's behaviour moved further than
 * intended — **read that diff**, because the other implementation of these rules
 * is in Go and will not notice until its own test fails.
 */

// Node imports: this script runs under `tsx` at development time and is never
// bundled, which is why the lint config treats `packages/*/scripts/**` as
// operator scripts rather than as shipped package source.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFixtureFile } from '../src/importer/fixtures/build';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'importer', 'fixtures', 'import-fixtures.json');

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const file = buildFixtureFile({
  generatedAt: new Date().toISOString(),
  generator: `packages/core/scripts/generate-import-fixtures.ts@${gitSha()}`,
});

writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

process.stdout.write(`Wrote ${file.cases.length} import fixtures to ${target}\n`);
