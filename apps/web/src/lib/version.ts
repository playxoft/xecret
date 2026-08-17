/**
 * What is deployed here, as two endpoints answer it.
 *
 * `GET /api/version` sits with every other endpoint under `/api`. `GET /version`
 * is the same body at the path people actually try first — an uptime check, a
 * `curl` against a host somebody was handed, a reader who did not know the
 * prefix. Neither redirects to the other: a 308 is a second round trip for a
 * monitor and something a shell script has to be told to follow, which is a
 * poor trade against one shared function.
 *
 * The values arrive here already resolved. Webpack substitutes all three during
 * `next build` — `version` from `apps/web/package.json`, the other two from what
 * `scripts/deploy-web.sh` exported — because the deployed Worker's `process.env`
 * is the wrangler `vars` block and nothing else. A value not inlined at build
 * time is simply absent in production. See `next.config.ts`.
 *
 * The `?? 'unknown'` are not belt-and-braces over that. Under `next build` they
 * are dead code, but this module is also imported by a test runner that applies
 * no Next config, and reached by anything running before a build has happened.
 * Returning `undefined` would put `"version": undefined` into the body, and
 * `JSON.stringify` drops that key entirely: the field would vanish rather than
 * admit it is not known.
 */
export interface VersionPayload {
  readonly name: 'xecret';
  readonly version: string;
  readonly commit: string;
  readonly builtAt: string;
}

export function versionPayload(): VersionPayload {
  return {
    name: 'xecret',
    version: process.env.XECRET_BUILD_VERSION ?? 'unknown',
    commit: process.env.XECRET_BUILD_COMMIT ?? 'unknown',
    builtAt: process.env.XECRET_BUILD_TIME ?? 'unknown',
  };
}
