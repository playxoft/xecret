import { afterEach, describe, expect, it, vi } from 'vitest';

import { versionPayload } from './route';

/**
 * `versionPayload` is four strings, so the interesting assertions are not about
 * the values but about the *set of keys*. A version endpoint is where
 * deployment detail accumulates — somebody adds the environment name to debug
 * one incident, somebody else adds the database host — and each addition looks
 * harmless on its own. Pinning the shape with `toEqual` rather than
 * `toMatchObject` means a fifth field cannot arrive without this test being
 * edited, which is the point at which the question gets asked.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the version payload', () => {
  it('carries the build stamp and nothing about this deployment', () => {
    vi.stubEnv('XECRET_BUILD_VERSION', '1.2.3');
    vi.stubEnv('XECRET_BUILD_COMMIT', 'a1b2c3d');
    vi.stubEnv('XECRET_BUILD_TIME', '2026-08-17T12:00:00Z');

    expect(versionPayload()).toEqual({
      name: 'xecret',
      version: '1.2.3',
      commit: 'a1b2c3d',
      builtAt: '2026-08-17T12:00:00Z',
    });
  });

  it('says unknown rather than dropping the key on an unstamped build', () => {
    vi.stubEnv('XECRET_BUILD_VERSION', undefined);
    vi.stubEnv('XECRET_BUILD_COMMIT', undefined);
    vi.stubEnv('XECRET_BUILD_TIME', undefined);

    const payload = versionPayload();

    expect(payload).toEqual({
      name: 'xecret',
      version: 'unknown',
      commit: 'unknown',
      builtAt: 'unknown',
    });

    // The failure this guards against is not a wrong value but an absent one:
    // `JSON.stringify({ a: undefined })` is `{}`, so a caller parsing the
    // response would see no `version` field at all and could not tell a build
    // that does not know its version from a server too old to have one.
    expect(Object.keys(JSON.parse(JSON.stringify(payload)))).toEqual([
      'name',
      'version',
      'commit',
      'builtAt',
    ]);
  });

  it('reports a dirty tree, because a commit is only honest with the tree that built it', () => {
    vi.stubEnv('XECRET_BUILD_COMMIT', 'a1b2c3d-dirty');

    // `scripts/deploy-web.sh` stamps `git describe --dirty`. Passing it through
    // unaltered is deliberate: a deployment whose source is not on any branch
    // should be able to say so.
    expect(versionPayload().commit).toBe('a1b2c3d-dirty');
  });
});
