#!/usr/bin/env node

/**
 * Builds and publishes the npm distribution from what GoReleaser just built.
 *
 * Seven packages come out of one release:
 *
 *   xecret                 the wrapper everybody installs; no binary of its own
 *   xecret-darwin-arm64    ┐
 *   xecret-darwin-x64      │ one executable each, `os` and `cpu` set so npm
 *   xecret-linux-arm64     │ installs exactly one of them and skips the rest
 *   xecret-linux-x64       │
 *   xecret-win32-arm64     │
 *   xecret-win32-x64       ┘
 *
 * The binaries are the *same artefacts* the GitHub release publishes — read out
 * of `dist/artifacts.json`, never rebuilt here. A second compilation would mean
 * the npm package and the signed archive could differ while both claiming a
 * version, which is the one thing a distribution channel must not allow.
 *
 * `artifacts.json` is GoReleaser's documented output, so this does not depend on
 * the shape of its `dist/` directory names.
 *
 * Two sources, same output:
 *
 *   --archives DIR   the published release's archives, each verified against
 *                    the `checksums.txt` beside them before it is opened. This
 *                    is what the release workflow uses, and it is the stronger
 *                    guarantee: what npm serves is byte-for-byte what GitHub
 *                    serves. release.yml verifies cosign's signature over that
 *                    checksum file before this runs — see the note on
 *                    `binariesFromArchives`.
 *   --dist DIR       GoReleaser's own `dist/`, read through `artifacts.json`.
 *                    For running this by hand against a local build.
 *
 * Usage:
 *
 *   node publish.mjs --version v1.2.3 --archives /tmp/release
 *   node publish.mjs --version v1.2.3 --dry-run   # build, pack, publish nothing
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * GoReleaser's `{goos}/{goarch}` to Node's `{platform}-{arch}`.
 *
 * The reverse of `SUPPORTED` in lib/resolve.js, and resolve.test.js asserts the
 * two agree — a platform added to the build matrix and forgotten in one of them
 * is a package nobody can install, or one that installs and cannot find itself.
 */
const NODE_PLATFORM = {
  'darwin/arm64': { platform: 'darwin', arch: 'arm64' },
  'darwin/amd64': { platform: 'darwin', arch: 'x64' },
  'linux/arm64': { platform: 'linux', arch: 'arm64' },
  'linux/amd64': { platform: 'linux', arch: 'x64' },
  'windows/arm64': { platform: 'win32', arch: 'arm64' },
  'windows/amd64': { platform: 'win32', arch: 'x64' },
};

function parseArguments(argv) {
  const options = {
    version: '',
    dist: resolve(here, '..', 'dist'),
    archives: '',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--version') options.version = argv[(i += 1)] ?? '';
    else if (argument === '--dist') options.dist = resolve(argv[(i += 1)] ?? '');
    else if (argument === '--archives') options.archives = resolve(argv[(i += 1)] ?? '');
    else throw new Error(`unknown argument ${argument}`);
  }

  // In the release workflow the tag is the version, and passing it explicitly
  // keeps this runnable by hand.
  if (!options.version) options.version = process.env.GITHUB_REF_NAME ?? '';
  options.version = options.version.replace(/^v/, '');

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new Error(
      `--version must be a semantic version (got ${JSON.stringify(options.version)}). ` +
        'Pass --version v1.2.3, or run this where GITHUB_REF_NAME is the tag.',
    );
  }
  return options;
}

/** The binaries of this build, one per platform, as GoReleaser recorded them. */
function binariesFrom(distDirectory) {
  const manifest = join(distDirectory, 'artifacts.json');

  let artifacts;
  try {
    artifacts = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (cause) {
    throw new Error(`could not read ${manifest} — has GoReleaser run? (${cause.message})`);
  }

  const binaries = new Map();
  for (const artifact of artifacts) {
    if (artifact.type !== 'Binary') continue;

    const key = `${artifact.goos}/${artifact.goarch}`;
    const target = NODE_PLATFORM[key];
    // A platform the build produces and npm has no name for is skipped rather
    // than guessed at, and said out loud so it is not discovered by its absence.
    if (!target) {
      console.warn(`! ${key} has no npm platform mapping; skipping`);
      continue;
    }
    // GoReleaser paths are relative to its own working directory (cli/), which
    // is this file's parent.
    binaries.set(key, { ...target, path: resolve(here, '..', artifact.path) });
  }

  const missing = Object.keys(NODE_PLATFORM).filter((key) => !binaries.has(key));
  if (missing.length > 0) {
    // Publishing a partial set would leave `npm install xecret` resolving to a
    // wrapper whose optional dependency does not exist at that version.
    throw new Error(`GoReleaser produced no binary for: ${missing.join(', ')}`);
  }
  return [...binaries.values()];
}

/**
 * The same binaries, taken from the published release archives instead.
 *
 * This is the path the workflow uses, and it is the stronger one: the bytes
 * that reach npm are the bytes people download from GitHub and verify against
 * `checksums.txt` — not a second copy that merely came from the same build.
 * Every archive is checked against that file before it is opened, so a
 * tampered or truncated download cannot become a published package.
 *
 * What this does *not* do is authenticate `checksums.txt` itself — a hash file
 * and the archives it describes come from the same place, so anyone able to
 * rewrite one could rewrite both. cosign signs that file, and release.yml
 * verifies the signature against this repository's release identity before
 * calling this script; run by hand against a directory you assembled yourself,
 * the guarantee here is only "these archives match this list".
 */
function binariesFromArchives(directory, version) {
  const checksums = new Map();
  for (const line of readFileSync(join(directory, 'checksums.txt'), 'utf8').split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name) checksums.set(basename(name), hash.toLowerCase());
  }

  const staging = join(directory, '.extracted');
  rmSync(staging, { recursive: true, force: true });

  const binaries = [];
  for (const [key, target] of Object.entries(NODE_PLATFORM)) {
    const [goos, goarch] = key.split('/');
    // `name_template` in .goreleaser.yaml, with the zip override for Windows.
    const archive = `xecret_${version}_${goos}_${goarch}.${goos === 'windows' ? 'zip' : 'tar.gz'}`;
    const path = join(directory, archive);

    const expected = checksums.get(archive);
    if (!expected) throw new Error(`checksums.txt does not list ${archive}`);

    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== expected) {
      throw new Error(
        `${archive} does not match its checksum.\n  expected ${expected}\n  actual   ${actual}`,
      );
    }

    const into = join(staging, `${goos}_${goarch}`);
    mkdirSync(into, { recursive: true });
    if (goos === 'windows') execFileSync('unzip', ['-q', path, '-d', into], { stdio: 'inherit' });
    else execFileSync('tar', ['-xzf', path, '-C', into], { stdio: 'inherit' });

    const executable = goos === 'windows' ? 'xecret.exe' : 'xecret';
    binaries.push({ ...target, path: join(into, executable) });
    console.log(`✓ ${archive} verified`);
  }
  return binaries;
}

