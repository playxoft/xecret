import { json } from '@/server/http';
import { publicRoute } from '@/server/route';
import { versionPayload } from '@/lib/version';

/**
 * What is deployed here, under the prefix every other endpoint uses.
 *
 * `GET /version` answers identically — see `lib/version.ts` for why there are
 * two paths and one body.
 *
 * The CLI compiles in its own version (`cli/internal/buildinfo`) and prints it
 * on `--version`; until this existed there was no way to ask the other end the
 * same question. An operator staring at a bug they had already fixed could not
 * tell whether the fix was live, and a self-hoster comparing their deployment
 * to a release had to read the bundle.
 *
 * Public, deliberately, and worth writing down because `next.config.ts` turns
 * `poweredByHeader` off with the note that a secret manager must not leak build
 * or framework detail. That rule is about *incidental* disclosure — a header
 * naming the framework to every caller, bought for nothing. This is the
 * opposite trade: the value is real (the CLI can warn before making a request
 * this server is too old to satisfy; an uptime check can watch a deploy roll
 * out) and the disclosure is close to nil, because the server is AGPL. Anyone
 * can already read the tag this names.
 *
 * What it deliberately does not carry: anything about *this deployment* rather
 * than this build. No environment name, no binding inventory, no dependency
 * versions, no database or Firebase detail. Those describe how one install is
 * configured, which is not public, and a version endpoint is exactly where such
 * things accumulate if nobody says otherwise. A test pins the key set.
 *
 * Not rate limited. Every other public route reaches a database or spends a
 * credential; this one returns four strings fixed at build time and issues no
 * query, so a bucket would cost more than the abuse it prevents. It goes
 * through `publicRoute` regardless, so it carries a request id and lands in the
 * same logs and the same error envelope as everything else.
 */
export const GET = publicRoute(async () => json(versionPayload()));
