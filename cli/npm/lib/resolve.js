'use strict';

/**
 * Finding the binary that belongs to this machine.
 *
 * The npm distribution is seven packages: this wrapper, and one per platform
 * holding nothing but the executable. npm installs exactly one of them, chosen
 * by the `os` and `cpu` fields in their manifests, and this module resolves it.
 *
 * ── Why not a postinstall script that downloads the binary? ──
 * That is the more common pattern and it is the wrong one here, for three
 * reasons that all point the same way:
 *
 *   1. `npm ci --ignore-scripts` is a standard hardening in CI, and it is the
 *      *right* thing to run — postinstall scripts are the supply-chain hole
 *      everyone is closing. A secret manager whose installer silently produces
 *      a broken command under that flag would be teaching people to turn the
 *      protection off. There is no postinstall here to disable.
 *   2. A downloaded binary is outside npm's integrity checking. Shipping it
 *      *as* a package puts it under the `integrity` hash in everybody's
 *      lockfile, verified on every install, with no bespoke checksum code of
 *      ours to get wrong.
 *   3. Installs stay offline-able: a private registry mirror or an air-gapped
 *      build has everything it needs, with no reach out to GitHub mid-install.
 *
 * The cost is six extra published packages per release, which a script does.
 */

/**
 * The platforms GoReleaser builds, keyed the way Node names them.
 *
 * Values are `{goos}/{goarch}` — the same pair `cli/.goreleaser.yaml` lists —
 * so the two files can be read against each other. `publish.mjs` maps in this
 * direction when it builds the packages; this map is the reverse, and the test
 * beside it asserts they agree.
 */
const SUPPORTED = {
  'darwin-arm64': 'darwin/arm64',
  'darwin-x64': 'darwin/amd64',
  'linux-arm64': 'linux/arm64',
  'linux-x64': 'linux/amd64',
  'win32-arm64': 'windows/arm64',
  'win32-x64': 'windows/amd64',
};

/** The package holding the binary for one platform. */
function packageName(platform = process.platform, arch = process.arch) {
  return `@playxoft/xecret-${platform}-${arch}`;
}

/** Windows wants the extension; nothing else does. */
function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'xecret.exe' : 'xecret';
}

function isSupported(platform = process.platform, arch = process.arch) {
  return Object.hasOwn(SUPPORTED, `${platform}-${arch}`);
}

/**
 * The absolute path of the executable, or an Error explaining what to do.
 *
 * `require.resolve` rather than a hand-built path into `node_modules`: it
 * follows whatever layout the package manager produced — hoisted, nested, a
 * workspace, a pnpm store — instead of assuming npm's.
 */
function resolveBinary(platform = process.platform, arch = process.arch) {
  if (!isSupported(platform, arch)) {
    throw new Error(
      `xecret has no build for ${platform}-${arch}.\n` +
        `Supported: ${Object.keys(SUPPORTED).join(', ')}.\n` +
        'If your platform should be on that list, please open an issue.',
    );
  }

  const dependency = packageName(platform, arch);
  try {
    return require.resolve(`${dependency}/bin/${binaryName(platform)}`);
  } catch {
    throw new Error(
      `xecret is installed, but ${dependency} — the package holding the binary for this\n` +
        'machine — is not. It is an optional dependency, so this usually means the install\n' +
        'ran with --omit=optional or --no-optional.\n\n' +
        '  Reinstall without that flag:  npm install xecret\n' +
        '  Or install the binary directly, with no Node in the way:\n' +
        '    brew install playxoft/tap/xecret\n' +
        '    curl -fsSL https://xecret.playxoft.com/install.sh | sh',
    );
  }
}

module.exports = { SUPPORTED, packageName, binaryName, isSupported, resolveBinary };
