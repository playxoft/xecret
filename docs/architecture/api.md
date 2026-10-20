# HTTP API

The contract the dashboard, the CLI, and CI all speak. Written before the handlers so the
client and server halves cannot drift, and so the security properties below are decisions
rather than accidents.

---

## 1. Shape

Base path `/api`. JSON in, JSON out, `Cache-Control: no-store` on every response.

Resources are addressed by **slug**, not by id:

```
/api/orgs/{orgSlug}/projects/{projectSlug}/environments/{envSlug}/secrets/{name}
```

This is a security property, not an aesthetic one. A slug is scoped to its parent, so the
path itself carries the tenancy chain and every handler must resolve it top-down through
membership. An id-addressed route (`/api/secrets/{uuid}`) invites the opposite: a single
lookup by primary key, with the tenancy check as a separate step a developer can forget.
That omission is the IDOR bug this product cannot afford (threat T2).

The cost is one join per level. It is paid once per request and is the reason the read path
budget is expressed in queries, not in convenience.

---

## 2. Authentication

Three credentials, resolved in this order. A request may present exactly one.

| Credential | Carried in | Actor | Used by |
|---|---|---|---|
| Session | `__Host-xecret_session` cookie | `user` | Dashboard |
| CLI token | `Authorization: Bearer xct_…` | `cliToken` (acts as its user) | `xecret` CLI |
| Service token | `Authorization: Bearer xst_…` | `serviceToken` (no user) | CI |

A cookie and a bearer token on the same request is a **rejected** request, not a precedence
question. Silently picking one is how a CSRF-able cookie ends up authorising a call the
client believed was bearer-authenticated.

### Service tokens and writes

A service token holding a `write` grant may create and update secrets. What it may never
do is act as a person: writes are attributed by a **pair** of columns — `created_by`
naming a user, or `created_by_service_token_id` naming the token — with a CHECK constraint
requiring exactly one (migration 0006). A CI write is recorded as the act of a named
token, never as the act of whoever minted it.

Two repairs were considered in Phase 4 and rejected, and the reasoning still governs the
design: attributing the write to the token's creator would put a person's name on a write
they did not make, in the one log a company reaches for during an incident; and making
`created_by` nullable *without* the paired column would have weakened attribution for
every write in the product.

`secret.delete` and `secret.rotate` remain outside the service-token allowlist entirely —
CI rotates a value by writing a new one; destroying history is a human's decision.

### Invitation-time access — deny-by-default

`POST /api/orgs/{orgSlug}/members` accepts a `grants` array of
`{ projectSlug, environmentSlug | null }` selections. When present (an empty array
included), acceptance becomes **deny-by-default**: every project the organisation has at
acceptance time receives an explicit project-wide `none` grant unless selected, selected
whole-projects and environments receive grants at the invited role's non-production level,
and the existing resolution rules (environment → project → role default, `none` always
denies) do the rest. A ticked production environment is the conscious act that grants it.
Selections are resolved to ids at invitation time — a bad slug fails in front of the person
who can fix it — and anything deleted before acceptance is skipped, safely covered by the
`none` rows. Invitations without the field (from before it existed) keep the old
role-default behaviour. Projects created *after* acceptance fall back to the role default;
narrowing that is the member page's job.

The identity provider is consulted at three endpoints, and only there:

- `GET /api/auth/callback` exchanges a WorkOS authorization code for the identity behind it
  and, on an SSO sign-in, reads the organisation's verified domains. This is the only place a
  WorkOS answer decides *who* a request is.
- `POST /api/auth/reauth/start` has WorkOS create and email a Magic Auth code.
- `POST /api/auth/reauth/verify` authenticates that code with WorkOS and, for an account with
  an authenticator app enrolled, challenges its TOTP factor and authenticates the TOTP code.

`GET /api/auth/login` builds the AuthKit URL locally and calls nothing. The organisation SSO
settings (`/api/orgs/{orgSlug}/sso…`) call WorkOS too, but only to manage that organisation's
WorkOS organisation — create it, list its connections and domains, mint a setup-portal link —
and never to decide who a request is. `POST /api/auth/confirm` issues a session the callback
held back, from what the callback sealed, and calls nothing; declined, it sends the browser
through WorkOS's logout URL, which `DELETE /api/auth/session` answers too — built by the SDK
from a session id the code exchange returned, with no call made. No endpoint accepts a
WorkOS credential from a client. The one WorkOS value that passes through a browser is the
`mfaToken` of the vault reset's TOTP step — WorkOS's pending-authentication token, which proves
nothing on its own, is accepted only if it matches the hash stored on that session's attempt,
and is useful only beside the TOTP code. WorkOS's own access and refresh tokens are discarded
at the callback. See ADR 0010.

### CSRF

Cookie-authenticated mutations require the double-submit pair: the `__Host-xecret_csrf`
cookie value echoed in the `X-Xecret-Csrf` header. Bearer-authenticated requests do not,
and must not — they carry no ambient credential for a browser to attach.

The sign-in callback is the one state-changing request the pair cannot cover: it is a
top-level navigation back from WorkOS's domain, and no page of ours could have read the
token. Login CSRF is stopped there by the OAuth `state`, bound to the browser that started
the flow through the signed `__Host-xecret_oauth_state` cookie (§4 Auth).

---

### There is no middleware, and there cannot be — ADR 0008

