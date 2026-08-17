import { json } from '@/server/http';
import { publicRoute } from '@/server/route';

/**
 * What is deployed here.
 *
 * The CLI compiles in its own version (`cli/internal/buildinfo`) and prints it
 * on `--version`; until now there was no way to ask the other end the same
 * question. An operator staring at a bug they already fixed had no way to tell
 * whether the fix was live, and a self-hoster comparing their deployment to a
 * release had to read the bundle.
 *
 * Public, deliberately, and the reasoning is worth writing down because
 * `next.config.ts` two directories up turns `poweredByHeader` off with the note
 * that a secret manager must not leak build or framework detail. That rule is
 * about *incidental* disclosure — a header that names the framework to every
 * caller, bought for nothing. This is the opposite trade: the value is real
 * (the CLI can warn before it makes a request this server is too old to
 * satisfy, an uptime check can watch a deploy roll out) and the disclosure is
 * close to nil, because the server is AGPL. Anyone can already read the tag
 * this names. Withholding it would hide the version from operators and from
 * nobody else.
 *
 * What it deliberately does not carry: anything about *this deployment* rather
 * than this build. No environment name, no binding inventory, no dependency
 * versions, no database or Firebase project. Those describe how one install is
 * configured, which is not public, and a version endpoint is exactly the place
 * such things accumulate if nobody says otherwise.
 *
 * `commit` and `builtAt` read `unknown` on any build that was not stamped —
 * a local `next build`, CI's bundle-size job. That is honest rather than
 * decorative: a deployment reporting `unknown` did not come from
 * `scripts/deploy-web.sh`, which is worth knowing on its own.
 *
 * Not rate limited. Every other public route reaches a database or spends a
 * credential; this one returns four strings fixed at build time and issues no
 * query, so a bucket would cost more than the abuse it prevents. It goes
 * through `publicRoute` regardless, so it carries a request id and lands in the
 * same logs and the same error envelope as everything else.
 */
export interface VersionPayload {
  readonly name: 'xecret';
  readonly version: string;
  readonly commit: string;
  readonly builtAt: string;
}

/**
 * Separated from the handler so the shape can be asserted without standing up
 * a request.
 *
 * The `?? 'unknown'` are not belt-and-braces over `next.config.ts`. Webpack
 * substitutes these three at build time, so under `next build` the fallback is
 * dead code — but this module is also imported by a test runner that applies no
 * Next config at all, and by anything that reaches the route before a build has
 * happened. Returning `undefined` there would put `"version": undefined` in a
 * response body, which `JSON.stringify` drops silently: the key would vanish
 * rather than say it does not know.
 */
export function versionPayload(): VersionPayload {
  return {
    name: 'xecret',
    version: process.env.XECRET_BUILD_VERSION ?? 'unknown',
    commit: process.env.XECRET_BUILD_COMMIT ?? 'unknown',
    builtAt: process.env.XECRET_BUILD_TIME ?? 'unknown',
  };
}

export const GET = publicRoute(async () => json(versionPayload()));
