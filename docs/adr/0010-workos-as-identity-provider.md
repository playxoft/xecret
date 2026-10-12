# 0010 — WorkOS AuthKit as identity provider; xecret still issues its own sessions

**Status:** Accepted
**Date:** 2026-10-12
**Supersedes:** [0003](0003-firebase-as-identity-provider.md)
**Amends:** [0009](0009-zero-knowledge-encryption.md), trade-off 6 — the vault reset's
re-authentication, which 0009 placed on a fresh Firebase ID token, becomes the two locks below

## Context

[ADR 0003](0003-firebase-as-identity-provider.md) chose Firebase Authentication for identity
and kept sessions our own. It named two reasons to revisit:

> Self-hosting friction shows up repeatedly in issues, or an enterprise customer requires
> SAML/OIDC — at which point a second `IdentityProvider` implementation is the answer, not a
> rewrite.

The second has arrived. Enterprise customers buy a secrets manager through their identity
provider: SAML or OIDC single sign-on, one connection per organisation, set up by the
customer's own IT admin, with people routed to their company's connection by email domain.
Firebase as we used it gives us none of that, and building it beside Firebase would mean
running a second identity system for the customers who matter most.

Firebase had also become expensive in ways 0003 did not foresee:

- A 544-line client module and about forty `@firebase/*` packages in the browser bundle — at
  one point 310 KB of it on the public landing page.
- A Content Security Policy that had to allow Google's script loader, two reCAPTCHA paths and
  the project's own Firebase domain, because the sign-in popup and the email/password flows
  load them. `script-src` could not be `'self'`.
- `NEXT_PUBLIC_FIREBASE_CONFIG` inlined at build time, so the *build* needed identity-provider
  configuration, and the deploy script had to cross-check it against the Worker's
  `FIREBASE_PROJECT_ID` to stop a deployment verifying tokens from the wrong project.
- A KV namespace (`JWKS_CACHE`) for Google's signing keys, so verification did not spend an
  outgoing connection.

What 0003 got right is not in question, and this ADR keeps it: the provider is consulted once,
at sign-in; every credential after that is xecret's own, stored as a hash, listable and
revocable instantly; and nothing that cannot run on Workers enters the bundle.

Three constraints shape the choice:

1. **No middleware, ever** ([ADR 0008](0008-no-middleware.md)). Next 16 forces Proxy onto the
   Node runtime and `@opennextjs/cloudflare` refuses to build it.
2. **workerd.** Server code is fetch and Web Crypto only.
3. **Six outgoing connections per invocation.** The sign-in path should make as few calls out
   as possible.

## Options considered

### A. Stay on Firebase; add enterprise SSO beside it
- ✅ No migration for existing users.
- ❌ Organisation-scoped connections, an IdP setup flow for a customer's IT admin, and routing
  by email domain would be ours to build and operate.
- ❌ Keeps every cost listed above.

### B. WorkOS through `@workos-inc/authkit-nextjs`
- ✅ WorkOS's documented path for Next.js; least code to write.
- ❌ Built around `authkitMiddleware`. ADR 0008 rules that out, and the build would fail rather
  than merely disagree with a document.
- ❌ Brings its own sealed session cookie: either a second session system beside ours, or ours
  replaced by one we cannot list or revoke from our own database. 0003's argument against
  provider-owned sessions applies unchanged.

### C. WorkOS sessions as the API credential
- ✅ No session table of our own.
- ❌ Revocation becomes a call to WorkOS, or a wait for an access token to expire. The device
  list, "sign out everywhere", CLI tokens and service tokens all hang off the session model
  0003 built; this option rebuilds them around a credential we do not hold.

### D. Hosted AuthKit, reached with `@workos-inc/node`; the code exchanged once; our own sessions
- ✅ Password, Google, MFA, email verification, password reset and enterprise SSO all happen
  on AuthKit's hosted pages. There is no auth UI of ours to maintain.
- ✅ No client SDK at all: the browser only *navigates* to AuthKit. Nothing about the identity
  provider is in the bundle, the build, or the CSP.
- ✅ The identity arrives through one authenticated server-to-server call. There is no token
  to decode, so there is no signature, audience or issuer check to get wrong.