A `proxy.ts` (Next 16's rename of `middleware.ts`) that redirected signed-out visitors away
from `/app/**` was written and then removed. It cannot work on this stack:

- Next 16 **defaults Proxy to the Node.js runtime**, and the `runtime` config option "is not
  available in Proxy files. Setting the `runtime` config option in Proxy will throw an
  error." (`node_modules/next/dist/docs/.../proxy.md` §Runtime.)
- `@opennextjs/cloudflare` refuses to build a Node middleware — `useNodeMiddleware()` in
  `dist/cli/build/build.js` exits 1 with "Consider switching to Edge Middleware."

There is no configuration that satisfies both, so the dashboard layout performs the redirect
instead. Nothing is lost in security terms: the redirect was always a convenience, never a
control. Next's own documentation makes the same point — "Always verify authentication and
authorization inside each Server Function rather than relying on Proxy alone."

Every `/api/**` route authenticates and authorises independently, which is where the actual
boundary is and always was.

---

## 3. Errors

```json
{
  "error": {
    "code": "not_found",
    "message": "Not found.",
    "requestId": "8f2a…",
    "fields": [{ "field": "name", "message": "Secret name cannot start with a digit." }]
  }
}
```

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | Malformed request |
| `validation_failed` | 422 | Body failed schema validation; `fields` populated |
| `unauthenticated` | 401 | No credential, or an invalid one |
| `forbidden` | 403 | Authenticated, membership established, action not permitted |
| `not_found` | 404 | Does not exist, is in another organisation, **or** is not visible to you |
| `conflict` | 409 | Name or slug already taken; version race |
| `payload_too_large` | 413 | Body over 1 MB, or a secret over 64 KB |
| `rate_limited` | 429 | Bucket exhausted |
| `csrf_failed` | 403 | Double-submit pair missing or mismatched |
| `session_locked` | 403 | Authenticated, but the session's vault is locked — see §4 Auth |
| `plan_limit` | 403 | The organisation's plan does not allow it; `plan` populated |
| `sso_required` | 403 | Membership established, but the organisation requires its single sign-on and this session (or the session that approved this CLI token) did not come through it — see §4 *Single sign-on* |
| `reauth_required` | 403 | The action needs this session to have signed in again recently (`/api/auth/login?reauth=1`) — the SSO setup portal |
| `unavailable` | 503 | Misconfigured deployment — a missing binding, an unreachable database — or an upstream provider that could not be asked |
| `upstream_refused` | 502 | An upstream provider (WorkOS) answered and refused a request this server built — a configuration problem; the message names its category |
| `internal_error` | 500 | Unhandled fault |

`plan_limit` carries an extra `plan` object beside `fields`, and it is the one code whose
403 means something the caller can fix by paying rather than by asking for permission:

```json
{
  "error": {
    "code": "plan_limit",
    "message": "…",
    "requestId": "8f2a…",
    "plan": { "resource": "projects", "limit": 5, "current": 5, "plan": "free", "upgradeTo": "pro" }
  }
}
```

`limit`, `current` and `upgradeTo` are each nullable — a capability refusal has no count,
and some refusals have no plan that would allow them. Never an amount of money: prices vary
by currency and interval and belong on the pricing page.

**404 and 403 are not interchangeable.** 403 is only ever returned once membership in the
organisation is already established, so it reveals nothing new. Everything else — wrong
tenant, no grant, genuinely absent — is 404. A client that can distinguish these can
enumerate another tenant's projects.

`message` is a fixed string. Nothing derived from an exception, a database error, or the
rejected input reaches the client; in this product the rejected input may be a secret value.

---

## 4. Endpoints

### Version

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/version` | `{ name, version, commit, builtAt }`. No credential, no database, no rate limit. |
| `GET` | `/version` | The same body, outside the `/api` prefix. Not a redirect — both routes call `versionPayload()`. |

`/api/version` is the canonical one and sits with everything else. `/version`
exists because a version check is the one request made by somebody handed a
hostname and nothing else — an uptime monitor, a `curl` during an incident — and
a 404 there reads as a broken deployment. A 308 was rejected: it costs a monitor
a round trip and has to be explicitly followed by `curl` and most shell scripts,
which is a worse trade than one shared function.

The one endpoint that answers before anything else works. It goes through
`publicRoute` — so it carries a request id, logs, and the same error envelope as
everything else — but issues no query, which is deliberate: the moment you most
want to know what is deployed is the moment something else is failing.

`version` is inlined from `apps/web/package.json` at build time; `commit` and
`builtAt` are stamped by `scripts/deploy-web.sh`. A build from any other path
reports `unknown` for the latter two rather than inventing them, which also
means an `unknown` in production is itself a finding: that Worker was not
deployed by the script.

Unauthenticated on purpose, and the trade is worth stating because
`next.config.ts` turns `poweredByHeader` off on the principle that a secret
manager leaks no build detail. That rule is about disclosure bought for nothing.
Here the disclosure is close to nil — the server is AGPL, so the version names a
tag anyone can already read — and the value is real: the CLI can warn before
issuing a request this server is too old to satisfy. What the endpoint must
never grow is anything describing the *install* rather than the build; the shape
is pinned by a test for that reason.

### Auth

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/auth/login` | Starts a sign-in: writes the signed `__Host-xecret_oauth_state` cookie and answers **307** to AuthKit. Every query parameter is optional and untrusted: `next` (a same-origin path that is not an API route nor a sign-in screen — `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password` or under them — validated here with `safePostSignInPath`, which is `safeRedirectPath` with that last refusal added; anything else falls back to `/app`), `hint=sign-up` (open AuthKit on its sign-up screen), `org=<slug>` (an SSO deep link: start that organisation's single sign-on directly — an organisation without SSO, or one that does not exist, falls through to the ordinary screen alike. A slug that has SSO is revealed by the redirect, which has to carry its WorkOS organisation id, so the lookup is rate limited per address — `RL_LOGIN` under a `login_org` key — and over the limit the parameter is silently ignored rather than refused, since a refusal would be an oracle of its own. **Honoured only with the warning page's `continue` token** (review round 2): an HMAC — its own HKDF label of `WORKOS_COOKIE_PASSWORD` — over the slug, the moment and the random binding in the browser's `__Host-xecret_sso_continue` cookie, under five minutes old, presented with that cookie, *and* from a same-origin navigation to a document (`Sec-Fetch-Site: same-origin`, or a same-origin `Referer` from a browser that sends no such header; `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document` whenever sent). Anything else — another site's link, an email, a bookmark, and a request that merely *arrives* same-origin, such as a redirect — answers **303** to `/sign-in?org=<slug>` (carrying `next`) with a fresh binding cookie (`HttpOnly; Secure; SameSite=Lax`, 30 minutes), and that page, which names the organisation as the unproven claim it is, prints the token into its own "Continue with single sign-on" link. The binding is cleared once the link is followed. An organisation linked to an identity provider its owner controls could otherwise sign a victim in to the owner's account through a link they merely followed, or one an attacker arranged to arrive same-origin — login CSRF. Nothing is looked up or limited on that path; only the binding cookie is written. A link to share is `/api/auth/login?org=<slug>`, never one carrying a token. A linked organisation whose link was made in a different WorkOS environment from this deployment's is ignored like one without SSO. The WorkOS organisation the flow asks for — or none — is sealed into the state cookie, for the callback to compare with the one the sign-in comes back through. Ignored altogether with `reauth=1`), `reauth=1` (send AuthKit `max_age=0`, asking it for the credential again even if it holds a session — the vault reset's first lock. The callback checks that it did, through the access token's `auth_time`. WorkOS documents `max_age` only for AuthKit's own sign-in: it does not make Google or an SSO identity provider ask again; see *Re-authentication for the vault reset*). No credential. Nothing is rate limited but the `org=` lookup, the one database read it can make; the callback it leads to is limited. A deployment whose WorkOS configuration is missing answers **303** to `/sign-in?error=unavailable` (carrying `next`), rather than a JSON 503. |
| `GET` | `/api/auth/callback` | Where AuthKit sends the browser back, with `code` and `state`. Exchanges the code with WorkOS once, links or creates the user, and sets the session and CSRF cookies — or, for a sign-in that must be confirmed first (*The sign-in confirmation*, below), sets none and parks it. Always answers **303** — to the cookie's `next` on success, to `/sign-in/confirm` for a parked sign-in, to `/sign-in?error=<code>` on any refusal — and always clears the state cookie. Rate limited: `RL_LOGIN`, on the address and then on address + identity. Order of operations below. |
| `POST` | `/api/auth/confirm` | The answer to "Continue as …?" on `/sign-in/confirm`, the only way a parked sign-in becomes a session. A form POST (`application/x-www-form-urlencoded`, at most 1 KB): `confirmation` — the parked cookie's nonce, which the page printed into its form — and `decision` (`continue`; anything else declines). Refused unless `Origin` is present and this deployment's and `Sec-Fetch-Site`, where sent, is `same-origin`; then the `__Host-xecret_sign_in_confirm` cookie's MAC and five minutes; then the token against the cookie's nonce in constant time; then the nonce is **spent** (`sign_in_confirmations`) — a second use of the same cookie is refused before anything is issued. `continue` runs what the callback deferred — the just-in-time join, under the organisation's lock — and issues the session exactly as the callback would have (steps 12–13, with the facts it sealed), audited as the ordinary `auth.login` / `auth.signup` carrying `confirmation` (why it was held back), and answers **303** to `next` (never an API route). A decline issues nothing, keeps whatever session the browser had, files `auth.sign_in_declined`, and answers **303** through WorkOS's logout URL for the AuthKit session the sign-in came from (its `sid`) — so a planted AuthKit session does not answer the person's next sign-in too — and on to `/sign-in?error=declined`, without the flow's `next`; straight there when the sign-in named no AuthKit session. Any refusal is a **303** to `/sign-in?error=expired`. Every answer clears the cookie. Rate limited: `RL_LOGIN` on the address. No credential. |
| `DELETE` | `/api/auth/session` | Revokes the current session, clears both cookies, and answers **200** `{ logoutUrl }`: WorkOS's logout URL for the AuthKit session this one came from (`sessions.workos_session_id`, the access token's `sid` at sign-in), returning to `/sign-in`, which the dashboard navigates to so that AuthKit's own session ends too (review round 2) — or `null` for a session that recorded none (every one issued before migration 0023, or WorkOS not configured), which signs out as before. Idempotent: a second sign-out of an ended session answers `null`. CSRF-checked when a session cookie is present. A `POST` here answers **405** — the Firebase ID-token exchange it used to accept is gone. |
| `GET` | `/api/auth/me` | The signed-in user, their organisations, their role in each — plus an `authority` summary per organisation (effective role, custom role, capabilities, assignable roles, definable bases) that the dashboard draws its controls from, since a custom role can narrow what the stored role alone suggests — and `sso: { required, blocked }` per organisation: whether it requires its single sign-on, and whether that refuses *this* credential (the `resolveOrg` rule), so the dashboard can offer the organisation's SSO sign-in instead of a failed load — and the vault state (`{ configured, unlocked, unlockedUntil, autoLockMinutes }`, where `autoLockMinutes` is already resolved and clamped — the client schedules a timer against it and does not re-implement what "no preference" means). Never carries key material. Exempt from the lock gate. |
| `GET` | `/api/auth/sessions` | Active sessions for the "signed-in devices" view. Never returns a token hash. |
| `DELETE` | `/api/auth/sessions` | Sign out everywhere. Optional `?except=current`. |
| `DELETE` | `/api/auth/account` | The account deletes itself. Body `{ confirm: <account email> }`. Browser sessions only (never a bearer token), vault-gated, rate limited `RL_MUTATION`. The vault is deleted outright, so every environment key sealed to that account's public key becomes unopenable. One transaction: solo organisations are soft-deleted with the account, other memberships removed, every session and CLI token revoked, the user row soft-deleted — terminal, since the sign-in's linking pass refuses a deleted account whether it reaches it by identity or by address. **409** while the caller is the only active owner of an organisation other people are in: ownership must move first. Audited as `auth.account_deleted`; the response clears both cookies. |

**The state cookie.** `__Host-xecret_oauth_state` carries a fresh 256-bit `state`, a 256-bit
PKCE verifier, the validated `next`, the purpose (`sign-in` or `reauth`), the time it was
issued, and the WorkOS organisation the flow asked for (`null` for an ordinary sign-in; a cookie
sealed before the field existed reads as `null`, the strict answer). It is HMAC-SHA-256-signed under a key HKDF-derived from `WORKOS_COOKIE_PASSWORD`, not
encrypted — nothing in it is secret from the browser holding it, but nothing in it may change
— and it is `HttpOnly; Secure; SameSite=Lax` with a ten-minute lifetime, the lifetime of the
code it travels with. PKCE is used although the server is a confidential client: the verifier
lives only in this cookie, so a code lifted from a history entry, a referrer or a log cannot be
exchanged without it. The redirect URI is derived, `XECRET_PUBLIC_URL` + `/api/auth/callback`,
never configured separately.

`next` is checked four times: by `safePostSignInPath` at the login route — `safeRedirectPath`,
which re-checks its own normalised output and refuses anything that becomes `//…` or carries a
`\`, and **any path under `/api/`** — decoded until it settles, lower-cased, backslashes read
as slashes, dot segments resolved — since every redirect to `next` is a navigation the browser
makes as the person, and an API route answers a GET by doing something (review round 2:
`next=/api/auth/login?org=attacker-co` turned the sign-in confirmation's "Continue" into a
same-origin request for an attacker's single sign-on); and, read the same way, **any sign-in
screen** (`/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`, and under them), so a
finished sign-in never lands on the SSO warning page as an apparent second step (review round
3: `next=/sign-in?org=attacker-co`, or `/forgot-password?org=…`, which Next redirects there
with its query); by the state cookie, which refuses a `next` starting `//`; and by
`safePostSignInPath` again at the callback and at the confirmation, on what their cookies say,
before the final redirect. `safeRedirectPath` alone, which the sign-in pages and the API
client's 401 bounce use, still lets `/sign-in?org=` through: the warning page is a page people
are sent to, only never a finished sign-in's destination.

**The callback, in order.** Nothing reaches WorkOS or the database until the cheaper checks
in front of it have passed:

1. `RL_LOGIN` on the caller's address.
2. The state cookie: its MAC before anything in it is parsed, then its age, then `state`
   against the query string in constant time. A parameter given twice is refused, not
   resolved.
3. Whatever WorkOS said went wrong, if it said so (`error=access_denied` is a cancellation).
4. The code exchange — one authenticated call to WorkOS with this deployment's secret key and
   the flow's PKCE verifier. The identity is minted once, from that response, and passed on as
   that exact object.
5. An **impersonated** sign-in is refused, then an **unverified address** (403). An **SSO**
   sign-in must name a WorkOS organisation, and the address's domain must be one that
   organisation has verified with WorkOS (403) — checked before the linker, so it covers an
   already-linked identity too. That check is the one other WorkOS call a sign-in can make.
6. `RL_LOGIN` again, on address + WorkOS user id.
7. The linking pass (`upsertUserFromWorkosIdentity`, at READ COMMITTED): match
   `workos_user_id`; else adopt the account holding the same **verified** address; else create
   it. Audited `auth.login`, `auth.identity_linked` or `auth.signup` respectively, each with the
   sign-in method. `auth.identity_linked` is written when the link is, even if a later step
   refuses this sign-in (`sso_required`, no seat); an adopted sign-in that completes records
   `auth.login` as well. A deleted account is refused (403), and an address held by an account
   linked to another identity is a **409** that names neither that account nor how it signs in.
8. **The just-in-time join, planned** — read-only (see *Single sign-on* below): the
   organisation here whose single sign-on this was — **in this deployment's WorkOS environment
   only**; a link made in another resolves to nothing — whether the account is already an
   active member of it, and whether it would admit the account (opted in, not removed). The
   join itself waits for step 12. Steps 8, 9 and 12 require `authenticationMethod === 'SSO'`
   *and* the organisation id: AuthKit reports an organisation after organisation selection in
   password and Google sign-ins too.
9. `sso_required`, at sign-in. The requirement is enforced **on every request** (`resolveOrg`;
   see *Single sign-on*), so a session that does not satisfy one organisation simply cannot
   reach that one. The sign-in itself is refused (403, `sso-required`) only when **every**
   organisation the account belongs to would refuse it — each requires a single sign-on this
   was not, and the account is no owner there — and no join is in prospect. One
   organisation's requirement no longer locks somebody out of all the others.
10. A personal organisation for an account that has none and is not about to join one — before
    any confirmation, because it is the new account's own and nobody else's.
11. **Whether the person must confirm first.** Not issued here, but parked in a sealed cookie,
    with the browser sent to `/sign-in/confirm` (*The sign-in confirmation*, below): a sign-in
    that came back through a WorkOS organisation the flow did not ask for (the state cookie's)
    — any single sign-on on a plain sign-in included; one through the single sign-on of an
    organisation **the account is not an active member of, even the one the flow asked for**
    (review round 2); and one from an authentication WorkOS dates before the flow began (its
    `auth_time`: a session reused without asking) **unless the account is the one this browser
    last signed in as** (`__Host-xecret_last_account`, an HMAC over the account id written at
    every sign-in). For a `reauth`, whether it arms lock one, and when the person authenticated,
    are decided here and carried in the cookie.
12. **The just-in-time join**, under the organisation's row lock — only for an organisation
    that opted in (`jit_join_enabled`, off by default): a newcomer becomes a `viewer`, under the
    seat limit — `member.jit_joined`, or `member.jit_denied` and a 403 when no seat is free —
    and every invitation still open for their address is withdrawn. Without the opt-in the
    person signs in to whatever else they belong to and joins by invitation. A suspended
    membership is never reinstated, and **somebody the organisation removed is never
    re-admitted** (`org_member_removals`, cleared only by accepting an invitation sent after the
    removal): `member.jit_denied` with reason `removed`. Then steps 9 and 10 again, for the
    account as the join left it. For a parked sign-in this runs only on "Continue", so a decline
    leaves no trace in the organisation.
13. The new session is issued — recording how it signed in (`sign_in_method`, and the WorkOS
    organisation for a single sign-on), which every later request's `sso_required` is judged by;
    the AuthKit session it came from (`workos_session_id`), which sign-out ends; and for a
    `reauth` with a fresh authentication by a method that re-proves the person (an emailed code
    included), when that was (`fresh_auth_at`, the setup portal's step-up) — and, for a `reauth`
    whose method counts as lock one (`Password`, `Passkey`, `GoogleOAuth`, `SSO`), its
    `reauthentications` row — all dated by WorkOS's `auth_time`, not by when a held-back sign-in
    was confirmed, and all in one transaction (below). Only then, if the browser presented a
    live session of this same account, is that session revoked. Audited `auth.login` (or
    `auth.signup`) in one organisation — carrying `confirmation` when it was held back — and
    `auth.sso_exemption_used` in **each** organisation that requires SSO and was reached only
    by the owner exemption. The last-account cookie is written beside the session cookies.
14. A 303 to `next`, after `safePostSignInPath` has checked it once more.

**The sign-in confirmation.** `state` and PKCE prove the callback completes a flow this browser
started; they cannot prove whose authentication came back, because AuthKit reuses a session it
already holds without asking. An attacker who owns an organisation here, wired to an identity
provider they control, can plant *their own* AuthKit session in a victim's browser — a hidden
navigation to AuthKit for their organisation, or their provider's IdP-initiated sign-in — and
the victim's next plain "Sign in" would come back as the attacker, against the victim's valid
state. Step 11 is the defence. The parked cookie, `__Host-xecret_sign_in_confirm`, is
HMAC-signed under its own HKDF label from `WORKOS_COOKIE_PASSWORD` (so neither cookie can stand
in for the other), `HttpOnly; Secure; SameSite=Lax`, five minutes, and holds the *outcome* of
steps 5–10 — the account id and address, how it signed in, the organisation's name and slug as
it calls itself here, `next`, the purpose, the lock-one verdict and the fresh-authentication
time, why it was held back, whether continuing joins the organisation, the AuthKit session id,
and a 256-bit nonce — never the WorkOS identity itself, which is minted only from WorkOS's own
response. It is never longer than a browser keeps a cookie: one that would be (the longest
`next` beside a long name) is sealed again with `next` dropped to `/app`. `/sign-in/confirm`
reads it on the server and shows the account's address whole, above the buttons, naming the
organisation as the claim it is ("an organisation calling itself …") and saying when continuing
makes the account a member. Both strings are somebody else's, so both are made inert first —
direction overrides, invisible characters and stacked accents replaced by a visible U+FFFD,
length-capped, rendered in `<bdi dir="ltr">` — and an address with non-ASCII characters is
called out. Its form posts the nonce to `POST /api/auth/confirm`, which spends it once and
issues the session. Nothing is taken from the URL. A person who signed in through their
company's identity provider from the plain button — or joins an organisation by its single
sign-on for the first time — answers one question; one whose browser was used against them can
say no.

Every refusal is a 303 to `/sign-in?error=<code>` — the page renders a fixed sentence for a
known code and nothing for an unknown one — and the HTTP status the refusal stands for (403,
409, 429, 503) is in the log line, never the response: this is a page load, and a JSON body on a
blank tab is a dead end for the person reading it. The log line's message is the same for every
outcome ("Completed a sign-in callback…"), with the outcome and that status bound as fields, so
a message never says one thing while its fields say another. A code WorkOS refused (expired, replayed, a
PKCE mismatch) is reported to the person as an expired attempt; naming which part was wrong
tells an attacker which part of a forged request to fix next.

### Re-authentication for the vault reset

The vault reset destroys a vault for good and has to stay reachable from a locked session, so
it is guarded by two re-authentications in a fixed order instead of the vault lock: a sign-in
again (`/api/auth/login?reauth=1`), then a code WorkOS emails to the account — plus, for an
account with an authenticator app enrolled in WorkOS, its TOTP code. The server keeps each
attempt's progress in `reauthentications`, bound to the session the sign-in issued; the
callback writes that row in the same transaction as the session. Only `Password`, `Passkey`,
`GoogleOAuth` and `SSO` sign-ins count as the first lock — an explicit list, so another OAuth
provider, an emailed-code sign-in (the two locks would be one inbox twice) or a method WorkOS
adds later does not. A refusal is a **403** — or a 429 or 503 where noted — and never a 401,
because the client treats a 401 as "your session has ended" and would throw away the very
session the attempt is bound to. All three are browser-session only and exempt from the lock
gate.

The first lock has one other reader: the SSO setup portal (`POST /api/orgs/{orgSlug}/sso/portal`)
asks for a `reauthentications` row for the calling session under ten minutes old before it
mints a link — a step-up for a credential-grade action. It reads the row and never spends it,
so a vault reset's attempt is left exactly where it was.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/auth/reauth` | Where this session's attempt stands: `{ signedIn, signedInUntil, codeSent, email }`. Reads only; never sends anything. |
| `POST` | `/api/auth/reauth/start` | No body. Has WorkOS email a one-time code to the session's own address. Refused unless this session's sign-in for the reset is under 10 minutes old. xecret never holds the code. **204**. **403** after three requests on one attempt — reserved in `reauthentications.code_sends` before WorkOS is asked, under the user's row lock, so a burst cannot exceed it and a request WorkOS refused still counts; signing in again starts a new attempt. **503** while Magic Auth is disabled in the WorkOS environment. Rate limited: `RL_LOGIN` under a `reauth_start` key on the user alone, which is per location and fails open — the cap above is what holds. |
| `POST` | `/api/auth/reauth/verify` | Two request shapes. **`{ code }`**, six digits: checked with WorkOS, still within 10 minutes of the sign-in, and only on an attempt whose code was actually requested; the code must prove control of the WorkOS user this account is linked to, unimpersonated. **`{ totp, mfaToken }`**, six digits from the authenticator app: the second step for an account with one — `mfaToken` must match the hash stored on this session's attempt; the server challenges the account's TOTP factor and authenticates `totp` against it. A union, so a body carrying both shapes or neither is a **422**. Two response shapes. **`{ reauthProof, expiresAt }`**: a one-time `xrp_` proof, five minutes, stored as its SHA-256 and bound to this session and this user; a second success replaces the first. **`{ mfaRequired: true, mfaToken }`**: the code was right, and WorkOS asks for the TOTP code (`mfa_challenge`); only the SHA-256 of `mfaToken` (WorkOS's pending-authentication token) and the factor id are kept, and no proof is minted yet. **403** for a wrong or expired code or TOTP, an attempt out of guesses (sign in again), and — each with its own message — WorkOS asking for organisation selection, email verification, SSO, MFA enrolment, or a Radar challenge. **429** (`rate_limited`) once the account's ten guesses for the day are spent. **503** while Magic Auth is disabled. Rate limited: `RL_LOGIN` under a `reauth_verify` key. Audited `auth.reauthenticated` when a proof is minted. |

**The guess budget.** Every guess — a `{ code }` and a `{ totp, mfaToken }` alike — is reserved
atomically *before* WorkOS is called, so it is spent whether or not the client waits for the
answer: at most **five per attempt**, and at most **ten per account in any rolling 24 hours**
across all its attempts, the second taken under the user's row lock so concurrent guesses
cannot overrun it. A WorkOS error xecret cannot classify costs a guess like a wrong answer.
The budget is kept in `reauthentications`, not the rate limiter, so it holds where the rate
limiter is absent and fails open.

The emailed code is WorkOS Magic Auth, which WorkOS refuses to create while Magic Auth is
disabled as a sign-in method in its environment (`400 authentication_method_not_allowed`), so it
must be enabled — with WorkOS's own Magic Auth email left on — in every WorkOS environment a
deployment uses. Enabling it also offers "email me a code" on AuthKit's sign-in page, which is
why the first lock refuses that method.

The TOTP branch is unit-tested against WorkOS's documented error shape only. MFA is not enabled
in the Staging WorkOS environment, so it has not yet been exercised against WorkOS; that live
check is pending.

**What the first lock proves, and the residual risks** (ADR 0010). WorkOS documents `max_age`
only for AuthKit's own sign-in: it can make AuthKit ask for a password or a passkey again, but
it does not make Google or an SSO identity provider ask for anything, so for those accounts a
live session there satisfies the first lock silently. Somebody at an unlocked laptop with the
victim's Google session and their Gmail open in another tab therefore passes both locks.
Somebody in full control of the victim's inbox alone can reset the password at AuthKit, sign in
with the new one (a password, so it counts) and then receive the code. `max_age=0` is a
parameter in a URL the browser follows, so the callback does not take it on trust: it reads
`auth_time` from the access token WorkOS returns with the code — WorkOS's record of the person's
most recent active authentication, which a reused session or a refresh does not move — and
counts lock one only when it is no earlier than the flow's start, less 30 seconds for clock
difference; a token without one does not count. That stops a stripped `max_age=0` from passing
on a reused AuthKit session, but not the Google or SSO case above, which WorkOS counts as an
active authentication. Against the first two, an authenticator app enrolled in WorkOS is the
defence today — the code alone no longer mints a
proof — and it is recommended for organisation owners. What a successful attacker gains is not
only a destroyed vault: they set up a new one, which unlocks their session and reads every
server-mode environment the account can read, and the reset prompts teammates to re-share the
end-to-end-encrypted ones. What the locks do stop is a stolen session cookie replayed from
another browser. No waiting period comes before a reset, by the product owner's decision; the
seven-day recoverable reset and the archive emailed at reset time are follow-up P23, not built
here.

### The vault

Every secret is encrypted in the browser under a key hierarchy the server cannot open
(ADR 0009; byte-level formats in `docs/security/e2ee-crypto-spec.md`). These endpoints
store and return that hierarchy. **None of them decrypts anything, and none of them could
be extended to** — the server holds no key to extend them with.

Three conventions hold throughout:

- **Binary values travel as unpadded base64url.** Public keys, the KDF salt, the unlock
  verifier, lookup hashes and credential ids are raw bytes. Padding is refused, because
  two spellings of one value would make a `bytea` equality lookup miss one of them.
- **Wraps and encrypted private keys travel as `xk2.…` blob strings**, verbatim. The
  server checks the prefix, the alphabet and length bounds — never the contents. Request
  schemas are in `server/schemas/vault.ts` (`vaultCreateSchema`, `vaultUnlockSchema`,
  `vaultPassphraseSchema`, `recoveryBeginSchema`, `recoveryCompleteSchema`,
  `recoveryRegenerateSchema`, `passkeyEnrollSchema`, `autoLockSchema`).
- **A recovery kit is exactly five codes.** Redeeming one invalidates all five, because
  all five wrap the same User Key.
- **There are two unlock verifiers, and they are not interchangeable.**
  `unlockVerifier` is `HKDF(SK, …)` and only a passphrase can produce it;
  `ukUnlockVerifier` is `HKDF(UK, …)` and is what a passkey unlock sends, since it opens
  the User Key directly and never derives `SK`. They are stored as separate digests and
  compared against the matching one only.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/auth/vault` | `{ vault, material }`. `material` is `null` when no vault exists or the caller is a **service** token; a **CLI** token receives its issuing user's, because it acts as that user and cannot open a single environment grant without their wrapped private key. Otherwise `{ encAlgorithm, encPublicKey, encPrivateKeyEnc, signAlgorithm, signPublicKey, signPrivateKeyEnc, kdfSalt, kdfParams, passphraseWrap, recoveryCodesRemaining, passkeys[] }`. `recoveryCodesRemaining` is a count — a recovery wrap is only ever returned in exchange for its own lookup hash. Served to a **locked** session on purpose: an unlock is a client-side operation, and a client cannot unwrap a key it has not been given. Serving it to a CLI token concedes exactly the same and no more — the wraps are useless without the passphrase, a recovery code, or a passkey, and a token holds none of the three. Exempt from the lock gate. |
| `POST` | `/api/auth/vault` | The setup ceremony, in one body: `{ encPublicKey, encPrivateKeyEnc, signPublicKey, signPrivateKeyEnc, kdfSalt, kdfParams, unlockVerifier, ukUnlockVerifier, passphraseWrap, recoveryWraps[5] }`, each recovery entry `{ lookupHash, wrap }`. Both verifiers are recorded here and only here, so either unlock path works from the moment a vault exists. Written in one transaction, and unlocks the session that ran it. **409** on a second call — never an overwrite, because the old public key has environment keys sealed to it. Rate limited: `RL_LOGIN`. Audited `vault.created`. Exempt from the lock gate. |
| `PATCH` | `/api/auth/vault` | Body `{ autoLockMinutes }`: a count of minutes, or `null` to clear the preference and follow the default. **Clamped, never refused** — the floor and ceiling (15 and 720) are the server's, and a 422 for "lock me after five minutes" would leave the looser setting in place, which is the wrong direction to fail in. There is no "never": the same number is what the unlock gate measures `vault_unlocked_at` against, so an infinite one would be an indefinitely replayable cookie. Not exempt from the gate — a locked session has no business loosening a protection. Rate limited: `RL_MUTATION`. Audited `auth.autolock_changed`, with the *effective* interval. |
| `POST` | `/api/auth/vault/unlock` | Body is **exactly one of** `{ unlockVerifier }` or `{ ukUnlockVerifier }` — a union, so a body carrying both or neither is a **422**. Compared in constant time against the matching stored `SHA-256`, sets `vault_unlocked_at`, returns `{ vault, unlockedUntil }`. How long that lasts is the account's own `autoLockMinutes`, measured from the later of the unlock and the session's `last_seen_at` — an idle allowance, not a stopwatch, so an actively-used session is not thrown back to the lock screen mid-edit — with an absolute ceiling of 8 hours that no preference lifts. Rate limited: `RL_LOGIN`, plus a durable per-account lockout (5 free attempts, then 60 s doubling to a 60 min ceiling) that **both** forms share — they attest to the same capability, and separate counters would be two budgets against one gate. Audited `vault.unlocked`, and `vault.unlock_failed` on refusal, each carrying `method: passphrase \| passkey` — with a uniform reason, so the audit log does not become the oracle the API refuses to be. Exempt from the lock gate. |
| `POST` | `/api/auth/vault/lock` | Locks this session, or every session with `{ everywhere: true }`. Does **not** revoke — the user stays signed in. Returns `{ locked }`. Audited `auth.locked`. |
| `POST` | `/api/auth/vault/passphrase` | Body `{ currentUnlockVerifier, unlockVerifier, kdfSalt, kdfParams, passphraseWrap }`. Re-wraps the User Key and swaps the verifier in one transaction; returns `{ vault, material }` so the client can replace the wrap it now holds. Requires an unlocked session **and** the current passphrase: the gate proves this session unlocked at some point in the last 8 hours, the verifier proves the person typing knows it now. The User Key is unchanged, so recovery codes keep working, enrolled passkeys keep working, `ukUnlockVerifier` stays valid, and other devices stay unlocked. Rate limited: `RL_LOGIN`, plus the same lockout as unlock. Audited `vault.passphrase_changed`. |
| `POST` | `/api/auth/vault/recovery` | Body `{ lookupHash }` — step one. Returns `{ wrap, material }` for the code that hash addresses. An unknown hash, an already-redeemed code and another account's code all get **one** indistinguishable refusal. Rate limited: `RL_LOGIN` under a `vault_recovery` key on the user alone, plus a per-account recovery lockout counted separately from the passphrase one, so a mistyped code cannot spend the budget protecting the passphrase. Exempt from the lock gate. |
| `POST` | `/api/auth/vault/recovery/complete` | Body `{ lookupHash, unlockVerifier, kdfSalt, kdfParams, passphraseWrap, recoveryWraps[5] }` — step two. Redeems the code, sets the new passphrase and reissues the whole kit in one transaction, then unlocks the session; returns `{ vault, material }`. The reset and the reissue are not optional: somebody here has lost control of their passphrase, and four other codes still open the same key. **409** if the code was redeemed in between. Audited `vault.recovery_used` **and** `vault.recovery_codes_regenerated`. Exempt from the lock gate. |
| `PUT` | `/api/auth/vault/recovery` | Body `{ unlockVerifier, recoveryWraps[5] }`. Reissues the kit from an unlocked session with the passphrase re-entered (sudo mode). Every live code is revoked in the transaction that writes the new five; redeemed ones keep their tombstones. Returns `{ vault, recoveryCodesRemaining }`. Audited `vault.recovery_codes_regenerated`. |
| `GET` `POST` | `/api/auth/vault/prf` | List, or enrol, a passkey for one-touch unlock. `POST` body `{ credentialId, label, transports?, wrap }` → **201** `{ passkey }`. A passkey is never the only wrap — the passphrase wrap always exists and has no removal path — so enrolling adds a door rather than replacing one. Rate limited: `RL_MUTATION`. |
| `DELETE` | `/api/auth/vault/prf/{passkeyId}` | Unenrols a passkey; its wrap goes with it by cascade. **204**. Scoped by user, so another account's id answers the same **404** as one that does not exist. |
| `GET` | `/api/auth/vault/reset/preflight` | What a reset would do with the escape archive, asked by the reset screen before anybody confirms: `{ resettable, archive: { deliverable, reason, estimatedBytes, maxBytes, environmentCount, secretCount } }`. `reason` is `null`, `too-large` (the estimate is over 8 MiB) or `mail-not-configured`; `resettable` is `false` only on a production deployment with no mail provider, where every reset is refused. Sized in SQL from the rows the archive would hold, without loading any ciphertext; the estimate is an upper bound. A **locked** session — which is also what a stolen cookie is — gets only `{ resettable, archive: { deliverable, reason } }`, plus `estimatedBytes` and `maxBytes` when the reason is `too-large`; the counts are for an unlocked session. **404** with no vault. Exempt from the lock gate. Rate limited: `RL_LOGIN` under `vault_reset_preflight`. |
| `POST` | `/api/auth/vault/reset` | Body `{ confirm: "reset my vault", reauthProof, proceedWithoutArchive? }`. The phrase is compared with the same trimming, case-insensitive helper `DELETE /api/auth/account` uses, and checked first, so a typo is reported as a typo (**400**). **Never without the archive, silently** (owner decision, PR #121 round 1), all checked before the proof is spent: a production deployment with no mail provider answers **503** and resets nothing, whatever the body says; an archive that cannot be emailed — too large, or no mail outside production — answers **409** unless `proceedWithoutArchive` is `true`, which the reset screen sends only when the person ticked "Reset without the emailed archive". `reauthProof` is the token `POST /api/auth/reauth/verify` minted — both re-authentications done, in order (see *Re-authentication for the vault reset* above) — and is spent by one atomic UPDATE that requires this proof, this user, this session, unspent and unexpired, **before** anything is sent or changed: a reset that then fails for another reason needs a fresh proof. Then, **before the reset** (P23), the escape archive (spec §14) is assembled from stored ciphertext — the account's wraps and member grants, and the latest value of each live secret in every end-to-end-encrypted environment it may still read — and emailed to the account's address, one part per message, at most two parts of 5 MiB; with `proceedWithoutArchive`, a notice is emailed instead when mail works. A provider refusal of any send answers **503** and resets nothing. Then, in one transaction, the vault that was archived is **retained** for seven days (key row, live passphrase wrap, unused recovery wraps, every member grant) — **409**, with nothing reset, if the account's vault is no longer that one — the live tables are emptied, every device PIN is revoked, `vault_unlocked_at` is cleared on **all** the account's sessions, and a pending key share is re-recorded for every environment the account may still read. Returns `{ vault, archive, retained }`: `vault` reports `configured: false`; `archive` is `{ emailed: true, parts, to }` or `{ emailed: false, reason }` with `reason` `mail-not-configured` or `too-large` (only ever with `proceedWithoutArchive`); `retained` is `{ id, retainedUntil, grantCount }`. **404** when there is no vault, **403** when the proof is refused (one message for every cause). **This is not recovery** — nothing is decrypted or restored here. Rate limited: `RL_LOGIN` under a `vault_reset` key of its own, deliberately *not* sharing recovery's counter. Audited `vault.archive_emailed` (or its error) and `vault.reset`. Exempt from the lock gate, which is the entire point. |
| `GET` | `/api/auth/vault/retained` | The account's reset vaults still inside their seven-day window: `{ retained: [{ id, retainedAt, retainedUntil, recoveredAt, grantCount, environmentCount, recoveryCodesRemaining }] }` (`grantCount` counts key versions; `environmentCount`, the environments they open, is what the screens show). Behind the lock gate, like every recovery endpoint: recovering re-seals into the current vault, which needs it open. |
| `GET` | `/api/auth/vault/retained/{id}` | What the browser needs to open one: `{ retained: { …, userId, encPublicKey, encPrivateKeyEnc, kdfSalt, kdfParams, passphraseWrap, grants: [{ envDataKeyId, edkVersion, edkStatus, environmentId, …names, edkSealed, ehkSealed }] } }` — grants only for live end-to-end-encrypted environments the account may still read (`can(secret.read)`, as the restore checks). Never its recovery wraps. Owner only, inside the window only, the same **404** otherwise — a malformed id included, on every retained route. `RL_LOGIN` under `vault_retained`. |
| `POST` | `/api/auth/vault/retained/{id}/recovery-wrap` | Body `{ lookupHash }` → `{ wrap }`: the retained recovery wrap that code opens. Every miss is one **400** and is counted against the retained vault's own lockout (`nextUnlockFailure`) before it is answered; **429** while locked out. Not audited — `vault.recovered` is written when the restore proves the User Key was opened. |
| `POST` | `/api/auth/vault/retained/{id}/restore` | Body `{ ukUnlockVerifier, grants: [{ envDataKeyId, recipientPublicKey, edkSealed, ehkSealed, signature }] }`: the retained vault's keys, re-sealed by the browser to the current vault's public key and signed by it, with `HKDF(oldUK, "xecret.v2.uk-unlock-verifier")` as proof. A wrong proof is **403** and counted against the retained vault's lockout. One transaction under a lock on the retained vault: refuses (**400**) a grant not sealed to the current public key, a key the retained vault never held, or a key named twice; **409** with no current vault; writes each remaining grant as a member grant (`ON CONFLICT DO NOTHING`) and settles the pending share an active key answers; skips — and reports — `already-held`, `environment-gone` and `no-access` (`can(secret.read)` inside the transaction). Returns `{ restored, skipped }`. Audited `vault.recovered` in each organisation that got keys back. There is no route that deletes a retained vault. |
| `POST` | `/api/internal/scheduled/vault-purge` | The hourly Cron Trigger's job, reachable only in-process from `worker.ts`. A request without the nonce `runScheduledJob` minted for this run in this isolate gets a bare **404** with no body, decided before any service context, database connection or log line is made. Deletes retained vaults past their window in batches of 100, at most ten per run, and records `vault.purged` with a `system` actor. The database refuses any earlier delete by its own clock (migration 0020). |

**What the server holds.** Public keys, an Argon2id salt and its parameters, the digests of
both unlock verifiers, and a set of ciphertexts. Each verifier is a *sibling* HKDF branch of
a wrap key, so holding a digest opens nothing — they exist so the server can gate the API,
throttle attempts, and keep an audit trail. `ukUnlockVerifier` concedes nothing further:
anyone who can compute it already holds the User Key, and therefore already holds every
private key and environment key the account can reach, so the proof is strictly weaker than
the capability it attests to. A client MUST NOT send the stretched key, the User Key, any
wrap key, or any private key, including in diagnostics.

**The concession, stated plainly.** `GET /api/auth/vault` serves the wraps to a locked
session, because an unlock cannot happen otherwise. A stolen session cookie therefore
yields an *offline* Argon2id attack on the master passphrase, unbounded by the lockout.
That is inherent to a browser-delivered zero-knowledge product, and it is why ADR 0009
sets the passphrase bar where it does rather than at a composition rule.

**And it is wider than a session.** A **CLI token** reads its issuing user's material through
the same endpoint, and must: it acts as that user, its grants are sealed to that user's X25519
public key, and the private half exists only as a wrap under the User Key — so withholding the
material would leave headless `xecret login --passphrase` authenticating perfectly and
decrypting nothing. What the token receives is the passphrase wrap, the KDF salt and the Argon2
parameters: everything an offline attack needs, plus the *cost* of that attack stated in the
parameters, held by a credential that lives in a file on a laptop or an environment variable in
a CI runner and is good for months rather than for a session. "The wraps are useless without the
passphrase" is true of a locked browser and is a weaker sentence here.

It is not removable without removing the flow, so it is metered and made visible instead: a
token read spends `RL_CLI_TOKEN` under a `vault_material` key, and writes a **`vault.material_read`**
audit record carrying `principalKind: "token"`, so "a token in a CI runner pulled my wraps at
04:00" is a question somebody can ask. A browser session reading its own material is neither
metered nor audited — it happens on every lock screen, several times a day, and recording it
would bury `vault.unlocked` under page views. ADR 0009 carries the trade under residual risks.

### CLI authorization — how `xecret login` gets its token

RFC 8252-style loopback flow with PKCE (S256 only), against this server — never the
identity provider directly. The CLI opens `/cli/authorize?challenge&port&device&state` in a browser; an
already-signed-in person approves the named device; the consent screen redirects the
one-time code to `http://127.0.0.1:{port}/callback`; the CLI exchanges code + verifier.

**The User Key hand-off.** A CLI token acts as its user, and that user's environment grants
are sealed to a public key whose private half is wrapped under the User Key — so a token
alone decrypts nothing. The CLI therefore generates an ephemeral X25519 keypair and adds
`&handoff=<43-char base64url public key>` to the authorize URL. The consent screen, with the
vault unlocked *in that tab*, seals the User Key to it and appends the resulting
`xk2.x25519.…` blob to the loopback redirect as `&handoff=…`. The CLI opens it with the
private half it never wrote down and keeps the User Key in the OS keyring.

**No part of that reaches this server.** `POST /api/cli/authorize` carries the org, the
device name and the challenge, exactly as before, and returns only the code. The wrap is
produced in the browser and consumed on `127.0.0.1`; a query parameter rather than a
fragment because the CLI's listener is an HTTP server and a fragment would never arrive. The
parameter is optional in both directions — an older CLI omits it and gets the flow it always
had. Format and rationale: `docs/security/e2ee-crypto-spec.md` §13.2.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/cli/authorize` | Session + CSRF only — a bearer credential may not mint further credentials, and the vault lock gate applies. Body `{ orgSlug, deviceName, codeChallenge }`. Mints a single-use code (10 min TTL, hashed at rest, supersedes the user's outstanding codes). Requires active membership (`member.read`) — deliberately **not** `token.create`, which gates *service* tokens: a CLI token acts as its user and adds no authority. For an organisation that requires single sign-on, the approving session must have come through it (owners exempt) — `resolveOrg` answers `sso_required` otherwise — and the code records how the session signed in, for the token to inherit. Rate limited: `RL_CLI_TOKEN`. Audited as `token.authorized` — and, when an owner approves from a session that did not come through the organisation's required single sign-on, `auth.sso_exemption_used` beside it: the device reaches the organisation only by the owner exemption for as long as it lives. |
| `POST` | `/api/cli/token` | Public — the caller holds no credential yet. Body `{ code, codeVerifier }`. The code is consumed atomically **before** the PKCE check, so a failed binding kills it rather than leaving it guessable. Membership is re-checked; the minted `xct_` token is returned exactly once, carrying the approving session's sign-in method and single-sign-on organisation, so an organisation's `sso_required` judges it as it judged that session. Every failure is the same fixed 401. Rate limited: `RL_CLI_TOKEN` by IP. Audited as `token.created`. |
| `DELETE` | `/api/cli/token` | The token revokes itself — `xecret logout`. CLI-token bearers only; idempotent; audited as `token.revoked` by the call that actually did it. |

Listing and revoking CLI tokens from the dashboard ("your devices") is the token
management routes below.

### Members, invitations, grants

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/orgs/{orgSlug}/members` | `member.read`, which every active role holds. Names, emails, roles (and the custom role narrowing each, by id, name and base — never its action list or ceiling), status, join dates, and the seat count — never access grants, which are per-project and belong on the member's own page. |
| `POST` | `/api/orgs/{orgSlug}/members` | Invite by email. Session + CSRF only — an invitation is a minted credential, and a bearer credential may not mint further credentials (same rule as `/api/cli/authorize`). Requires `member.invite` **and** the role hierarchy: nobody hands out a role above their own. Supersedes any open invitation for the address; enforces the seat limit under the organisation lock. Returns the acceptance link **once**; only the token's hash is stored. Rate limited: `RL_INVITE` by org. Audited as `member.invited`. |
| `PATCH` | `/api/orgs/{orgSlug}/members/{memberId}` | Exactly one of `{ role }`, `{ status: active\|suspended }` or `{ customRoleId: uuid\|null }` per request — they are different acts with different audit records (`member.role_changed`, `member.suspended`, `member.reinstated`, `member.custom_role_changed`). Requires `member.update`, the role hierarchy on *both* sides (the role held and the role assigned), refuses self-changes, and the repository transaction enforces the last-owner invariant under the organisation lock. Every authority check runs inside that transaction, on the member as the lock finds them — role, status, custom role and grant rows — so a concurrent change to their custom role cannot leave a stale read deciding; `DELETE` likewise. For a custom-role change: their stored role must be within the caller's authority (`roleWithinAuthority`), and a change that widens them — `null` (unassigning) or a swap to a role with more actions or a higher ceiling — also needs every grant row they hold to be within it (`heldGrantsWithinAuthority`). Putting a member on a role is plan-gated (`customRoles`, Enterprise); taking them off never is. Asking for the role the member already holds (or for none when they hold none) writes and records nothing and asks the plan nothing, but is decided like the change: a caller who could not make it gets the same **403** and `denied` record. An owner cannot hold one: **409**. Another organisation's role: **404**. |
| `DELETE` | `/api/orgs/{orgSlug}/members/{memberId}` | Requires `member.remove` and the role hierarchy; refuses self-removal; last-owner guarded. Grants die with the membership (`ON DELETE CASCADE`). A removal record stays behind (`org_member_removals`, with who removed them), so the organisation's single sign-on cannot quietly re-admit them through a just-in-time join; accepting a new invitation clears it. Audited as `member.removed`. |
| `PUT` `DELETE` | `/api/orgs/{orgSlug}/members/{memberId}/grants` | Create/replace or remove one grant, addressed by `{ projectSlug, environmentSlug?, accessLevel }` — `environmentSlug` absent or `null` means the whole project. Requires `member.update` + the hierarchy on the member being granted; the level written must be one the caller holds where it lands, and a removal must not raise the member past what the caller holds (they fall back to what the row overrode). Nobody but an owner edits their own grants. Like the member `PATCH`, every check on the member runs inside the repository's transaction, on the member — role, status, custom role and grant rows — as the organisation lock finds them; the route's own read decides only that the member exists and whether they are the caller. Audited as `access.granted` / `access.revoked` with the previous level, as the write found it, and the new one. |
| `GET` | `/api/orgs/{orgSlug}/members/{memberId}/access` | The effective-permission preview: every project and environment with the member's resolved level and the rule that produced it (`environment-grant` / `project-grant` / `role-default` / `suspended`). Computed by the same `resolveAccessLevel` the enforcement path calls, so it cannot disagree with it. Own row: any member. Someone else's: `member.update`. |
| `GET` | `/api/orgs/{orgSlug}/projects/{projectSlug}/members` | The transpose of the row above: every member with their resolved level in each of *this project's* environments, plus the grant rows they hold on it. Requires `member.update` — it is the same grant topology, sliced by project instead of by person, so it is refused to anyone who could not change it. Three queries whatever the organisation's size, which is what makes a project's member dialog one request rather than one per member. Not paginated: one page at the repository's ceiling, with `hasMore` saying when that was not everybody so the dialog can say so too rather than present a truncated roster as the whole answer. |
| `GET` | `/api/orgs/{orgSlug}/authority` | Per environment, the highest level the caller could grant there (`grantableAccessLevel`). What the grant and invite dialogs draw their level controls from, so they never offer a level the grant routes would refuse. The rest of the caller's authority — effective role, capabilities, assignable roles, definable bases — comes with the session, from `GET /api/auth/me`. `member.read`. |
| `GET` | `/api/orgs/{orgSlug}/invitations` | Open invitations, expired ones included (`state` says which). Gated on `member.invite`: who has been *asked* is recruitment metadata, not membership. |
| `DELETE` | `/api/orgs/{orgSlug}/invitations/{invitationId}` | Withdraws an open invitation; the emailed link stops working at commit. `member.invite`; audited as `invitation.revoked`. |

### Custom roles

Enterprise only (`customRoles`). A custom role narrows a built-in role and can never widen the
member who holds it; see database-schema.md §6. Every mutation is session + CSRF only,
rate limited `RL_MUTATION`, and requires `member.update`. The checks that decide whether a change
is within the caller's authority run inside the repository's transaction, on the role and its
holders (or the member) as read under the organisation lock, before anything is written.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/orgs/{orgSlug}/roles` | Every role with its `holderCount`, and `feature: { enabled, upgradeTo }` saying whether the plan lets this organisation define and assign them. `member.update`. Never plan-gated, so an organisation that left Enterprise can still see what it defined. |
| `POST` | `/api/orgs/{orgSlug}/roles` | Body `{ name, baseRole: admin\|developer\|viewer, allowedActions, accessCeiling?: { nonProduction, production } \| null }`. The name is normalised — variation selectors dropped, runs of spaces of any width made one space, NFC, trimmed — and refused (**422**) if it holds control, formatting or invisible characters (`Default_Ignorable_Code_Point`, the Braille blank), nothing visible, a built-in role's name or a lookalike of one, or Latin letters mixed with Cyrillic or Greek ones. `owner` as a base is a **422**, and so is a list naming an action the base could never perform. Plan-gated (`plan_limit`, audited as `role.created` with reason `quotaExceeded`); then `canDefineCustomRole`: the caller holds no custom role and the base is not above their own role. A name another role holds as a reader would see it — the same skeleton (`customRoleNameSkeleton`: case, width, lookalike Cyrillic and Greek letters and Latin accents folded) — is **409** with `fields: [{ field: 'name' }]`. Checked against every name the organisation holds, read under the organisation lock, since no database index can compare skeletons; the case-sensitive unique constraint stays behind it. At most 100 roles per organisation. Audited as `role.created` with the whole definition. |
| `PATCH` | `/api/orgs/{orgSlug}/roles/{roleId}` | Any of the create fields, merged onto the role as locked. A merge that changes nothing (`member.read` counts as listed either way) writes nothing, records no success and asks the plan nothing — but is measured against the caller exactly as a change would be, so one who could not make it gets the same **403** and `denied` record rather than a 200. Otherwise plan-gated. `canDefineCustomRole` for the base being replaced **and** the new one; `roleWithinAuthority` for every holder's stored role; and, for every holder the edit widens (a capability gained, a ceiling or default raised), `heldGrantsWithinAuthority` over the grant rows they hold. Holders of every status count. Audited as `role.updated` with the definition before and after and a `holderCount`; the holders' environment keys are reconciled unless only the name changed — each on their own, so one that fails is logged with the holder's member and user ids, recorded as a `role.updated` `error` naming them (`targetEmail`), and the saved role still answers 200. |
| `DELETE` | `/api/orgs/{orgSlug}/roles/{roleId}` | Only a role nobody holds: the member foreign key refuses the rest (SQLSTATE 23503), answered **409** "move its members off first". The definer check on the role's base. Not plan-gated. Audited as `role.deleted` with the definition that went. |

Every refusal these routes understood is recorded — a denial as `denied`; a plan refusal, a list
naming actions beyond the base, a taken name, a conflict or a missing role as `error` — naming the
role attempted. So is a key reconciliation that failed after an edit was saved, as an `error`
naming the holder it failed for. A body the schema refuses (malformed JSON, a missing field, a name with control
characters) is answered 422 and not recorded: it is a request nobody could have meant, and its
contents would put an attacker's string in the audit table.

**Every membership mutation above reconciles the member's environment keys.** Gaining access
queues a key share (`envkey.grant_pending`); losing it deletes their grants and leaves the
environment owing a rotation (`envkey.grant_revoked`). One reconciliation rather than a branch
per act, because the acts compose: a role change can widen access on one environment and narrow
it on another in a single request.

`POST /api/orgs/{orgSlug}/members` additionally accepts `invitePublicKey` — the invitation's own
X25519 public key, derived by the inviter's client from a 16-byte fragment (crypto spec §10).
**The fragment never appears in this body or any other.** It travels to the invitee out of band,
over a different channel from the emailed link, which is the whole of the two-channel design: a
leaked email decrypts nothing, and a leaked fragment authenticates nothing.

The invitation's sealed grants are uploaded afterwards, one environment at a time, through
`POST …/environments/{envSlug}/keys/grants` with `recipientKind: "invite"`. They are *not*
accepted on the invitation body, and the reason is not tidiness: a grant names its recipient,
never its resource, so a batch posted there would carry no unambiguous statement of which
environment each belongs to — and filing a key under the wrong environment produces a row that
looks exactly like a working grant until somebody tries to use it. The per-environment route has
the environment in its path.

### Accepting an invitation

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/invitations/lookup` | Public — the holder may have no account yet. Body `{ token }`. Returns the organisation's display name, the invited address, role, state and expiry; nothing else. The token travels in the body, never the query string. Rate limited: `RL_INVITE` by IP. |
| `POST` | `/api/invitations/accept` | Session + CSRF. Body `{ token }`. The session's address must match the invited one — a forwarded email must not let a colleague join as somebody else. State, address, seat count and the membership insert are all settled inside one transaction under the organisation lock — and so is `sso_required`: an organisation that requires single sign-on is joined only from a session that came through it (**403** `sso_required` otherwise; an invitation to be an owner is exempt), the one write into an organisation that does not pass through `resolveOrg`. Accepting clears the removal record the person had there only when the invitation was sent after the removal — one from before is a leftover, not a decision to have them back (review round 2) — and an owner's invitation accepted past `sso_required` is filed `auth.sso_exemption_used` too. Audited as `member.joined`. Acceptance then reconciles the new member's environment keys, which queues a share for every `e2ee` environment they can now read — including ones the invitation carried sealed grants for, because those are sealed to the invite keypair rather than to the invitee's own, and they hold no member grant until they re-seal. |

The acceptance response carries the invitation's own sealed grants, **read-only**:

```jsonc
{
  "organization": { "name": "…", "slug": "…" },
  "role": "developer",
  "invitationId": "…",
  "inviteKeyGrants": [
    { "environmentId": "…", "projectSlug": "…", "environmentSlug": "…",
      "envDataKeyId": "…", "edkVersion": 3, "edkSealed": "xk2.x25519.…",
      "ehkSealed": "xk2.x25519.…" }
  ]
}
```

**Why serving these to a session discloses nothing.** They are sealed to the invitation's one-off
X25519 public key, whose private half exists only inside the fragment that travelled by a second
channel (crypto spec §10). The session reading them cannot open one; only the fragment can, and
the fragment has never been near this server. What the session establishes is entitlement to
*attempt*, which is why the rows are scoped to invitations this account accepted and to nothing
else — the same standard `myGrant` is served under. `invitationId` travels with them because it
is the `recipientId` bound into each grant's AAD, and the lookup endpoint deliberately returns no
ids at all.

**They are not consumed here, and that is a reversal.** Acceptance used to delete them as it
served them, which bounded the window in which a leaked fragment was useful to the acceptance
itself. The argument is sound and the implementation destroyed the feature: an invitation link's
primary population is somebody who has just signed up, has no vault, and cannot re-seal anything
until they set one up — by which time the grants had been deleted by the response that showed
them. Consumption moved to the act that makes each row redundant; see `claimInvitationId` below.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/invitations/claimable` | Session. Every invitation **this account accepted** that still has unclaimed sealed grants, as `{ invitations: [{ invitationId, organization: { slug, name }, grants: [ … ] }] }` — the same grant shape as the acceptance response. Read-only; it consumes nothing, and it shrinks as grants are claimed. It exists because the second channel routinely arrives second: the link opens on a phone and the code is in an email on a laptop, and every one of those was a dead end while acceptance was the only moment the grants were served. Rate limited: `RL_INVITE`. |

The client's part is `openGrant` with the derived invite key, then `POST
…/environments/{envSlug}/keys/grants` with the same EDK and EHK re-sealed to their own public
key and signed with their own signing key, **naming the invitation in `claimInvitationId`**. It
is a **re-seal, never a copy**: the blob's AAD names `invite` and the invitation's id, so storing
it as a member grant would produce a row nobody can open.

`claimInvitationId` is what makes "the invitee holds their own grant" and "the invitation's copy
is gone" one committed fact. The server checks that the invitation belongs to this organisation
and was accepted by **this account** — a 403 otherwise, because a member holding an environment's
key could otherwise name a colleague's invitation and destroy grants they had not claimed yet —
and then deletes that invitation's grants *for that one environment* in the same transaction as
the insert. Per environment, so an invitee whose second environment fails to re-seal keeps its
row and can claim it later; idempotent, so a retry after a successful claim finds nothing to do.

If the re-seal never happens at all, the invitee holds no key — and the reconciliation performed
by the acceptance has already recorded exactly that as a pending share for a teammate to fulfil.
Both routes out of that state now stay open instead of one closing itself immediately.

### Organisations

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/orgs` | The caller's memberships. No `authorize()` call: the answer *is* the set of organisations they hold an active membership in, established in SQL. Refused for a service token, which is pinned to one organisation and has no switcher. |
| `GET` | `/api/orgs/availability?slug=` | Is an organisation slug free? Returns `{ slug, available, reason?: invalid\|reserved\|taken }` — one bit and a category, never who holds it. The categories come from `checkSlug` in `@xecret/core/validation`, the same function `organizationSlugSchema` is built from, so this route cannot report a slug as available that `POST` would reject. Browser session only — the same rule as `POST /api/orgs` and `DELETE /api/orgs/{orgSlug}`, because a leaked CLI token would otherwise be able to enumerate the global namespace — and rate limited on `RL_SLUG_CHECK`. A **snapshot, not a reservation**: the unique index settles the race, and `POST` still answers 409. `availability` is a reserved slug, so no organisation can shadow this route. |
| `POST` | `/api/orgs` | Body `{ name, slug? }`. `name` is at most `ORGANIZATION_NAME_MAX_LENGTH` (25) characters — shorter than a project name, because it is rendered in the sidebar switcher and every breadcrumb. `slug` is what the dashboard always sends, having shown it to the user and checked it; it is claimed **exactly**, and a collision is a 409 on the `slug` field rather than a silent `acme-2`. Omitted, the slug is derived from the name and uniquified — the path sign-up and API clients take, where there is nobody to ask. Session + CSRF only: a CLI token acts as its user for secrets, not for existence. Provisions the organisation, the caller's owner membership and the Org Master Key in one transaction — an organisation without that key cannot hold a secret and cannot be repaired. It seeds **no project**: an environment's keys are sealed to a public key this server has never seen, and at sign-up there is no vault to seal to, so the first project is created from an unlocked browser by `POST …/projects`. Rate limited: `RL_MUTATION` by user, and capped at `ORGANIZATIONS_PER_ACCOUNT_LIMIT` (10) — counted as the live organisations the account created **and is still an active member of**, so being removed from one releases the place and being made an owner of somebody else's spends nothing. A rate limit bounds the cost per minute, and this endpoint also spends something no deletion returns, since a claimed slug leaves the shared namespace permanently. The count and the refusal happen inside the provisioning transaction, behind a `SELECT … FOR UPDATE` on the account row, so concurrent creations from one account queue rather than race past the ceiling. Over the cap the answer is 409. Audited as `org.created` — the refusal too, with `reason: quotaExceeded`, filed against an organisation the account is a member of, or not at all when it is in none. |
| `GET` | `/api/orgs/{orgSlug}` | `member.read`, which every active role holds. |
| `PATCH` | `/api/orgs/{orgSlug}` | The name only, under the same 25-character ceiling as creation. `assertSlugImmutable` refuses a slug change with an explanation rather than ignoring it. Requires `org.update`. Audited as `org.updated`. |
| `DELETE` | `/api/orgs/{orgSlug}` | Soft delete. Requires `org.delete` — owners only, the one action an admin is denied — a browser session, and `{ "confirm": "<orgSlug>" }`. Everything inside stops resolving at once, for every member, because each read joins back through `organizations` with a `deleted_at is null` filter. Audited as `org.deleted`; an unconfirmed attempt is recorded too. |

### Single sign-on

An organisation's enterprise SSO, through WorkOS: SAML or OIDC connections to the company's own
identity provider, set up self-serve in WorkOS's Admin Portal. Every route is a **browser session
only** (a CLI token is refused with 403 before the organisation is resolved), and every mutation
is CSRF-checked and rate limited `RL_MUTATION` by user. Two capabilities, through `can()`:

- **`org.update`** (owners and admins; a custom role that took it away is refused too) to *read*
  the settings and to switch a policy **off**.
- **`sso.manage`** (**owners only**, and no custom role can carry it — none is based on `owner`)
  to turn SSO on, mint a portal link, or switch either policy **on**. Whoever does those decides
  which identity provider vouches for every member, owners included, so an admin who could
  would be an admin able to sign in as an owner.

Anything that switches something **on** also needs the single sign-on add-on (`samlSso`, set by
the operator tool): every connection is a paid WorkOS connection from the moment it exists, and
the add-on is what bounds who can attach an identity provider at all. Reading, and switching a
policy off, never need it. A link made in a **different WorkOS environment** from this
deployment's (`organizations.workos_client_id` against `WORKOS_CLIENT_ID` — local development
runs against WorkOS Staging over the production database) is refused with a **409** by the read,
the enable, the portal and every switch-on; switching a policy off still works. A WorkOS call
that fails is a **503** that says nothing was changed and to try again when WorkOS could not be
asked (or a **429** for its rate limit), and a **502** `upstream_refused` naming WorkOS's own
error category when WorkOS answered and refused — a configuration problem, which trying again
does not fix. All four answer with the same status under `sso`:

```jsonc
{
  "sso": {
    "enabled": true,              // a WorkOS organisation exists and is linked
    "ssoRequired": false,
    "jitJoinEnabled": false,
    "seatLimit": 5,
    "addon": { "enabled": true },
    "connections": [{ "id": "conn_…", "type": "OktaSAML", "state": "active" }],  // null while off
    "domains": [{ "domain": "acme.example", "state": "verified" }],             // null while off
    "membersOutsideVerifiedDomains": 0, // non-owner members the IdP cannot sign in; null while unknown
    "providerReachable": true     // false: WorkOS did not answer for the two lists
  }
}
```

The WorkOS organisation id is never in a response. A connection state WorkOS adds later reads
as `inactive`, a domain state as `pending`; connections are read page by page (100 a page, at
most five pages).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/orgs/{orgSlug}/sso` | The status. `org.update`. While SSO is off it is answered from the row alone; once on, the connections (`sso.listConnections`) and domains (`organizations.getOrganization`) come from WorkOS — reused for 20 seconds per organisation, so a page reloaded in a loop does not spend the WorkOS rate limit the sign-in callback shares — and if WorkOS cannot be reached the lists are `null`, `providerReachable` is `false`, and the answer is still a 200. `membersOutsideVerifiedDomains` counts the active non-owner members whose address is not at a verified domain: the people requiring SSO would shut out. |
| `POST` | `/api/orgs/{orgSlug}/sso` | Turns SSO on. **Owners only** (`sso.manage`). Creates the WorkOS organisation (`createOrganization` with the organisation's name and its id as `externalId`, idempotency-keyed by that id) and links it with this deployment's WorkOS client id (`setOrgWorkosOrgId`, set once, never re-pointed). **No domains are sent — never `domainData`, verified or otherwise**: the callback believes an SSO sign-in only for domains WorkOS reports as verified, so domains are added and verified through WorkOS's own flow (the portal, by DNS) and nowhere else. **201** from the request whose write linked it, audited `org.sso.enabled`; **200** with the status and nothing created or recorded when already on — including the second of two concurrent enables, which the idempotency key handed the same WorkOS organisation (the setter reports whether it changed the row). A 409 from WorkOS on the `externalId` (an earlier attempt that never linked) adopts the organisation holding it. If another request linked a different WorkOS organisation first, the one this request created is deleted after the response and the winner's status returned. An organisation linked in another WorkOS environment is a **409**, never adopted. **And no link is written from a deployment whose WorkOS client id is not the one this database belongs to** (`workos_home`, migration 0023; review round 2) — a **409** saying so, and naming the operator step for a self-hosted database still holding the seeded client id (`UPDATE workos_home …`, `docs/self-hosting.md`), before WorkOS is asked anything, or, while no environment is recorded, a **409** naming the operator step; `setOrgWorkosOrgId` checks the same in its own `UPDATE`. Without the add-on, **403** `plan_limit` (recorded as an `error`, reason `quotaExceeded`, `addonName: saml`). |
| `POST` | `/api/orgs/{orgSlug}/sso/portal` | Mints a WorkOS Admin Portal link (`intent: sso`) returning to `/app/{orgSlug}/settings#single-sign-on`, as `{ link }` — an `https:` URL or a 502, never anything else. **Owners only** (`sso.manage`), from the WorkOS environment the database belongs to (`workos_home`, **409** otherwise), and only for a session that **signed in again within the last ten minutes** — the session's own record of a fresh authentication during `/api/auth/login?reauth=1`, by any method that re-proves the person, an emailed code included (`sessions.fresh_auth_at`, dated by WorkOS's `auth_time`; review round 2 — round 1 borrowed the vault reset's lock one, which refuses an emailed code), read and never spent: otherwise a **403** `reauth_required`, which the dashboard answers with a "Sign in again" link. The link is credential-grade for its few minutes (whoever opens it decides which identity provider vouches for the organisation's members), so it is never logged or stored, every one is audited `org.sso.portal_link_created`, and the dashboard never navigates its own tab to it. **409** before SSO is on. |
| `PATCH` | `/api/orgs/{orgSlug}/sso` | Body `{ ssoRequired?: boolean, jitJoinEnabled?: boolean }`, at least one, strict (a string or a misspelt field is a **422**). Switching either **off** needs `org.update` and is always allowed, from any deployment. Switching either **on** needs `sso.manage` (owners), SSO on in this WorkOS environment (**409** otherwise), the WorkOS environment the database belongs to (`workos_home`, **409** otherwise — a requirement switched on from another environment's deployment could be one nobody here can satisfy) and the add-on; switching `ssoRequired` on also needs an **active** connection *and* at least one **verified domain** at WorkOS, asked of WorkOS itself and never of the cached lists (**409** otherwise — a requirement nobody can meet would leave only owners able to sign in; **503** when WorkOS cannot say). The gates apply to what is **asked for**, whatever the row held before the write's lock — a request for "on" passes the gates for "on" every time. Written by `updateOrgSsoSettings` under the organisation's row lock; each switch that moved is audited — `org.sso.required_toggled` / `org.sso.jit_toggled` with `enabled: <new value>` — and one already where it was asked to be records nothing. Answers the status and, while `ssoRequired` is on, `nonSsoAccess: { sessions, cliTokens }` — the live credentials of non-owner members that did not come through this organisation's SSO, each of which loses the organisation on its next request (CLI tokens counted whichever organisation they were approved in: a CLI token acts as its user in all of theirs) — or `null`. |

**What `sso_required` does.** It is enforced **on every request** that reaches the
organisation: `resolveOrg` refuses a non-owner member whose session — or the browser session
that approved their CLI token — did not come through this organisation's own single sign-on
(`sessions.sso_workos_org_id`, `cli_tokens.sso_workos_org_id`, migration 0022), with a **403**
`sso_required` answered only once the membership is established (a stranger still gets 404).
Switching it on therefore takes this organisation from every such credential at once — nothing
is revoked; they stop reaching here, and keep every other organisation their holder belongs to.
A credential issued before migration 0022 recorded nothing and counts as not single sign-on.
The two writes into an organisation that do not pass through `resolveOrg` are held to it too:
accepting an invitation (`acceptInvitation`, under the organisation lock; an invitation to be an
owner is exempt) and approving a CLI device (`resolveOrg` in front of it, and the token inherits
the approving session's facts). **Owners are exempt** everywhere, as a deliberate break-glass —
an identity provider misconfigured after the switch would otherwise lock the organisation out of
itself — and that is a trade-off, not a free one: an owner's password stays a way into the
organisation its identity provider does not govern. Every credential made with the exemption
is audited as `auth.sso_exemption_used` in the organisation it bypassed: a sign-in (in each
exempting organisation), an owner approving a CLI device from a non-SSO session, and an owner's
invitation accepted from one (review round 2). A credential that already existed when the
requirement went on is not re-audited each request. What the requirement and the opt-in do at
sign-in is steps 8, 9 and 12 of *The callback, in order*. The dashboard answers `sso_required`
with the organisation's own SSO sign-in (`/api/auth/login?org=<slug>`, back to the page) rather
than a failed load, and `/api/auth/me` says ahead of time which organisations will answer it; the
CLI says to run `xecret login` again through the organisation's single sign-on.
Every refusal these routes understood is recorded against the organisation: a role refusal as
`denied` (a `PATCH` names both switches, since its body is not read first), a missing add-on, a
precondition or a WorkOS failure (`upstreamUnavailable`) as `error`.

### Projects

| Method | Path |
|---|---|
| `GET` `POST` | `/api/orgs/{orgSlug}/projects` |
| `GET` `PATCH` `DELETE` | `/api/orgs/{orgSlug}/projects/{projectSlug}` |

**A project arrives with its three default environments, and every one of them is end-to-end
encrypted** — so `POST` carries the key hierarchy for all three:
`{ name, slug?, description?, environments: [{ slug, id, keys: { grant } }] }`. Each entry's
`slug` names *which* default it is for, and nothing more: `DEFAULT_ENVIRONMENTS` owns the name,
the sort order and the production flag, because that flag decides who may read the environment
and is not a client's to choose. The set is checked against the defaults **exactly** — a missing
entry, a surplus one and a duplicate are all 400s that name what is wrong — and `id` is required
rather than optional, because the grant's AAD names the environment (spec §4.2) and a row written
under a server-minted id would hold a grant nobody could ever open.

Like `POST …/environments`, this needs a **browser session with an unlocked vault**, and is
refused for a CLI or service token with a 403 rather than a validation error about a field it
could never have produced. Not because a token holds no key material — a CLI token receives its
issuing user's vault material, signing key included — but because no non-browser client
implements *sealing*: the Go CLI opens grants and encodes secrets, and produces no grants at all.
A caller with no vault gets a 400 telling them to set one up. **The first grant must be the
creator's own**, for the reason the *Environments* section gives.

`DELETE` is a soft delete. A hard delete would orphan the audit records that say the project
existed and who removed it.

### Environments

| Method | Path |
|---|---|
| `GET` `POST` | `…/projects/{projectSlug}/environments` |
| `GET` `PATCH` `DELETE` | `…/environments/{envSlug}` |

**Every environment created from Phase 3 onward is end-to-end encrypted.** `POST` therefore
requires the client-generated key hierarchy alongside the name:
`{ id, name, slug?, isProduction?, sortOrder?, keys: { grant } }`, where `grant` is the EDK and
the EHK sealed to the creator's own public key and signed by their signing key (see *Environment
keys* below for the shape). There is **no `encryptionMode` field**, and there must not be:
`server` mode is a migration state, not a choice, and offering it as one would let a client opt
an environment out of end-to-end encryption for the life of that environment.

**The first grant must be the creator's own** — `recipientKind: "member"` with `recipientId`
equal to the caller's user id — and is refused otherwise, exactly as `POST …/environments/{envSlug}/keys`
refuses it on the repair path. At creation there is one public key the caller could honestly have
sealed to, and anything else was either fabricated or sealed to a key they had no business using.
The check is not redundant with the foreign keys: those establish that a principal *exists*, not
that it belongs to this tenant, so without it this route would seal an organisation's brand-new
key to a member of another one, to a service token scoped elsewhere, or to an invitation nobody
here issued — before any grant of it could be read, revoked, or noticed.

**`id` is chosen by the client**, and is required beside `keys`. The creator's grant is sealed in
a browser *before* this request exists, and the grant's AAD names the environment (crypto spec
§4.2) — so a row created under a server-minted id would hold a grant nobody could ever open.
Unlike every other broken state in this system there is no repair: the key bytes existed only in
that browser. The uniqueness of the id is settled by the primary key, exactly as the uniqueness
of the slug is settled by its index.

The environment row, the `env_data_keys` row, the `env_hmac_keys` row and the creator's grant
land in **one transaction**. That mattered before and matters more now: a `server`-mode
environment created without its key needs an operator holding the Root KEK to repair, while an
`e2ee` one created without its keys **cannot be repaired at all** — the bytes existed only in a
browser that has since navigated away.

**A service or CLI token cannot create an environment.** Producing the grant means sealing to a
public key and signing with a private one, and a bearer credential has neither: it holds no
vault. The refusal is a `bad_request` naming what is missing, not a `forbidden`, because nothing
about the caller's permissions is wrong — they are holding the wrong kind of credential. A user
who has not completed the vault ceremony is refused for the same reason and told to run it.

The environment payload carries `encryptionMode`, and every client has to branch on it: the
body a secret write takes, whether a reveal returns a plaintext, and whether an export can be
requested at all all depend on it. A client that had to *discover* the mode by sending the
wrong body and reading the error would put a plaintext credential in a request to an e2ee
environment exactly once, which is once too many.

**Mode continuity.** Nothing authenticates that field — it is a column, not a signed statement,
and no key is bound to it — so a client that simply believes a `server` answer for an
environment that was `e2ee` starts sending values in the clear. Clients therefore pin the mode
on first sighting and **refuse** the `e2ee` → `server` transition outright, with no in-band
override; the `server` → `e2ee` direction pins forward and is never refused, because it takes
capability away from the server. The dashboard files pins by slug path in local storage, the CLI
beside its offline cache, and a service token carrying a key half is its own pin. This is a
client-side property with a first-contact hole, stated as such in ADR 0009, trade-off 8;
accepting a genuine migration back is a deliberate manual act (clear site data, or
`xecret cache clear`) taken after asking whoever runs the deployment.

### Environment keys

| Method | Path | Notes |
|---|---|---|
| `GET` | `…/environments/{envSlug}/keys` | The caller's own grant, the active key, and the administrative state. `secret.read`. Rate limited on the read bucket — `RL_SECRET_READ`, or `RL_SERVICE` for a token — through the same helper reveal and pull use. |
| `POST` | `…/environments/{envSlug}/keys` | Initialise, for an `e2ee` environment that somehow has none. Body `{ grant }`. `environment.update`. A second call is a **409**. |
| `POST` | `…/environments/{envSlug}/keys/rotate` | Body `{ newVersion, grants: [...] }` — the **complete** replacement set. `environment.update`. |
| `GET` | `…/environments/{envSlug}/keys/recipients` | Who a grant may be sealed to, and who already holds one. `secret.read`. |
| `POST` | `…/environments/{envSlug}/keys/grants` | Body `{ envDataKeyId, grants: [...], claimInvitationId? }`. Hands the key to principals that did not have it. `secret.read`. A `envDataKeyId` that is not the environment's active key is a **409 naming both versions** — the one the grants were sealed for and the one that is now active — so a client can re-read, re-seal and retry rather than reporting a failure to somebody who did nothing wrong. `claimInvitationId` consumes that invitation's sealed grants for this environment in the same transaction; see the acceptance section. |
| `DELETE` | `…/environments/{envSlug}/keys/grants/{grantId}` | Removes one grant. `environment.update`. |

**A rotation only takes access away from a principal that reaches this API.** The CLI's offline
cache holds a bundle sealed under the grant a rotation replaced, so it refuses to serve one older
than seven days by default (`--max-cache-age`, `XECRET_CACHE_MAX_AGE`); raising that bound defers
the revocation by exactly as much, and the CLI says so in those words when it does. ADR 0009
records the residual as trade-off 8f.

A grant is `{ recipientKind: "member" | "token" | "invite", recipientId, recipientPublicKey,
edkSealed, ehkSealed, signature }`. The blobs are `xk2.x25519.` sealed boxes and an `xk2.ed25519.` signature (crypto
spec §§2, 5, 6). **The server validates shape, never meaning**: prefix, alphabet and length, and
then it stores what it is given. It holds no key with which it could do more, and a validator
that opened a grant would be the first line of the code path ADR 0009 exists to make
impossible.

`recipientKind`, `recipientId` and `recipientPublicKey` travel in the body rather than being
inferred, because all three are **signed** (spec §6.1) — so a server cannot relabel a
service-token grant as a member grant or move a valid grant between principals. Accepting them
as fields, and storing them into the columns the signature names, is what makes that guarantee
reachable when verification is later enabled.

`recipientPublicKey` in particular is stored rather than looked up, and the reason is not
convenience. Every other source for it is mutable: a vault reset replaces
`user_keys.enc_public_key`, and an invitation's key is deleted at acceptance. A verifier that
joined to those tables would recompute a different payload for every honest grant written before
either event and report it as forged — and it would be taking the one field the signature exists
to pin *against the server* from a column the server writes.

`GET` answers:

```jsonc
{
  "keys": {
    "encryptionMode": "e2ee",
    "environmentId": "…",
    "activeEdk": { "id": "…", "version": 3 },
    "myGrant": { "recipientPublicKey": "…", "edkSealed": "xk2.x25519.…", "ehkSealed": "…",
                 "signature": "…", "signedByUserId": "…" },
    "ehkExists": true,
    "pendingGrants": [ … ],          // admins only; null for anyone else
    "needsRotation": false,          // admins only; null means "not computed for you"
    "missingGrants": [ { "kind": "member", "id": "…" } ],   // admins only; null for anyone else
    "currentMaxSecretVersion": 41
  }
}
```

**`environmentId`** is published here and nowhere else in the environment payloads, and it is
not a convenience: **every** AAD a client builds names it (crypto spec §4.2) — the two grant
purposes, the secret value, the encrypted note. A client that could not learn it could not open
the grant it was just handed, could not encrypt a value, and could not tell a decryption failure
from a missing identifier. `EnvironmentPayload` goes on addressing environments by slug, which
is right for a URL; this is the cryptographic identity of the row, served on the one endpoint
whose job is handing a client its key material.

**`needsRotation`** is the honest name for "somebody's grant was deleted and the key they held
has not been replaced". Deleting a grant stops a principal being handed the key *again*; only a
rotation stops the copy they already have from opening what is written next. Until one lands
with a version bump the revocation is on paper, and this field is how a dashboard says so
rather than letting an administrator believe an act completed that did not. It is **derived**
from the rows, never stored, so it cannot drift from the grants it describes. A revoked or
expired service token still holding a grant on the active key counts here too: whoever held its
token string may have fetched the key while it authenticated, so the environment is not actually
safe from it until the key is replaced.

**`missingGrants` is the same comparison in the other direction**, and until it existed nothing
in the product reported that direction at all. A principal entitled to an environment who holds
no grant on its active key can list every secret name and decrypt none of them — the state a
vault reset produces for every environment at once, and the state an acceptance leaves behind
when the re-seal never lands. It is not a duplicate of `pendingGrants`: that is a queue of
*requests*, written when somebody changed an access level, whereas this is derived from the
grants themselves and is therefore still right when the request was never recorded or was
deleted by a path that should not have deleted it. One is intent; the other is state.

**Both are `null` for a caller who cannot act on them, and `null` is not `false`.** They name
other people, so they are administrative on the same terms as `pendingGrants`. They are also the
only part of this payload whose cost is proportional to the organisation — deciding them reads
the active roster and its access grants — and the caller who would pay for that on the hottest
path in the product, `POST …/pull` on every `xecret run` and every CI job, is exactly the caller
who can do nothing with the answer. A client must treat `null` as "unknown" and render nothing,
never as a reassurance.

**`currentMaxSecretVersion`** is freshness groundwork and nothing more. ADR 0009 records
rollback as an accepted residual risk — a server can serve stale grants or omit recent
`secret_versions`, and signatures do not help because they prove origin rather than recency.
Returning it on every key read means a client-side monotonic counter can be added later without
an API change. **Nothing on the server enforces it**; a compromised server would report a lower
number.

**`pendingGrants` is served only to callers who can act on it.** It names other people, and a
developer learning that three teammates are waiting for production keys learns the shape of the
team's access without holding any authority over it.

#### Rotation completeness — the one thing the server checks

The client generates the new key and seals it, because only the client can. But that means the
client also chooses who receives it, and a client that quietly omitted somebody would produce a
request that succeeds and **silently revokes a colleague**: they keep read access, keep seeing
every secret name, and simply cannot decrypt anything written afterwards — a failure with no
error, no screen, and no audit record beyond a successful rotation.

So the server recomputes the required set from the authorization model and requires an exact
match:

- **Every active member** whose resolved level on this environment is at least `read`, decided
  by the same `can()` every request goes through — so the key set and the access model cannot
  disagree.
- **Every service token** pinned to this environment that is live — not revoked, not expired —
  and still has a `public_key`. The expiry predicate is the one `findServiceTokenByHash`
  authenticates with, and the two agreeing is the point: a token that stopped working in March
  would otherwise stay *required* in every rotation afterwards, failing each one with "Missing a
  grant for token:…" and naming a credential nobody thinks to revoke because it already stopped
  working. Tokens minted before the Phase 4 creation flow have no keypair at all, so there is
  nothing to seal to. A dead token's existing grant is left alone rather than deleted — it opens
  the history that token could already read and nothing written since — and it makes
  `needsRotation` true until the rotation that omits it lands.
- **Invitations are permitted but never required.** Their grants are sealed to a one-off keypair
  whose private half exists only in a fragment the server has never seen, so nobody rotating can
  re-seal to them. Permitted is not unchecked: every `invite` grant in a rotation goes through
  the same eligibility check `POST …/keys/grants` applies — this organisation's invitation, still
  open, and one whose `initial_grants` will actually confer access to this environment.

Both directions are refused, and the second matters as much: an **extra** grant is a key handed
to somebody the access model does not permit, minted through the one endpoint whose job is
writing grants in bulk. Without the check, a rotation would be a way to give a viewer production
keys while the audit log recorded routine maintenance.

**The check runs inside the rotation's transaction, under the organisation's write lock.** It
used to run before it, and the gap was long enough for a concurrent member removal to land: the
rotation then wrote the set it had already validated, sealing the brand-new key to the person the
removal was cutting off — with a `200`, an `envkey.rotated` record, and nothing anywhere saying
the revocation had not taken. The lock is the organisation row rather than the environment,
because "who must hold this key" is a question about the set of members and their access grants,
and no environment row is touched when somebody is removed or has a grant revoked. Membership
changes and access-grant changes take the same lock, so the three queue in one order.

A rotation settles only the queued key shares it actually paid — the members its grant set
names. Clearing every pending row for the environment would erase a debt recorded *after* the
completeness check ran, leaving that person with no grant, no banner entry, and no explanation.

The refusal is a `422` naming the principals that are missing or surplus. That is a deliberate
exception to §3's rule against echoing request content: the ids are ones the caller already
holds, and the alternative — "your grant set is wrong", against a set of forty — gives a client
no way to correct it except to re-derive everything and hope.

`newVersion` is supplied by the client rather than computed here, because every grant has
already been sealed with that number bound into its AAD (spec §4.2). If the server assigned it,
a rotation racing another would produce grants whose AAD names version 4 stored against a row
numbered 5 — every one of which would fail to open, for ever, with no error at write time. A
mismatch is a `409` the client retries after re-reading.

#### The sealing directory — `GET …/keys/recipients`

Every other route under `…/keys` *consumes* a grant set, and none of them could produce one.
Sealing is asymmetric: a grant for somebody is built from **their** X25519 public key, and a
browser had no way to learn one. Rotation, the queued key shares and an admin widening access
were therefore not merely awkward from a client — they were impossible to attempt. This is the
missing half.

```jsonc
{
  "activeEdk": { "id": "…", "version": 3 },
  "environmentId": "…",
  "recipients": [
    { "kind": "member", "id": "…", "publicKey": "…", "holdsGrant": true },
    { "kind": "token",  "id": "…", "publicKey": "…", "holdsGrant": false }
  ],
  "unsealable": [ { "kind": "member", "id": "…" } ]
}
```

`recipients` is exactly the set `POST …/keys/rotate` requires and nothing else — the same
computation `assertCompleteGrantSet` performs, served forwards instead of checked backwards.
`holdsGrant` is what turns a list into an instruction: a rotation seals to everybody, a share
seals only to those with `false`.

`unsealable` names entitled members who have not completed the vault ceremony and therefore have
no public key. Naming them is the difference between a rotation refused with a sentence somebody
can act on — *ask Dana to finish setting up her vault* — and one refused later by the
completeness check with a bare uuid.

The gate is **`secret.read`**, matching `POST …/keys/grants` exactly rather than the
`environment.update` that guards rotation. A directory gated more tightly than the write it
feeds would leave every queued share unfulfillable by the people who actually hold the key —
and that is not hypothetical, because the queue exists precisely for the case where whoever
*changed* the access does not hold it. What it discloses is "who may read this environment", to
somebody who may read it, plus public keys that are stored in the clear because they are public:
holding one lets its holder *give* a key away, never take one. `pendingGrants` on `GET …/keys`
stays admin-only on its own terms — it names people who are *waiting*, which is a statement
about an act somebody else performed.

Not audited: it produces no plaintext and changes nothing, and the acts it enables
(`envkey.granted`, `envkey.rotated`) are each recorded where they happen.

#### The pending key-share queue

Access is decided by people who may not hold the key. An owner can grant a developer access to
`production` without ever having opened it, and if they hold no grant their browser has no EDK
to seal. Refusing the access change would make authorization depend on who happens to hold which
key; granting it with no key would leave a member who can list every secret name and decrypt
none of them, with nothing anywhere saying why.

So the access change lands and a row records the debt, which the next unlocked member holding
that key fulfils through `POST …/keys/grants` — the grant and the queued row are written and
deleted in one transaction, so the banner cannot outlive the key it was asking for. Every
membership mutation (add, role change, grant change, suspend, reinstate, remove, invitation
acceptance) runs the same reconciliation, so an act nobody thought about is still handled.

Audit: `envkey.created`, `envkey.rotated`, `envkey.granted`, `envkey.grant_revoked`,
`envkey.grant_pending`. The last two both describe *partial* acts, and a partial act with no
record is how an administrator comes to believe something finished.

### Secrets

Every route below serves both encryption modes, and the mode is read from the environment row —
never from a request. `server` behaviour is unchanged, field for field.

| Method | Path | Notes |
|---|---|---|
| `GET` | `…/environments/{envSlug}/secrets` | **Masked.** Ids, names, versions, timestamps, updater, and `encNote` for `e2ee` rows. No value ciphertext leaves the database. |
| `POST` | `…/secrets` | Create. `server`: `{ name, value, note?, valueType? }`. `e2ee`: `{ id, name, value: { ciphertext, clientAlgorithm, envDataKeyId, valueHmac }, encNote?, valueType? }`. |
| `GET` | `…/secrets/{name}` | **Reveal.** `server` decrypts and returns `value`; `e2ee` returns `value: null` plus `id`, `ciphertext`, `clientAlgorithm` and `envDataKeyId`. Audited as `secret.revealed` in both. |
| `PATCH` | `…/secrets/{name}` | Appends a new version, same two body shapes. `e2ee` adds `expectedVersion`. A value identical to the current one is a no-op in **both** modes, detected via `value_hmac` without decrypting. |
| `PUT` | `…/secrets/{name}` | Metadata only — `{ name?, note?, encNote?, valueType? }`. Appends **no** version. Sending `note` to an `e2ee` environment, or `encNote` to a `server` one, is refused rather than ignored. |
| `DELETE` | `…/secrets/{name}` | Soft delete. |
| `GET` | `…/secrets/{name}/versions/{version}` | **Reveal one historical version.** In `e2ee` mode `envDataKeyId` may name a **retired** key — a version written before a rotation is still encrypted under the key that was active then. |
| `GET` | `…/secrets/{name}/versions` | History. Metadata only — no ciphertext, no values. |
| `POST` | `…/secrets/{name}/restore` | `server`: `{ version }`, and the Worker re-encrypts. `e2ee`: `{ version, expectedVersion, value: { … }, encNote? }` — the client reads the old version, decrypts it, encrypts the same plaintext for the version about to be written, and posts the result. The two numbers differ: `version` is restored *from*, `expectedVersion` is written *as*. |

**Why every `e2ee` secret carries an `id`.** `secrets.id` is an AAD component (crypto spec §4.2):
the ciphertext of a value is bound to it, and so is the encrypted note. A client that did not
have it could not decrypt a row it was handed, and — on a create — could not encrypt one at all,
because the identity of the row has to exist before the sealing does. So the **client mints the
uuid** on the `e2ee` create path and the server stores the row under it, exactly as it stores an
environment under the id its key grant was sealed against. The masked listing publishes `id` in
both modes rather than conditionally: a payload whose *shape* depends on the mode is a payload
two branches of a client have to agree about, and the id names a row the caller is already
reading.

**Every `e2ee` write states what it sealed against, and the server refuses rather than
substitutes.** `secretId` and `version` are both AAD components, both chosen in a client before
the request existed, and both re-derived here from stored rows. When the two disagree the row
would commit at the server's numbers carrying a ciphertext bound to the client's — undecryptable
for ever, by everybody, behind a `200`, with no operator able to repair it because no operator
holds the key. So `PATCH`, `POST …/restore` and every import entry carry `expectedVersion`, an
import entry carries the `id` it sealed against, and a mismatch is a **409** naming the secret.
Crypto spec §4.3 is the normative statement.

Two consequences worth stating plainly. An import entry that planned a *create* for a name that
already exists is **refused**, not quietly appended to the stored row — appending would produce
exactly the dead row the check exists to prevent. And a client that pages through the secret
listing MUST read every page before planning an import: the 409 is a backstop against a race,
while a plan built from the first page is a guaranteed collision for every name past it.

A no-op is exempt. When `value_hmac` matches, no ciphertext is stored, so nothing can be bound
wrongly and a re-submission is answered `unchanged` rather than refused.

**Why an `e2ee` restore carries a ciphertext.** A restore is a *re-encryption*, never a copy:
the AAD binds `version`, so bytes produced for version 3 and stored as version 7 would fail to
decrypt for the rest of their life, silently. In `server` mode the Worker performs it because it
holds the key; here it cannot, so the only party that can does. The server records which version
was restored *from*, and does not pretend to have verified that the ciphertext holds that
version's value.

**No value-type check in `e2ee` mode.** `checkSecretValue` inspects a plaintext, and this path
has none — the shape of a value is the client's to enforce, with the same
`@xecret/core/validation` module the dashboard already runs as you type. This is the one
guarantee the migration genuinely gives up, and pretending otherwise (by checking a
ciphertext's length, say) would be worse than conceding it. The declared type is still stored,
still inherited across a rotation, and still the rule the client applies.

The masked listing and the reveal endpoint are **separate routes on purpose**. Decryption
happens in exactly one handler, so "where can a plaintext secret be produced?" has a
one-line answer that a reviewer can verify by grep — and after ADR 0009 that answer is narrower
still: only the server half of `secrets-service.ts`, and only for environments that have not
migrated.

### Bulk read — the path `xecret run` depends on

| Method | Path |
|---|---|
| `GET` | `…/environments/{envSlug}/pull?format=env\|json\|yaml\|shell\|docker` |

In `server` mode: one environment, every current secret, decrypted server-side. Budget: **≤3
queries and 0 outgoing fetches**, constant in the number of secrets. Audited once per call as
`secret.read` with a count — not once per secret, which would make a 200-secret pull write
200 audit rows and turn the audit table into a denial-of-service surface against itself.

In `e2ee` mode the bundle is `{ bundle: true, bundleVersion: 1, encryptionMode: "e2ee",
keys: { … }, secrets: [ { name, ciphertext, clientAlgorithm, envDataKeyId, version, … } ] }`.
The **caller's grant travels with the values**, and that is not a convenience: fetching
`…/keys` and then `…/pull` would be two round trips on the hottest path in the product and would
open a window in which a rotation lands between them, leaving the client holding a key for one
version and ciphertext for another with nothing in either response saying so.

**The bundle says it is one.** `bundle: true` and `bundleVersion: 1` are what a client branches
on — not the presence of `encryptionMode`. The distinction is not pedantry: a `server`-mode pull
at `format=json` is a **flat object of the environment's own secret names**, so an environment
holding a secret called `encryptionMode` whose value is `e2ee` was read as a bundle by the CLI,
and every value in that document was then handed to a decryptor. A flat document's values are all
strings, so `true` closes it. Clients carry `bundleVersion` and do not yet refuse an unknown
value — the first build to see the field has to accept whatever it says, or the number can never
be raised. Clients written before the marker fall back to `encryptionMode: "e2ee"` *and*
`secrets` being a JSON array; that tolerance is removable once no supported deployment predates
the marker. A `server`-mode pull carries neither field.

**Five statements, not two** — the active key, the HMAC key, the environment's highest secret
version, the caller's own grant, and the `DISTINCT ON` that resolves the current version of each
secret. Every one of them is constant in the size of the environment *and of the organisation*.
It briefly was not: `needsRotation` was computed for every caller and walked the member roster
two queries at a time, putting an O(members) scan on `xecret run` and every CI job. That answer
is now computed only for a caller who can act on it — never a pull — and when it is computed the
roster is read in bulk rather than a member at a time.

`format` is not consulted in `e2ee` mode, and a caller who asks for one is not silently given
JSON — formatting takes plaintext, so it moves to the client with the decryption. A caller who
has access but no grant gets a **409 `no_key_grant`** rather than a 403: their permissions are
not the problem, and the request succeeds the moment somebody fulfils the queued share.

### Import / export

| Method | Path | Notes |
|---|---|---|
| `POST` | `…/environments/{envSlug}/import` | `server`: `{ content, format?, strategy, dryRun }`. `e2ee`: `{ entries: [{ id, name, value: { … }, encNote? }], dryRun }`. |
| `GET` | `…/environments/{envSlug}/export?format=…` | Same data as `pull`, as a file download. **`e2ee` returns 409 `client_side_only`.** |

The dry run and the real import call the **same** planning function, so the preview cannot
disagree with the outcome. In both modes `dryRun: true` runs every decision — including the
HMAC comparison that produces `unchanged` — and stops before the transaction.

**What moved in `e2ee` mode is the parsing.** A `server`-mode import receives a `.env` file and
parses it here, because parsing means reading the values and the Worker is allowed to. An
`e2ee` import receives the *outcome* — names and ciphertexts — because the same
`@xecret/core/importer` module runs in the browser and the CLI, and a file uploaded to be parsed
would be every secret in it, in plaintext, in a request body. The `skip`/`overwrite`/`rename`
strategy is applied client-side for the same reason: it is a decision about names, and names are
plaintext in both modes.

**A body that names one secret twice is a 400 naming it.** The `server` path cannot produce a
duplicate — the planner tracks the target names it has claimed, precisely so two source keys
cannot resolve to one secret — but the `e2ee` path receives the plan's output, so nothing
upstream has made that promise. Left unchecked, both entries resolved to the same stored row and
planned the same next version; the first append landed, the second carried a ciphertext bound to
a version already taken, and the whole transaction rolled back with *"This secret was changed by
another request"*. Nothing had changed it, the import wrote nothing, and the message sent people
hunting a concurrent editor who did not exist. Names are compared exactly, as the unique index
compares them.

**Export refuses rather than degrades.** Formatting takes plaintext, and the client already
holds every value — it decrypted them to show them — so the download is one it can build itself
with `@xecret/core/format` compiled for the browser. The `client_side_only` marker is stable so
a client can branch on it rather than on prose.

### Paid secret features (P19)

Every one of these is end-to-end-encrypted-only (`409 e2ee_required:` otherwise), and every plan
gate is on the act that turns something **on** — never on a read, and never on undoing it. A plan
refusal is `403 plan_limit` with `upgradeTo`, audited as `error` / `quotaExceeded` with the
feature's name in `limitName`; a refusal by the organisation's **own** policy is audited as
`error` / `policyRefused` with `policyName`.

| Method | Path | Notes |
|---|---|---|
| `PUT` | `…/environments/{envSlug}/parent` | `{ parent: slug \| null }`. `environment.update` here and `secret.read` on the parent. Under `lockReferenceGraph` (a per-organisation transaction-scoped advisory lock) and then `lockProjectEnvironments`, so two re-parentings — or a re-parenting and a template written in another project — cannot together form a loop. Every graph check (template writes, a deletion or rename of a secret, a promotion, a point-in-time restore, an environment or project deletion) runs the same way: inside the write's own transaction, after that lock. Refused when an active service token is pinned here (it could not read the parent). A production environment given a parent that is not production needs `confirmCrossesProtection: true`; without it, `409 link_crosses_protection:` naming the source and who can write it; with it, `environment.link_crosses_protection` is filed beside `environment.parent_changed`. The same flag, refusal and record apply to a template write (create, update, restore, promotion, point-in-time restore) whose new references reach from production into an environment that is not. |
| `GET` | `…/pull?bundle=2` | Version 2 bundle: `environment`, `layers` (every ancestor whole; referenced environments only the referenced secrets; context-only links with `keys: null`), per-layer keys, `template` + `references` on template secrets, and `policy.plaintextExport` — the **effective** policy, `disabled` when the environment or any layer that contributes a value disables export (a parent, or an environment a template reaches), with each environment's own answer on `environment.policy` and every layer's `policy` so a client can name the one that refused. An environment needing resolution answers a client that omits `bundle=2` with `409 resolution_unsupported:`. Each extra layer read is a `secret.read` filed against **that** environment, with `contextEnvironmentSlug`; each referenced secret is its own `secret.read` naming `referringSecretName`. `&layers=none` (the dashboard) is the same shape with `layers: []`: no plan, no other environment authorised, read or audited — a reader of staging sees staging's own values even when a staging template reaches somewhere they cannot. |
| `GET` `PUT` `DELETE` | `…/overrides[/{name}]` | Owner-scoped; a service token is refused every route. `xk2.gcm.` blobs under the owner's override key (spec §2.2 type 13), bounded at `MAX_SECRET_BLOB_LENGTH`. `PUT` needs `personalOverrides`; at most 100 per person per environment. `override.set` / `override.removed`. Removing a member deletes theirs in the same transaction. |
| `POST` | `…/environments/{target}/promote` | `{ source, writes, removals, dryRun }`. A person only. `secret.read` on the source; `secret.create` + `secret.update` (+ `secret.delete` with removals) on the target. Writes are held to the source's names and types; removals to names the target holds and the source does not; the target's secret policy applies to new names; the batch's templates are checked together (`assertEnvironmentChanges`). One transaction. `environment.promoted` with counts, plus per-secret records `reason: promoted`. |
| `GET` `POST` | `…/environments/{envSlug}/restore-point` | Preview `?at=`, apply `{ at, writes, dryRun }`. `loadEnvironmentSecretsAt` decides the instant; the apply re-plans from the database and holds each entry to its item — row, version, and the instant's `value_hmac`. Writes forward: new versions, soft deletes, and a re-creation (new row) for a secret deleted since, never an undelete. Grants on retired EDKs are served so old versions open; versions under keys the caller lacks are skipped and listed. Window `limits.pitrDays`, refused with `cheapestPlanWithLimit('pitrDays', age)`. The preview is a `secret.read` (`reason: restore-preview`); the apply is `environment.restored`. |
| `PATCH` | `…/environments/{envSlug}/policy` | `{ plaintextExport?, readAlerts? }`, `environment.update`. Disabling export needs `disableEnvExport`; turning alerts on where they default off needs `newIpReadAlerts`. `environment.policy_changed`. |
| `GET` | `…/environments/{envSlug}/read-sightings` | `environment.update`. Not plan-gated. |
| `GET` `PATCH` | `/api/orgs/{orgSlug}/policies` | Read: any member and any service token (clients need the value rules). Write: `org.update` from a session; tightening tokens needs `tokenIpAllowlist`, any change leaving the secret policy on needs `secretPolicy`. `org.policy_changed`. |
| `GET` `POST` `PATCH` `DELETE` | `/api/orgs/{orgSlug}/webhooks[/{id}[/rotate-secret\|/test\|/deliveries]]` | `org.update`, a person only. Creation behind `requireCapacity('webhooks', count)`. The `whsec_` secret is sealed under the org master key (`sealOrgValue`, AAD `xecret.aad.v1.org-value\|webhook-secret\|…`) and returned once. |

**Token policy** is enforced at minting (`POST …/tokens/service` refuses with field errors
`ipAllowlist` / `expiresAt`) and at the CLI exchange (`POST /api/cli/token` issues the token with
the capped expiry), never at use; the service-token listing carries `meetsPolicy`. **Secret
policy**: the name rule is enforced on every write that introduces a name; the value rules in
`server` mode only, because only there does the server hold the plaintext — the clients apply
them for `e2ee`. **Plaintext export disabled**: `server`-mode `…/export` and document-format
`…/pull` are refused with `403 export_disabled:` before anything is decrypted; the JSON pull is
served with `x-xecret-plaintext-export`, since it is what `xecret run` reads.

**Webhook emission** (`change-events.ts` → `emitWebhookEvents`) and **read sightings**
(`noteEnvironmentRead`) both run after the response, never throw into the write or read that
caused them, and cost nothing — not one query — on a plan without the feature. A plain pull is
unchanged at 15 statements; a production pull on a plan with alerts adds one, after the response;
a pull that resolves a parent or a cross-environment reference costs six more, constant in the
number of secrets — and notes a sighting, after the response, for each environment it delivered
values from whose own alert setting is on (production's values read through a staging template
are a read of production).

### Tokens

| Method | Path | Notes |
|---|---|---|
| `GET` `POST` | `/api/orgs/{orgSlug}/tokens/service` | Both gated on `token.create` — the listing is a map of every standing credential, which is reconnaissance for anyone who should not hold it. Minting is session + CSRF only (a bearer credential may not mint further credentials). Body `{ name, projectSlug, environmentSlug, accessLevel?: read\|write, expiresAt?, ipAllowlist?, publicKey? }` — `read` by default, `admin` unrepresentable. `publicKey` is the token's own X25519 public key, base64url. It is **required for an `e2ee` environment and refused for a `server`-mode one**, both as a 400 naming the field. Required, because a token minted without one has nothing an environment key can ever be sealed to: it authenticates, it is listed, and it decrypts nothing for ever — a token's key half is generated in the browser at mint time and cannot be added afterwards, nor can the token be un-minted. Refused in the other direction so that a field a caller sent deliberately is never silently dropped. The token is returned **once**; only its hash is stored. Audited as `token.created`. |
| `GET` | `/api/orgs/{orgSlug}/tokens/cli` | "Your devices" — the caller's **own** CLI tokens only, revoked ones included so a recent revocation is visible. An admin revokes others' tokens without browsing their device names first. |
| `DELETE` | `/api/orgs/{orgSlug}/tokens/{kind}/{tokenId}` | `kind` is `cli` or `service`. Your own CLI token: always. Someone else's, or any service token: `token.revoke`. Immediate — the hash lookup filters `revoked_at IS NULL` in SQL — and idempotent, with the audit record written only by the call that actually did it. |
| `GET` | `/api/tokens/self` | Service-token introspection: the pinned organisation, project and environment as names and slugs, plus the token's own id, name and level, and the organisation's id. The two ids are there because they are AAD components — `orgId` binds every secret ciphertext and the token's id is the `recipientId` of every grant sealed to it — so a token in an `e2ee` environment cannot decrypt without them. Neither is a disclosure: the credential is naming itself to itself. The answer derives from the credential row alone — there is no parameter to lie in. This is how `XECRET_TOKEN=… xecret run` learns its scope without configuration. |

A created token's value appears in exactly one response — the creation's — and is never
retrievable again. No listing function selects `token_hash`. The same rule governs the
invitation link above.

#### The service token's two halves

A service token for an `e2ee` environment carries its own X25519 private key, because it is
the only principal that holds an environment's keys with no person behind it and a CI runner
has no vault to keep one in. Its string is
`xst_<live|test>_<43 chars>k<43 chars>` — auth half, the literal `k`, key half — specified
byte for byte in `docs/security/e2ee-crypto-spec.md` §13.1.

**Only the auth half is ever transmitted.** `Authorization: Bearer xst_<env>_<authHalf>` is
what every endpoint sees, and `service_tokens.token_hash` is the SHA-256 of exactly that.
The key half never leaves the client: `POST …/tokens/service` uploads the matching *public*
key and nothing else, and the response's `token` field is still the auth half — the browser
joins the two and shows the result once. A token presented **with** its key half is refused
with a 401 rather than split, because receiving the key half means it has already leaked
into a header, a proxy, and a log.

Parsing is by offset. `k` is in the base64url alphabet and appears inside both halves about
half the time, so the separator is read at index 43 of the secret segment and never searched
for. `splitServiceToken` in `@xecret/core/auth` is the only thing that may take one apart.

The single-half shape — `xst_<env>_<43 chars>` — remains valid. Every token minted before
this and every token for a `server`-mode environment has it, authenticates normally, and
simply holds no key: nothing can be sealed to it, so rotation excludes it from the required
set rather than blocking for ever on a credential nobody can re-key.

### Audit

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/orgs/{orgSlug}/audit` | `audit.read` (owners and admins). Filters: `actorId` (or `actorIds=a,b` for several, up to 50 — a repeated parameter would collapse to its last value), `action`, `projectSlug` (+`environmentSlug` within it), `outcome`, `from`, `to`. Keyset pagination over `(created_at, id)` behind an opaque cursor — §5's prescription, on the one table where offset pagination would corrupt under its own write load. The response includes the `window` actually scanned, because the range is clamped to 90 days and a UI showing less than it was asked for must say so. |

---

## 5. Pagination

Keyset, not offset:

```
GET …/secrets?limit=50&cursor=<opaque>
→ { "data": [...], "nextCursor": "…" | null }
```

Offset pagination re-scans on every page and shifts under concurrent inserts, so a row can
be skipped or repeated between pages. On the append-only, quarter-partitioned audit table
that degradation is severe. `limit` is clamped to 200.

---

## 6. Rate limits

| Bucket | Applies to | Key |
|---|---|---|
| `RL_LOGIN` | `GET /api/auth/callback` — first on the address alone, then on address + WorkOS user id | IP, then IP + subject |
| `RL_LOGIN`, `login_org` key | `GET /api/auth/login`, the `org=` organisation lookup only — over the limit the parameter is silently ignored | IP |
| `RL_LOGIN` | Vault create / unlock / passphrase | IP + subject |
| `RL_LOGIN`, `reauth_start` / `reauth_verify` keys | The vault reset's emailed code and TOTP step: requesting the code, checking either. Abuse control only — the guess budget that bounds them is in `reauthentications` | user id alone |
| `RL_LOGIN`, `vault_recovery` key | Vault recovery, both steps | user id alone |
| `RL_LOGIN`, `vault_reset` key | Vault reset | user id alone |
| `RL_CLI_TOKEN` | CLI token creation and exchange | user id |
| `RL_INVITE` | Invitations | org id |
| `RL_SECRET_READ` | Reveal and pull | actor id |
| `RL_SERVICE` | Service-token requests | token id |
| `RL_MUTATION` | Every other write | actor id |

Counters are per-colo, not global — abuse control, not a security boundary. What actually
protects a secret is authentication, authorization, and the audit trail.

---

## 7. What is audited

Every mutation, every decryption, and **every denial**. A system that records only what
succeeded cannot detect an attack in progress.

Audit metadata is typed as an allowlist with no index signature, so a secret value cannot be
placed in a record — the type system rejects it rather than a reviewer having to notice.
The zero-knowledge events extend that rather than weakening it: there is no `wrap`, no
`verifier`, no `lookupHash` and no `recoveryCode` field. A vault event records a *shape* —
which kind of wrap, how many codes — never the material.

The vault's own events are `vault.created`, `vault.unlocked`, `vault.unlock_failed`,
`vault.passphrase_changed`, `vault.recovery_used`, `vault.recovery_codes_regenerated` and
`vault.reset`. `vault.recovery_used` is the line an incident review looks for first: it is
the only path that opens a vault with neither the passphrase nor an enrolled passkey.
`vault.reset` is the only record that an account's existing ciphertext became permanently
unreadable at a particular moment, which is what makes an otherwise inexplicable "I cannot
see any of my secrets" answerable.

A sign-in is recorded by what the linking pass did: `auth.login` (a known identity),
`auth.signup` (a new account) or `auth.identity_linked` (an existing account adopted by its
verified address — the one sign-in that changes which identity an account answers to, so "who
could sign in as this account, and since when" is answered by finding it).
`auth.identity_linked` is written at the moment the link is, even when a later step then refuses
the sign-in (`sso_required`, no seat), because the link stands either way; an adopted sign-in
that completes records `auth.login` beside it. Each carries `signInMethod`, a closed set
(`password`, `oauth`, `sso`, `magic_auth`, `passkey`, `other`) rather than WorkOS's own
vocabulary. `member.jit_joined` and `member.jit_denied` record single sign-on admitting a
newcomer, or turning one away — the second with outcome `error` and a reason: `quotaExceeded`
(with `limitName: seats`) when no seat was free, or `removed` for somebody the organisation
removed and has not invited back. Neither is written for an organisation that has not opted in
to just-in-time joins. `auth.sso_exemption_used` is written in **each** organisation that
requires single sign-on whose requirement a sign-in reached only through the owner exemption,
with the method as `signInMethod` — the break-glass, made findable where it was used.

An organisation's SSO settings are recorded by `org.sso.enabled` (once: the WorkOS organisation
created and linked), `org.sso.portal_link_created` (every setup-portal link handed out — the link
itself never), and `org.sso.required_toggled` / `org.sso.jit_toggled`, each carrying `enabled`,
the switch's new value. A toggle is recorded only when it moved, so the previous value is the
opposite one.
`auth.reauthenticated` records the proof a vault reset spends, and is what shows a reset that
follows it was not a stolen cookie alone.

The environment-key events are `envkey.created`, `envkey.rotated`, `envkey.granted`,
`envkey.grant_revoked` and `envkey.grant_pending`. Two of them are worth reading together:

- `envkey.grant_revoked` records that somebody's key was taken away, and **not** that the
  environment became safe again — they read what they read while they held it, and the sealed
  blob may still be in a browser or a token string.
- `envkey.rotated` is what closes that: it carries `keyVersion` and `grantCount`, so "the
  production key was rotated and re-sealed to 9 principals" is checkable against the roster, and
  a count that drops without a matching removal is the shape of a rotation that quietly lost
  somebody.

An environment where the first appears and the second never does has been revoked on paper only,
which is exactly what `needsRotation` reports until it lands.

`envkey.grant_pending` is the honest record of a partial act: access changed and the member
still cannot read anything. That state looks like a bug from every screen in the product, and
without this event the audit log would show the access grant with no explanation of the gap
that followed it.

These events extend the metadata allowlist by `principalKind` and `grantCount` — a kind and a
count, never a recipient's key and never a sealed blob, following the same rule `wrapKind`
does. A grant placed in an audit record would put ciphertext into the one table the product is
built to keep readable, and the type system refuses it for the same reason it refuses a secret
value.
