/**
 * Which CLI release this deployment tells its callers to run.
 *
 * ── Why the server is the one that says so ──
 * `cli/cmd/xecret/upgrade.go` states the rule this has to live inside: nothing
 * in the CLI checks in the background, because a version check is a request
 * describing which machine runs which build of a secret-management client, and
 * making it a side effect of `xecret run` would ship that telemetry out of every
 * CI job in the world.
 *
 * Advertising the answer here keeps that rule intact rather than bending it. The
 * CLI already sends this server a request for every command it runs; a header on
 * the reply reaches it with **no additional request, to anyone**. The server
 * learns nothing it was not already told, github.com learns nothing at all, and
 * a machine that never talks to a deployment is never nudged.
 *
 * It is also the better answer for a self-hoster. Their developers should run
 * the CLI *their* deployment expects, which is not necessarily the newest tag on
 * GitHub — a deployment pinned to an older server wants its callers pinned with
 * it. Whoever operates the deployment decides, by deciding what they deploy.
 *
 * ── Why a constant and not a lookup ──
 * The alternative is asking GitHub at request time and caching the answer. That
 * buys automatic freshness and costs a network dependency on the hot path of
 * every authenticated request, a cache to get wrong in a Worker with no shared
 * memory between isolates, and a third party who can make this endpoint slow.
 * A constant is read at build time from the same source of truth as everything
 * else in the bundle, and it is wrong only in the window between publishing a
 * release and deploying the web app — during which it names the older version
 * and simply says nothing. Silence is the safe failure here.
 *
 * **Bump these two when you cut a CLI release**, and deploy the web app after
 * publishing it. `cli-release.test.ts` enforces the shape; nothing can enforce
 * that you remembered, which is why `.github/workflows/release.yml` says so at
 * the step that publishes. Forgetting is not an outage — it means nobody is
 * nudged until the next deploy.
 */

/**
 * The newest CLI release this deployment knows about.
 *
 * Plain dotted numbers, no `v` prefix — the CLI compares it with
 * `compareVersions`, which reads major/minor/patch and treats a pre-release
 * suffix as older than the release it precedes.
 */
export const CLI_LATEST_VERSION = '0.2.0';

/**
 * One line on why the upgrade is worth it, shown under the version.
 *
 * The audience is somebody who did not ask: they typed `xecret secrets list` and
 * got a nudge. "A new version is available" earns nothing from that person — it
 * is the sentence every tool prints, and the reason they are all ignored. So
 * this names the thing their current build cannot do, and where possible the way
 * it fails, because "returns an empty value" is what makes somebody act today
 * rather than next month.
 *
 * Kept to one line and roughly this length: it is rendered inside a three-line
 * notice that has to stay smaller than the output it follows.
 */
export const CLI_LATEST_HEADLINE =
  'Reads end-to-end encrypted environments - older builds return an empty value for them.';

/** Names the release the server recommends. */
export const CLI_LATEST_HEADER = 'x-xecret-cli-latest';

/** Carries {@link CLI_LATEST_HEADLINE} beside it. */
export const CLI_HEADLINE_HEADER = 'x-xecret-cli-headline';

/**
 * Whether a caller is the xecret CLI, by its User-Agent.
 *
 * The two headers are added only for the CLI. Every dashboard `fetch` would
 * otherwise carry ~120 bytes it can do nothing with, on every request, for ever.
 *
 * A User-Agent is client-supplied and trivially forged, and that is fine here in
 * a way it would not be anywhere else in this codebase: the consequence of a
 * wrong answer is two header bytes sent or not sent. Nothing is authorised by
 * it, nothing is audited on it, and it is never read back.
 */
export function isCliUserAgent(userAgent: string | null): boolean {
  return userAgent !== null && userAgent.startsWith('xecret-cli/');
}
