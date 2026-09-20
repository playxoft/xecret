#!/usr/bin/env node
/**
 * Builds the CLI into `cli/dist`, stamped with the release it came from.
 *
 * This was one line in `package.json` and could not stay one. The version came
 * from `$(git describe …)` inside the npm script, and npm on Windows runs
 * scripts through `cmd.exe`, which has no `$(…)` — so the literal characters
 * were passed to `go build`, the linker read `describe` and `--tags` as flags of
 * its own, printed its usage, and failed.
 *
 * The failure was invisible, which is the half worth fixing. `go build` writes
 * its output only on success, so a failed build left the *previous* binary
 * sitting in `dist/`, reporting whatever commit it was cut from. Running
 * `--version` afterwards produced a plausible answer about the wrong build. The
 * output is therefore removed before the compiler runs: a build that fails now
 * leaves nothing to mistake for the thing it did not produce.
 *
 * `execFileSync` rather than `execSync` throughout — no shell is involved at
 * any point, so there is no shell left to differ between platforms.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const CLI_DIR = resolve(process.cwd(), 'cli');
const OUT_DIR = resolve(CLI_DIR, 'dist');

/** Go names Windows executables with the suffix; nothing else does. */
const OUT_NAME = process.platform === 'win32' ? 'xecret.exe' : 'xecret';
const OUT_PATH = resolve(OUT_DIR, OUT_NAME);

/**
 * The last *release* tag, not the nearest tag of any kind.
 *
 * `--match=v*` is what keeps an archived branch tag out of the version string:
 * this repository retires branches as `archive/<branch>` tags rather than
 * deleting them, and a bare `git describe --tags` happily returns one of those.
 *
 * `dev` when there is no tag to describe — a shallow CI clone, or a source
 * tarball with no history. That is a true statement about an untagged build,
 * where a hard failure would only stop somebody compiling from source.
 */
function describeVersion() {
  try {
    return execFileSync('git', ['describe', '--tags', '--dirty', '--match=v*'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
}

const version = describeVersion();
const ldflags = `-X github.com/playxoft/xecret/cli/internal/buildinfo.Version=${version}`;

// Before the compiler, so a failure cannot be read as a success.
rmSync(OUT_PATH, { force: true });
mkdirSync(OUT_DIR, { recursive: true });

console.log(`Building xecret ${version} → cli/dist/${OUT_NAME}`);

try {
  execFileSync('go', ['build', '-ldflags', ldflags, '-o', OUT_PATH, './cmd/xecret'], {
    cwd: CLI_DIR,
    stdio: 'inherit',
  });
} catch {
  // `go` has already printed why on stderr; repeating it would bury it.
  console.error('\nBuild failed. cli/dist holds no binary — nothing stale was left behind.');
  process.exit(1);
}

console.log(`Built ${OUT_PATH}`);
