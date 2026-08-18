import { json } from '@/server/http';
import { publicRoute } from '@/server/route';
import { versionPayload } from '@/lib/version';

/**
 * The same answer as `GET /api/version`, at the path people try first.
 *
 * Every other endpoint in this application lives under `/api`, and this one
 * does too — that route is the canonical one and the reference documents it as
 * such. This exists because a version check is the one request made by somebody
 * who has been handed a hostname and nothing else: an uptime monitor, a `curl`
 * during an incident, a reader who has not opened the API reference. Answering
 * a 404 there teaches them the deployment is broken.
 *
 * A route rather than a redirect. A 308 costs a monitor a second round trip and
 * has to be explicitly followed by `curl` and by most shell scripts, which is a
 * worse trade than the four lines here. Both call `versionPayload()`, so the
 * two bodies cannot drift.
 *
 * See `lib/version.ts` for where the values come from, and the `/api/version`
 * route for why this is public and what it must never grow.
 */
export const GET = publicRoute(async () => json(versionPayload()));