- ✅ Sessions, CSRF, rate limiting, the CLI flow and service tokens are untouched.
- ❌ We own the redirect flow: state, PKCE, redirect validation and the callback's order of
  operations. Well understood, and written down below.

WorkOS rather than another hosted provider because enterprise SSO is its core product —
organisations, connections, an Admin Portal the customer's IT admin configures themselves, and
AuthKit routing a person to the right connection by email domain — while AuthKit's
consumer-side sign-in is free up to one million monthly active users.

## Decision

**Option D.**

```
Browser ──GET /api/auth/login?next=…──────────────────────────────▶ Worker
Worker  ──Set-Cookie: __Host-xecret_oauth_state  (signed; 10 min)
        ──307 → AuthKit  (state, PKCE S256 challenge, redirect_uri = <origin>/api/auth/callback)
Browser ──AuthKit hosted pages: password · Google · MFA · SSO ─────▶ WorkOS
Browser ──GET /api/auth/callback?code=…&state=… ───────────────────▶ Worker
Worker  ──rate limit (IP)
        ──verify the state cookie: MAC, age, state match in constant time; always clear it
        ──authenticateWithCode(code, code_verifier)    — one authenticated call to WorkOS
        ──refuse: impersonation · unverified email · SSO outside the org's verified domains
        ──rate limit (IP + identity)
        ──link or create the user, enforce sso_required, JIT-join, provision a personal org
        ──one transaction: insert sessions row (SHA-256 of a 256-bit opaque token — never the
          token) and, for a reauth sign-in that counts, its reauthentications row
        ──revoke this browser's previous session of the same account, last
        ──Set-Cookie: __Host-xecret_session; __Host-xecret_csrf
        ──303 → next, re-validated   (WorkOS's access and refresh tokens are discarded, unread)
Browser ──every later request uses OUR session, never a WorkOS token
```

`apps/web/src/server/workos.ts` is the boundary, `apps/web/src/server/sign-in.ts` the
callback's decisions in order, and `apps/web/src/server/reauth-service.ts` the vault reset's
re-authentication. Each opens with the argument; this ADR records the decisions.

### WorkOS is asked only at the boundary

Every fact about a person comes back from an authenticated API call this server makes with its
own secret key:

- `authenticateWithCode` — once per sign-in, with the flow's PKCE verifier.
- `getOrganization` — on an SSO sign-in only, to read the organisation's verified domains. An
  SSO sign-in therefore makes two calls; every other sign-in makes one.
- `createMagicAuth` and `authenticateWithMagicAuth` — on the vault-reset path only.
- `challengeFactor` on the account's TOTP factor, then `authenticateWithTotp` — on the
  vault-reset path only, when WorkOS answers the emailed code with `mfa_challenge` because the
  account has an authenticator app enrolled.

`GET /api/auth/login` makes no call: the AuthKit URL is built locally.

The session model is exactly 0003's: a 256-bit opaque token in `__Host-xecret_session`, only
its SHA-256 stored, a `__Host-xecret_csrf` double-submit pair on cookie-authenticated
mutations, and real revocation. Existing sessions survive the cutover, because they were never
Firebase's.

### Why `@workos-inc/node`, and why the other package is banned

`@workos-inc/authkit-nextjs` is middleware plus a sealed session — both of which this
deployment has decided against, one of them because it cannot build. What xecret needs from
WorkOS is the handful of HTTP calls listed above, and `@workos-inc/node` makes them: it is fetch-based, resolves to its
workerd build under OpenNext, and has no dependencies of its own. Both `eslint.config.mjs`
files ban `@workos-inc/authkit-nextjs`, beside `firebase`, `firebase-admin` and
`firebase-auth-cloudflare-workers`, so none of them arrives as a convenience later.

### The state cookie, and PKCE on a confidential client

The callback is a top-level navigation back from WorkOS's domain, so the double-submit CSRF
check cannot apply to it — there is no page of ours that could have read the token. What stops
login CSRF (an attacker completing *their* sign-in in *your* browser, so that whatever you
store lands in their account) is the OAuth `state`, bound to the browser that started the
flow. The binding is `__Host-xecret_oauth_state` (`packages/core/src/auth/oauth-state.ts`):

- **Contents.** A fresh 256-bit `state`, a 256-bit PKCE verifier, the `next` path, the
  purpose (`sign-in` or `reauth`) and the time it was issued.
