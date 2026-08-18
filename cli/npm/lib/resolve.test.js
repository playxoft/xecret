'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const { SUPPORTED, packageName, binaryName, isSupported, resolveBinary } = require('./resolve.js');

test('names the package npm installed for this platform', () => {
  assert.equal(packageName('darwin', 'arm64'), 'xecret-darwin-arm64');
  assert.equal(packageName('win32', 'x64'), 'xecret-win32-x64');
});

test('only Windows carries the extension', () => {
  assert.equal(binaryName('win32'), 'xecret.exe');
  assert.equal(binaryName('linux'), 'xecret');
  assert.equal(binaryName('darwin'), 'xecret');
});

test('covers every platform GoReleaser builds', () => {
  // The build matrix in .goreleaser.yaml is the source of truth. A platform
  // added there and forgotten here is a machine that installs xecret and is
  // told it has no build.
  const config = readFileSync(join(__dirname, '..', '..', '.goreleaser.yaml'), 'utf8');
  const goos = /goos:\s*\[([^\]]+)\]/.exec(config)?.[1] ?? '';
  const goarch = /goarch:\s*\[([^\]]+)\]/.exec(config)?.[1] ?? '';

  const expected = [];
  for (const os of goos.split(',').map((value) => value.trim())) {
    for (const arch of goarch.split(',').map((value) => value.trim())) {
      expected.push(`${os}/${arch}`);
    }
  }

  assert.ok(expected.length > 0, 'could not read the build matrix from .goreleaser.yaml');
  assert.deepEqual(new Set(Object.values(SUPPORTED)), new Set(expected));
});

test('the publish script maps every platform this resolves', () => {
  // The two directions of the same table, in two files that are read by
  // different runtimes at different times. They have to agree.
  const script = readFileSync(join(__dirname, '..', 'publish.mjs'), 'utf8');

  for (const [nodeTarget, goTarget] of Object.entries(SUPPORTED)) {
    const [platform, arch] = nodeTarget.split('-');
    const entry = new RegExp(
      `'${goTarget}':\\s*\\{\\s*platform:\\s*'${platform}',\\s*arch:\\s*'${arch}'`,
    );
    assert.match(script, entry, `publish.mjs does not map ${goTarget} to ${nodeTarget}`);
  }
});

test('an unsupported platform is refused by name', () => {
  assert.equal(isSupported('sunos', 'x64'), false);
  assert.throws(() => resolveBinary('sunos', 'x64'), /no build for sunos-x64/);
});

test('a missing platform package explains itself without blaming a script', () => {
  // There is no postinstall, so `--ignore-scripts` is never the cause and the
  // message must not send anyone looking for one.
  assert.throws(
    () => resolveBinary('linux', 'arm64'),
    (error) => {
      assert.match(error.message, /xecret-linux-arm64/);
      assert.match(error.message, /--omit=optional|--no-optional/);
      assert.doesNotMatch(error.message, /ignore-scripts/);
      return true;
    },
  );
});
