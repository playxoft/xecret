import { securityTxt } from '@/lib/security-contact';

/**
 * `/.well-known/security.txt` — RFC 9116, for the researcher's tooling.
 *
 * A route handler in `app/.well-known/`, which Next discovers like any other
 * segment (only `_`-prefixed folders are private) and which therefore reaches
 * the Worker through OpenNext's generated handler with no rewrite and no
 * middleware (ADR 0008). Nothing under `public/.well-known` competes for the
 * path, so the asset binding never answers it first.
 *
 * Rendered per request, because `Expires` is computed from the clock: a
 * prerendered copy would carry the build's date, and a deployment left alone
 * for a year would start serving an expired file. The body changes once a day
 * (see `securityTxtExpiry`), so an hour in a cache costs nothing in accuracy.
 *
 * `/security.txt`, the legacy location the RFC still allows, is a redirect to
 * this path, declared in `next.config.ts`.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(securityTxt(new Date()), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