- **Signed, not encrypted.** `v1.<payload>.<mac>`, HMAC-SHA-256. Nothing in it is secret from
  the browser that holds it, but nothing in it may be changed either — a rewritten `next`, a
  purpose promoted to `reauth`. Signing also means there is no table of pending sign-ins.
- **The key** is derived with HKDF-SHA-256 from `WORKOS_COOKIE_PASSWORD` under a label naming
  this one use, so the same operator secret could back a second cookie later without the two
  vouching for each other. The secret must be at least 32 characters, and independent of the
  API key: two credentials that are one value are one credential.
- **Attributes.** `HttpOnly; Secure; SameSite=Lax; Max-Age=600`. `Lax`, not `Strict`, because
  `Strict` would strip it from the cross-site return; ten minutes because that is the lifetime
  of the code it travels with.
- **Checked in this order.** The MAC before anything in the cookie is parsed, then its age,
  then `state` against the query string in constant time. Every failure tells the person only
  that the attempt expired. The cookie is cleared on every callback response, so a state is
  used at most once per browser.
- **`next` is validated three times.** At the login route, before it is written, with the
  same `safeRedirectPath` the dashboard uses — which re-checks its own normalised output, so a
  value that only becomes `//host` or carries a `\` after normalising is refused rather than
  passed. The state cookie itself refuses a `next` that starts with `//`. And the callback runs
  `safeRedirectPath` again on what the cookie says before it redirects. The signature already
  means only this server can write `next`; the repetition is there because one bug in one
  check would otherwise be an open redirect on the sign-in path, which is where a phishing link
  most wants one.

PKCE is used although this is a confidential client, as OAuth 2.1 recommends. The verifier
lives only in the HttpOnly cookie, so a code lifted from a history entry, a referrer or a proxy
log cannot be exchanged by anybody who does not also hold that cookie.

The redirect URI is derived — `XECRET_PUBLIC_URL` + `/api/auth/callback` — never configured
separately, so the two cannot drift.

### Linking a WorkOS identity to an account

Before the linker runs, the callback refuses three things outright: an **impersonated**
sign-in (a WorkOS administrator acting as a user is not that user, and nothing downstream can
tell them apart); an **unverified address** (403); and an **SSO sign-in for an address outside
the organisation's verified domains** (below). Then `upsertUserFromWorkosIdentity`, in order:

1. **`workos_user_id` matches** → sign in. Soft-deleted rows are read too, so that a deleted
   account is refused as deleted rather than skipped and created around.
2. **Else the row holding the verified address** (citext, deleted rows included). A deleted
   holder is refused; a holder already linked to a different identity is a conflict. Adoption
   happens only when the two addresses are the same under ASCII-only case folding — never
   through a Unicode fold — and it backfills `workos_user_id` and is audited
   `auth.identity_linked`. This is the step that carries every Firebase-era account across.
3. **Else create** the user (and a personal organisation), audited `auth.signup`. A concurrent
   create of the same identity is a sign-in, not a second signup.

An ordinary sign-in is audited `auth.login`. `auth.identity_linked` is written at the moment
the link is, **even if that sign-in is then refused** — by `sso_required`, or for want of a
seat — because the link outlives the refusal and its record must not depend on what follows;
an adopted sign-in that does complete records `auth.login` as well. Every one of these events
carries the sign-in method (`password`, `oauth`, `sso`, `magic_auth`, `passkey`, `other`). The
linker's refusals become a 403 "verify your email", a 403 "this account was deleted", and a 409
that names neither the other account nor how it signs in. It runs at READ COMMITTED with no
wrapping transaction, because its lost-race handling re-reads to see the winner's committed row. It accepts only an identity
`workosIdentity()` minted from the API response — checked at runtime against a private set,
so a parsed body, a spread or a cast is refused even where the compiler let it through.

**Email verification is an invariant of the WorkOS environments, not of this code.** Step 2
adopts an account on the strength of a verified address. AuthKit verifies email addresses
unconditionally — there is no dashboard switch at the time of writing — and that has to stay
true in both WorkOS environments. Note also that `user.emailVerified` describes the WorkOS
*user*, not this particular sign-in.

### SSO is believed only for the domains an organisation verified