const SHARED = {
  homepage: 'https://xecret.playxoft.com',
  bugs: 'https://github.com/playxoft/xecret/issues',
  repository: {
    type: 'git',
    url: 'git+https://github.com/playxoft/xecret.git',
    directory: 'cli',
  },
  license: 'MIT',
  author: 'Playxoft',
  engines: { node: '>=18' },
};

function buildPlatformPackage(staging, version, binary) {
  const name = `xecret-${binary.platform}-${binary.arch}`;
  const directory = join(staging, name);
  const executable = binary.platform === 'win32' ? 'xecret.exe' : 'xecret';

  mkdirSync(join(directory, 'bin'), { recursive: true });
  copyFileSync(binary.path, join(directory, 'bin', executable));
  // npm preserves the mode of files in a tarball; a binary that arrives without
  // its execute bit is a package that installs cleanly and cannot be run.
  chmodSync(join(directory, 'bin', executable), 0o755);

  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version,
        description: `The xecret CLI binary for ${binary.platform} ${binary.arch}.`,
        ...SHARED,
        // What makes npm install exactly one of these six and skip the others.
        os: [binary.platform],
        cpu: [binary.arch],
        files: ['bin/'],
        // Yarn's PnP keeps packages zipped; an executable has to be a real file
        // on disk to be spawned.
        preferUnplugged: true,
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    join(directory, 'README.md'),
    `# ${name}\n\n` +
      'The [xecret](https://www.npmjs.com/package/xecret) CLI binary for ' +
      `${binary.platform} ${binary.arch}.\n\n` +
      'You do not install this directly — `npm install xecret` picks the one that ' +
      'matches your machine.\n',
  );

  return { name, directory };
}

function buildWrapperPackage(staging, version, platforms) {
  const directory = join(staging, 'xecret');
  const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

  mkdirSync(directory, { recursive: true });
  for (const file of ['bin/xecret.js', 'lib/resolve.js', 'README.md']) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    copyFileSync(join(here, file), join(directory, file));
  }
  chmodSync(join(directory, 'bin/xecret.js'), 0o755);

  manifest.version = version;
  // Pinned exactly, not caret-ranged: the wrapper and the binary are one
  // release, and a wrapper that accepted a newer binary would be claiming a
  // compatibility nobody has tested.
  manifest.optionalDependencies = Object.fromEntries(
    platforms.map(({ name }) => [name, version]),
  );
  // A test script in the published manifest would run `node --test` in an
  // install that has no tests.
  delete manifest.scripts;

  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { name: 'xecret', directory };
}

function publish(pkg, { version, dryRun }) {
  // A prerelease goes to `next`, so `npm install xecret` on a machine that
  // asked for nothing in particular keeps meaning the newest *stable* release.
  const tag = version.includes('-') ? 'next' : 'latest';

  const args = ['publish', '--access', 'public', '--tag', tag];
  // Provenance ties the tarball to this workflow, this commit and this
  // repository, verifiable by anyone. The same reasoning as the cosign
  // signatures on the archives: people are being asked to trust this with
  // production credentials.
  if (process.env.GITHUB_ACTIONS) args.push('--provenance');
  if (dryRun) args.push('--dry-run');

  console.log(`→ npm ${args.join(' ')}  (${pkg.name}@${version})`);
  execFileSync('npm', args, { cwd: pkg.directory, stdio: 'inherit' });
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const staging = join(here, 'dist');

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const binaries = options.archives
    ? binariesFromArchives(options.archives, options.version)
    : binariesFrom(options.dist);

  const platforms = binaries.map((binary) =>
    buildPlatformPackage(staging, options.version, binary),
  );
  const wrapper = buildWrapperPackage(staging, options.version, platforms);

  console.log(`Built ${platforms.length + 1} packages at version ${options.version}.`);

  // Platforms first: the wrapper depends on them, and a wrapper on the registry
  // whose optional dependencies do not exist yet is briefly uninstallable.
  for (const pkg of [...platforms, wrapper]) publish(pkg, options);

  console.log(options.dryRun ? 'Dry run — nothing was published.' : 'Published.');
}

main();