An enterprise identity provider can assert any address, including one at somebody else's
company. So a sign-in whose `authenticationMethod` is `SSO` must name a WorkOS organisation,
and its address's domain must be one that organisation has verified with WorkOS; otherwise it
is refused. The check runs **before** the linker, so it covers an already-linked identity as
well as adoption and creation.

`sso_required` enforcement and just-in-time membership both key on `authenticationMethod ===
'SSO'` **and** the organisation id together. AuthKit reports an organisation after organisation
*selection* in password and Google sign-ins too, so the id alone does not mean that
organisation's identity provider vouched for anybody.

- **`sso_required`.** Every organisation the account belongs to that requires SSO must be the
  one whose SSO this was. An account in two such organisations is refused — the strict reading,
  because a session is not scoped to an organisation and would carry the other's access
  without its identity provider's say-so.
- **Just-in-time membership.** An SSO sign-in through an organisation's connection makes a
  newcomer a member at `viewer`, under the seat limit, decided under the organisation's row
  lock the way an invitation acceptance is. Audited `member.jit_joined`, or
  `member.jit_denied` when there is no seat — in which case the sign-in fails. It never
  reinstates a suspended membership.

The login route's `?org=<slug>` deep link starts an organisation's SSO directly. The redirect
has to carry the WorkOS organisation id, so it reveals which slugs have SSO; the lookup is
therefore rate limited per address (`RL_LOGIN`), and over the limit the parameter is silently
ignored and the ordinary screen opens — a refusal would be an oracle of its own. It is ignored
altogether on a `reauth=1` sign-in, which is about this account, not an organisation.

### Every refusal is a page, not a JSON body

The callback is a page load, so it answers every refusal with a 303 to
`/sign-in?error=<code>`, which renders a fixed sentence for that code and nothing for a code it
does not know. The callback's request log line reads the same whatever happened — "Completed a
sign-in callback" — with the outcome and the status it stands for (403, 409, 429, 503) bound as
fields, so the message never claims a success the fields contradict, or the reverse. The
sentences keep the anti-enumeration discipline the old forms kept.

`GET /api/auth/login` follows the same rule: a deployment missing its WorkOS configuration
redirects to `/sign-in?error=unavailable` rather than answering a JSON 503 on a blank tab.

### Re-authentication for the vault reset: two locks

The vault reset destroys a vault for good and must stay reachable from a locked session, so the
vault lock cannot stand in front of it. [ADR 0009](0009-zero-knowledge-encryption.md) (trade-off
6) put a fresh Firebase ID token there; **this ADR amends that trade-off.** With no
browser-held token in the new flow, that mechanism goes; the requirement stays, and a second
check is added. **Both** of the following, **in this order**:

1. **A sign-in again.** `GET /api/auth/login?reauth=1` sends AuthKit `max_age=0`. The callback
   records a row in `reauthentications` against the **new** session it issues — in the same
   transaction that inserts the session — and only for a method on an explicit allowlist of
   named constants: `Password`, `Passkey`, `GoogleOAuth` and `SSO`. Anything else — another
   OAuth provider, `MagicAuth`, a method WorkOS adds later or one it does not name — does not
   count, and adding one is a deliberate edit. A sign-in completed with an emailed code is
   excluded on purpose, or the two locks would be one inbox twice.

   **What lock one proves depends on the method, and it is less than "a fresh credential".**
   WorkOS documents `max_age` only for AuthKit's own sign-in (`provider=authkit`): it can make
   AuthKit ask for a password or a passkey again. It does not make Google or an enterprise
   identity provider ask for anything — if the browser still holds a session there, the person
   is signed straight back in without seeing a prompt. For a Google or SSO account, lock one
   therefore proves a live session at Google or the identity provider *in this browser*, not
   knowledge of a credential, and it can pass silently.
2. **An emailed one-time code** (WorkOS Magic Auth). `POST /api/auth/reauth/start` has WorkOS
   email it — only within ten minutes of lock one, and only from the session lock one issued.
   WorkOS delivers the code; xecret drops its copy unread. `POST /api/auth/reauth/verify` checks
   it, and it counts only if it proved control of the WorkOS user this account is linked to and
   nobody was impersonating them. A good one mints a one-time, five-minute **reauth proof**,
   stored as its SHA-256 and bound to the session and the user.

   **The guess budget.** Every guess — the emailed code and the authenticator step below alike
   — is reserved atomically *before* WorkOS is called, so it is spent whether or not the client
   waits for the answer: at most **five per attempt**, and at most **ten per account in any
   rolling 24 hours** across all its attempts, the second counted under the user's row lock so
   that concurrent guesses cannot overrun it. A guess is accepted only on an attempt whose code
   was actually requested (`code_sent_at` set), and a WorkOS error xecret cannot classify costs
   a guess like a wrong code does. The budget lives in `reauthentications`, not in the rate
   limiter, so it holds where the limiter is absent and fails open.

   **When the account has an authenticator app.** If the WorkOS user has a TOTP factor
   enrolled, WorkOS answers a correct emailed code with an `mfa_challenge` error instead of a
   user. `POST /api/auth/reauth/verify` then answers `{ mfaRequired: true, mfaToken }`, keeping
   only the SHA-256 of WorkOS's pending-authentication token and the factor id on the attempt.
   The client posts `{ totp, mfaToken }` to the same endpoint; the token must match this
   attempt's stored hash, the server challenges the TOTP factor and authenticates with the code,
   and only that success mints the proof. The other authentication errors WorkOS can raise on
   Magic Auth are refused with a specific 403 each — organisation selection required, email
   verification required, SSO required, MFA enrolment required, a Radar challenge — and Magic
   Auth disabled is a 503. **The TOTP branch is unit-tested against WorkOS's documented error
   shape only**: MFA is not enabled in the Staging WorkOS environment, so it has not been
   exercised against WorkOS yet, and that live check is pending.

`POST /api/auth/vault/reset` takes `{ confirm, reauthProof }` and spends the proof in one atomic
UPDATE before anything is destroyed; every failure is the same 403.

The reset screen sends the browser away for lock one and gets it back on a new session. On that
return it shows its warning — what a reset destroys and what it does not — again, rather than
resuming at the next step, and it refuses to continue if the account that came back is not the
one that left.

**Lock two needs Magic Auth enabled in both WorkOS environments.** While it is disabled as a
sign-in method, WorkOS refuses to create a code at all (`400 authentication_method_not_allowed`),
and the code email is WorkOS's own, so its default Magic Auth email has to stay on too. Enabling
it also puts "email me a code" on AuthKit's hosted sign-in page. That is why lock one excludes
it: a sign-in by emailed code is a sign-in, but never the first lock.

Why both: the code alone reduces the most destructive button in the product to the strength of
somebody's inbox, which is routinely the weakest credential they own; the sign-in alone leaves a
stolen live session — with AuthKit's, Google's or the identity provider's session beside it —
one click from the same outcome. Together they stop a stolen session cookie used from another
browser, which holds none of the victim's sessions elsewhere and cannot read their mail. For an
account that signs in with a password or a passkey, they also stop somebody at an unlocked
laptop who does not know the password — if AuthKit honours `max_age=0`, which the server cannot
see (below). They do **not** stop somebody at an unlocked laptop whose victim signs in with
Google or SSO.

**Residual risks, accepted and recorded:**

- **For a Google or SSO account, lock one is a live session, not a fresh credential.**
  Somebody at an unlocked laptop whose browser holds the victim's Google session and has their
  Gmail open in another tab passes both locks without knowing anything: lock one signs in
  silently through Google, and the code arrives in the open inbox. The same holds for an
  enterprise identity provider whose session is live and whose mail is reachable.
- **Lock one is only as strong as the account's credential recovery.** Somebody in full control
  of the victim's inbox alone can use AuthKit's "Forgot password" to set a new password, sign in
  with it — which counts, because it is a password — and then receive the emailed code. For that
  attacker both locks are inbox-strength.
- **`max_age=0` is a parameter in a URL the browser follows**, and the server cannot see whether
  AuthKit honoured it. Somebody at an unlocked laptop who strips it, **and** whose browser holds
  the victim's AuthKit session, **and** who can read the victim's inbox passes both locks. It is
  recorded so that nobody mistakes `max_age=0` for a control the server enforces.
- **What a reset hands such an attacker is not only destruction.** After resetting, they set up
  a new vault on the victim's account, which unlocks the session they hold. Through it they can
  **read** every server-mode (not end-to-end encrypted) environment the account can read. And
  the reset re-queues a key share for every end-to-end-encrypted environment the account may
  still read, so the victim's teammates are prompted to re-share: a teammate who approves seals
  that environment's keys to the attacker's new vault.

WorkOS MFA is the mitigation available today. With an authenticator app enrolled, lock two
also needs the TOTP code, which an inbox — or an open Gmail tab — does not supply; it is
recommended for organisation owners, whose vaults and teammates matter most. That this closes
the paths above rests on the TOTP branch, whose live check against WorkOS is still pending. A
delayed, cancellable reset — one that waits, tells the account, and can be called off in that
window — is under consideration with the product owner; nothing of the kind is built.

### Logout, and the AuthKit session it leaves behind

`DELETE /api/auth/session` is unchanged: CSRF-checked, revokes the row, clears both cookies.
It does not end the session AuthKit keeps on WorkOS's own domain, so a returning person may
pass AuthKit without entering a credential. Accepted for v1 — most OAuth applications behave
the same way — and the reason the vault reset sends `max_age=0`, with the limits recorded above:
it is honoured, if at all, by AuthKit, and it does not reach a Google or identity-provider
session.

A sign-in in a browser that already holds a live session *of the same account* revokes that
session once the new one is issued — last, after the new session and any reauthentication
record have committed: nothing can present the old one any more, so all it could still do is be
stolen, and it would sit in the device list looking like a second browser.

### The `IdentityProvider` seam

`verifyToken(idToken)` became `exchangeCode(code, context)`, returning the identity and the
three facts about *this* sign-in that the identity cannot carry: the organisation, the
authentication method, and the impersonator if any (`packages/core/src/auth/types.ts`).
`authTime` is the moment of the exchange — a code is minted by an authentication that has just
happened, and can be exchanged once — and it is required, so an alternative provider has to
answer the question rather than omit it.

### Configuration

| Variable | Kind | Where |
|---|---|---|
| `WORKOS_CLIENT_ID` | Plain var, per environment | `wrangler.toml`: local development and `env.staging` name the WorkOS **Staging** environment, `env.production` the **Production** one. `scripts/deploy-web.sh` refuses to build an environment that does not declare a `client_…` value. |
| `WORKOS_API_KEY` | Secret | Phase.dev → Worker secret. It must come from the same WorkOS environment as the client id. Its prefix is not a reliable guide to which environment that is — WorkOS issues keys in more than one format — so nothing infers the environment from it. |
| `WORKOS_COOKIE_PASSWORD` | Secret | Phase.dev → Worker secret. At least 32 random characters; independent of the API key. |

Without any of the three, nobody can sign in, and both sign-in routes say so — each redirects
to `/sign-in?error=unavailable` — rather than guess.

The pairing of key and client id is checked by asking WorkOS, not by reading a prefix.
`npm run check:env`, when the WorkOS values are set, makes one network call: it presents WorkOS's
authenticate endpoint with a deliberately bogus authorization code, the client id and the API
key. `invalid_grant` means WorkOS accepted the client and the key together and refused only the
code — they belong together; `invalid_client` or a 401 means they do not. `--offline` skips the
call. `npm run check:deploy` compares the `WORKOS_CLIENT_ID` Phase.dev holds with the one
`wrangler.toml` declares for the environment being deployed.

**Gone:** the `JWKS_CACHE` KV namespace, `FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_CONFIG`
and the deploy script's cross-check between the two. The client bundle carries no
identity-provider configuration, so the build needs none. The CSP is strictly smaller: no
Google script loader, no reCAPTCHA, no Firebase domain, no Google identity endpoints — and
nothing added for WorkOS, because the browser only navigates there.

### Not in this change

- **The organisation SSO settings** (WS-5): enabling SSO (creating the WorkOS organisation), the
  Admin Portal link for the customer's IT admin, connection status, and the `sso_required`
  setter with an owner exemption for a misconfigured identity provider. The callback already
  enforces `sso_required`; nothing can set it yet, which is the safe order.
- **Importing Firebase users into WorkOS**, and the backfill of `workos_user_id` that follows.
  Two rules are fixed now: an unverified Firebase user is imported without a password hash or
  not at all (otherwise whoever registered an address they do not own keeps a known password);
  and the backfill writes only `WHERE workos_user_id IS NULL`, reporting rather than forcing a
  unique (`23505`) or format (`23514`) refusal. Until then, step 2 of the linker carries each
  existing account across at its owner's first WorkOS sign-in.
- **A custom AuthKit domain.** AuthKit's default domain works; moving later is DNS and a
  setting, not a migration.
- **The escape archive** offered before a vault reset.
- **A provider that is not WorkOS**, for self-hosters who want none.
- **Decommissioning `users.firebase_uid`.** It is nullable, read and written by nothing, and
  kept as the import's join key and the rollback until a deliberate migration drops it.
  Dropping it silently drops `users_identity_present_check`, which that migration must replace
  — in practice with `workos_user_id SET NOT NULL`, once the rows without one have been dealt
  with.

## Consequences

### Positive
- Enterprise SSO, MFA, email verification and password reset without a line of auth UI of ours.
- No identity-provider code or configuration in the browser: about forty packages gone from the
  bundle, nothing inlined at build time, a CSP with no third-party script source.
- One authenticated call per sign-in (two for SSO) instead of a JWKS fetch and a JWT
  verification, and one fewer KV namespace.
- The session, CLI and CI credential model is untouched, and existing sessions survive the
  cutover.
- The vault reset's re-authentication is enforced server-side, step by step, in a table, rather
  than resting on a token the browser minted.

### Negative
- **Self-hosters now need a WorkOS account.** This swaps one vendor dependency for another; it
  does not remove one. AuthKit is free to a million monthly active users, Google sign-in in a
  production WorkOS environment needs the operator's own Google OAuth credentials, and SSO
  connections are billed by WorkOS. Stated in `docs/self-hosting.md`.
- **The seam is narrower than it looks.** Sessions, authorization, crypto and the API do not
  change with the provider, but the linking pass, `users.workos_user_id` and its format CHECK
  are WorkOS's. A second provider needs a subject column and a linker of its own, as Firebase
  had.
- WorkOS is in the availability path for sign-in and for the vault reset. An existing session,
  every CLI token and every service token keep working through a WorkOS outage.
- Logging out of xecret does not log anybody out of AuthKit.
- The vault-reset residuals above. For a Google or SSO account, lock one is a live session at
  Google or the identity provider, not a fresh credential, so an unlocked laptop with that
  session and an open inbox passes both locks. Without MFA, an attacker who owns the victim's
  inbox can open both locks through password recovery. `max_age=0` is not something the server
  sees. And a reset is a way *into* the account's secrets, not only a way to destroy its keys:
  the new vault reads every server-mode environment, and teammates are prompted to re-share the
  end-to-end-encrypted ones.
- Email verification, and Magic Auth with WorkOS's own Magic Auth email, are settings in a
  vendor's dashboard that the code relies on. They have to be checked, in both environments, by
  the deployment check — no test in this repository can.
- Enabling Magic Auth for the vault reset also makes an emailed code a way to sign in.
- **Never point a Staging-environment deployment — local development included — at a database
  whose accounts sign in through Production.** The first sign-in with an existing person's
  address there links that account to a *Staging* WorkOS user; from then on their real sign-in
  is a different identity holding a linked address, which the linker refuses as a conflict, and
  only a manual database repair undoes it.
- An account in two organisations that both require SSO cannot sign in at all.
- The default seat limit is five, and just-in-time membership in an SSO organisation will reach
  it quickly; the refusal is humane, but somebody has to raise the limit.

### Revisit when
- Self-hosters ask for a deployment without WorkOS: a second `IdentityProvider`, with its own
  subject column and linker, is the answer.
- The AuthKit session outliving our logout bothers anyone: WorkOS's logout URL, with the
  session id the code exchange currently discards, is the fix.
- WorkOS offers a server-verifiable time of last authentication — one that covers Google and
  SSO sign-ins too: lock one of the vault reset should check it, closing the `max_age=0`
  residual.
- MFA becomes something xecret can see per sign-in: lock one could then require it of an owner,
  closing the inbox-only path rather than merely recommending MFA against it.
- The TOTP branch of lock two has been exercised against a WorkOS environment with MFA
  enabled. Until then it is tested only against WorkOS's documented error shape.
- The product owner decides on a delayed, cancellable reset (under consideration, not built).
- Two weeks after the production cutover: the decommission migration for `firebase_uid`.
