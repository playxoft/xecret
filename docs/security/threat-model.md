# xecret Threat Model

**Version:** 1.0 · **Date:** 2026-08-10 · **Status:** living document

Review this document at the end of every phase and whenever a new trust boundary is
introduced. An unreviewed threat model is worse than none, because it creates false comfort.

---

## 1. What we are protecting

| Asset | Sensitivity | Impact if lost |
|---|---|---|
| Customer secret plaintext | **Critical** | Customer production systems compromised. Existential for xecret. |
| Root KEK | **Critical** | Every customer's secrets decryptable. Also: if *lost* rather than stolen, all data permanently unrecoverable. |
| Org / Env keys (wrapped) | High | Useless without the Root KEK, but narrow the attack. |
| Session & CLI tokens | High | Account takeover at the privilege of the token. |
| Service tokens (CI) | High | Read access to one project+environment. |
| Audit logs | Medium | Loss of forensic ability; tampering hides an intrusion. |
| User PII (email, name) | Medium | Privacy breach, disclosure obligations. |
| Secret *names* and metadata | Low–Medium | `STRIPE_LIVE_KEY` existing in `production` is itself intelligence. |

## 2. Trust boundaries

```
┌─ UNTRUSTED ────────────────────────────────────────────────────────┐
│ Browser · CLI on a developer laptop · CI runner · public internet   │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ TLS + authn + authz  ◀── BOUNDARY 1
┌──────────────────────────────▼─────────────────────────────────────┐
│ TRUSTED: Cloudflare Worker                                          │
│ holds Root KEK in memory · performs all decryption                  │
└───────┬──────────────────────────────────────┬─────────────────────┘
        │ BOUNDARY 2 (Hyperdrive/TLS)          │ BOUNDARY 3 (deploy only)
┌───────▼──────────────┐              ┌────────▼──────────────────────┐
│ SEMI-TRUSTED: Neon   │              │ Phase.dev / CF Secrets Store  │
│ ciphertext only,     │              │ Root KEK at rest              │
│ never a usable key   │              │                               │
└──────────────────────┘              └───────────────────────────────┘
```

**Core invariant:** the database alone is never sufficient to read a secret. Compromising
Neon yields ciphertext and wrapped keys — no plaintext.

**Boundary 4 — a customer's identity provider (WS-5).** An organisation with the single
sign-on add-on can attach an identity provider of its own choosing, through WorkOS. From then
on that provider — run by the customer, or by whoever controls it — can sign people in as the
organisation's members, for any address in a domain the organisation verified with WorkOS. It
sits *outside* the boundary diagram above: xecret never sees its metadata or certificates, and
believes it only through WorkOS's answer to the code exchange. It is an attacker-selectable
input for anybody who can create an organisation and buy the add-on, so everything it can
assert is bounded here (T1's planted-session login CSRF, and T13).

---

## 3. Attacker classes

Likelihood is judged over a 12-month horizon for a product of this profile.

### T1 — Unauthenticated internet attacker

| | |
|---|---|
| **Goal** | Reach any secret without credentials |
| **Impact** | Critical · **Likelihood** | High (constant background scanning) |

**Threats:** credential stuffing on login · brute force on invitation and CLI tokens ·
enumerating IDs on API routes · SQL injection · SSRF via user-supplied URLs · exploiting an
unauthenticated route added by accident · login CSRF on the sign-in callback (completing the
attacker's sign-in in the victim's browser) · taking over an existing account at sign-in, by
registering its address unverified at the identity provider or by having another company's
SSO assert it.

**Mitigations:** authentication is deny-by-default — routes opt *in* to being public, never
out · Cloudflare rate limiting on login, token exchange, and invitation acceptance ·
parameterised queries only (Drizzle) · 256-bit random tokens compared in constant time ·
no user-supplied URL is ever fetched server-side in v1 · security headers and strict CORS ·
a Content Security Policy on every response (`apps/web/src/lib/csp.ts`) · credential entry,
password reset and MFA happen on WorkOS's hosted AuthKit pages, never on ours · the sign-in
callback accepts a code only in the browser that started the flow — a signed, ten-minute
state cookie plus PKCE — and exchanges it server to server, so no provider token ever reaches
or comes from a browser · an existing account is adopted only on a **verified** address, and
an SSO sign-in is believed only for the domains its organisation has verified with WorkOS
([ADR 0010](../adr/0010-workos-as-identity-provider.md)).

**What `state` and PKCE do not cover: the planted AuthKit session.** They prove the callback
completes a flow *this browser started*; they cannot prove *whose* authentication comes back.
AuthKit reuses a session it already holds without asking anything. So an attacker who owns an
organisation here, wired to an identity provider they control (Boundary 4), can first plant
*their own* AuthKit session in the victim's browser — a hidden navigation to AuthKit's
authorize URL with `organization_id=<theirs>`, or their provider's IdP-initiated sign-in
through the initiate-login URI — and the victim's next plain "Sign in", even one they click
themselves, is answered with the attacker's identity against the victim's own valid state and
PKCE. Zero clicks on anything suspicious; the victim lands in the attacker's account, and
whatever they store next is the attacker's. This was open until review round 1 of WS-5 (S1);
review round 2 found the round-1 defence could be walked round (below) and closed that too.
The defence, as it now stands:

- **The flow seals what it asked for.** The login route writes the organisation an `?org=`
  deep link asked for — or none — into the state cookie.
- **The callback holds back, and issues no session for,** an authentication that comes back
  (a) through a different organisation — any single sign-on on a flow that asked for none, an
  IdP-initiated sign-in, an organisation reported after organisation selection; (b) through
  the single sign-on of an organisation the account is **not already an active member of, even
  when the flow asked for that organisation** (round 2); or (c) from an authentication WorkOS
  dates before the flow began (a session it reused without asking, read from `auth_time`)
  **for an account other than the last one this browser signed in as**. The outcome is parked
  in a sealed, `HttpOnly`, five-minute cookie and the browser goes to `/sign-in/confirm`.
  **Nothing that changes an organisation runs before the answer** — the just-in-time join
  waits for "Continue" — so a declined sign-in leaves no trace in one.

  Reason (b) covers **first-time and non-member identities only** — somebody signing in
  through an organisation they are not yet in, for whom joining it is worth one question. It
  is not a defence against a deep link that reached the login route some other way (round 3
  corrects round 2's "defence in depth"): in the attack, the identity that comes back is the
  attacker's, and the attacker's account *is* a member of the attacker's organisation, so (b)
  never fires for it. What stops a deep link nobody chose is the warning page's token and
  `next` never naming an API route, both below.
- **The confirmation page** names the account in full, above the buttons, and presents the
  organisation as the claim it is ("an organisation calling itself …"); both strings are
  somebody else's, so they arrive made inert — direction overrides, invisible characters and
  stacked accents replaced by a visible U+FFFD, length-capped, isolated in `<bdi>` — and an
  address with non-ASCII characters is called out. Only its **POST** issues the session:
  same-origin and failing closed on `Origin`, `SameSite=Lax`, a form token that is the
  cookie's 256-bit nonce, and the nonce spent once in `sign_in_confirmations` before anything is
  issued. "This isn't me" issues nothing, ends the AuthKit session the sign-in came from
  (WorkOS's logout URL for its `sid`), lands on `/sign-in?error=declined` without the flow's
  `next`, and is audited `auth.sign_in_declined`; a confirmed one is audited as the ordinary
  `auth.login` carrying `confirmation`.
- **`next` can never be an API route** (round 2's HIGH). The confirmation redirects to the
  sealed `next`, and a `next` of `/api/auth/login?org=attacker-co` turned the victim's
  truthful "Continue" into a perfectly same-origin, navigate, document request for the
  attacker's single sign-on — which round 1's fetch-metadata gate honoured. `safeRedirectPath`
  now refuses any path that decodes (repeatedly, lower-cased, backslashes as slashes, dot
  segments resolved) to `/api` or under it — when the login route seals it, and again when the
  callback and the confirmation use it. **Nor a sign-in screen** (round 3): at those same three
  places `safePostSignInPath` also refuses `/sign-in`, `/sign-up`, `/forgot-password` and
  `/reset-password`, read the same way, so a finished sign-in cannot land on
  `/sign-in?org=attacker-co` — the warning page, whose "Continue" would then look like the
  second step of what the person had just done (`/forgot-password?org=…` reaches it one
  redirect later, query intact).
- **`?org=` is honoured only with the warning page's token** (round 2). A request for an
  organisation's single sign-on with no valid `continue` token — however same-origin it looks
  — is answered with a 303 to `/sign-in?org=<slug>`, the page that presents the slug as an
  unproven claim, and a random `HttpOnly`, `__Host-` binding cookie. That page's "Continue"
  link carries an HMAC (its own HKDF label of the cookie secret) over the slug, the moment and
  that binding; the login route requires the token to verify against the binding the browser
  presents, for that slug, under five minutes old, *and* a same-origin navigation to a
  document. Bound to the binding, a token works only in the browser that was shown the page —
  one an attacker mints by loading the page themselves names the attacker's binding — and the
  binding is cleared once followed. Fetch metadata says where a request came from; the token
  says a person chose it.
- **Sign-out ends the AuthKit session too** (round 2). Each session records the AuthKit
  session it came from (the access token's `sid`, `sessions.workos_session_id`), and
  `DELETE /api/auth/session` answers WorkOS's logout URL for it, which the dashboard follows.
  Before, AuthKit's session outlived sign-out, nearly every returning person was held back as a
  reused session, and people learned to click "Continue" without reading — the habit the
  confirmation cannot survive. With that, and the signed **last-account cookie** (an HMAC over
  the account id, written at every sign-in) sparing a returning person the reused-session
  question for their own account only, the confirmation is asked when it means something.

What this leaves: a person who reads "an organisation calling itself *Your Company*" beside
an account they do not recognise and continues anyway; a person who follows a link to
`/sign-in?org=attacker-co` and clicks "Continue with single sign-on" on a page that says the
slug proves nothing. Both pages are written for those moments. The last-account cookie spares
only the reused-session question, and only for the account it names: a person who once
confirmed a planted sign-in carries that account's cookie, but a planted session through an
organisation is still asked about every time (reasons a and b do not consult it). Whether
WorkOS can switch IdP-initiated sign-in off for this environment, and whether its logout
redirect accepts `/sign-in`, are to be checked on Staging.

It also leaves **a double-click window swap** on those two screens (round 3), the clickjacking
variant that needs no frame. Each decision is one click — "Yes, continue with this account" on
`/sign-in/confirm`, "Continue with single sign-on" on `/sign-in?org=` — and framing either page
is already refused (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). But a page of the
attacker's that asks for a double-click can, between the first click and the second, put one
of ours under the pointer — open it in a window over its own, or navigate its opener there —
and the second click lands on our button before anybody has read it. On `/sign-in?org=` the timing is
easy (the page is static and the attacker's own navigation through the login route hands the
browser the binding the token needs); on `/sign-in/confirm` it is harder (the page is the end
of a round trip through AuthKit), but not impossible. Nothing here stops it yet: both buttons
are live the moment the page paints. Arming them only after a short delay, or only once the
pointer has moved over the page, is the known remedy and is not built.

**Residual risk:** Low. A zero-day in Cloudflare or Next.js remains possible; the
planted-session confirmation can be clicked through by a person who does not read it, or —
on either one-click screen — by a double-click window swap.

**Known limit of the CSP.** `script-src` carries `'unsafe-inline'`, so the policy does not
stop an injected inline `<script>` from running — the App Router streams its RSC payload as
a per-page inline script, and the nonce that would replace it requires a Proxy this stack
cannot have (ADR 0008). What the policy does remove is what such a script could accomplish.
`img-src` names no remote origin at all, and `connect-src` names only this origin — so the
`fetch` and the `<img>` beacon a review actually demonstrated are both refused. `form-action`
refuses a redirected POST, and `base-uri 'self'` refuses a rewrite of every relative URL on the
page.

`script-src` is this origin plus `'unsafe-inline'`, and no third-party source. That is recent.
Under Firebase, sign-in needed Google's script loader at `apis.google.com`, and the
email/password flows loaded reCAPTCHA Enterprise from two Google paths whenever an operator
enabled enforcement in the Firebase console, so a second stage could be loaded from three
Google-operated sources — and a host allowlist is only ever as tight as the least careful
endpoint on an allowed origin. Since [ADR 0010](../adr/0010-workos-as-identity-provider.md)
sign-in is a plain navigation to WorkOS's hosted pages: the browser runs no identity-provider
code, so the policy names no identity-provider host in any directive, and nothing had to be
added for WorkOS. A second stage now has nowhere to be loaded from but this origin.
`apps/web/src/lib/csp.test.ts` enumerates each directive's sources exactly, so widening any of
them is a deliberate edit in two places rather than a silent one.

Treat inline execution as *contained*, not prevented, and keep escaping at the point of
render — see the documentation renderer, which is where this was learned.

---

### T2 — Authenticated user attacking another tenant

| | |
|---|---|
| **Goal** | Read secrets from an organisation they do not belong to |
| **Impact** | Critical · **Likelihood** | **High** — this is the single most likely real breach |

**Threats:** IDOR/BOLA by substituting `projectId`, `environmentId`, or `secretId` ·
accepting an invitation intended for someone else · a forgotten `WHERE org_id` in one query.

**Mitigations:**
- **One authorization function.** Every protected route calls `can(actor, action, resource)`
  in `packages/core/authz`. No route implements its own check.
- Resource lookups always resolve *through* the verified org membership, never by bare ID.
- Automated test matrix: for every route, a member of org A attempts every operation on
  org B's resources and must receive 404 (not 403 — 403 confirms existence).
- Invitations are bound to the invited email address and are single-use.

**Residual risk:** Medium. This is where bugs will be. Mitigated by making the test matrix a
CI gate, not an aspiration.

---

### T3 — Malicious or over-curious team member

| | |
|---|---|
| **Goal** | Access environments above their granted level (typically production) |
| **Impact** | High · **Likelihood** | Medium |

**Threats:** editing their own role · using a stale CLI token after a downgrade · reading
production through the CLI when the UI hides it · exfiltrating via `xecret pull`.

**Mitigations:** role changes require `member.update`, which no one can exercise on
themselves for elevation · **authorization is evaluated per request, never cached in the
token** — a downgrade takes effect immediately, including for existing CLI tokens · every
secret read is audited with actor, environment, IP, and timestamp · production environments
require an explicit grant and are visually distinct.

**Single sign-on is per request too.** An organisation's `sso_required` is checked on every
request that reaches it (`resolveOrg`), against how the presenting session — or the browser
session that approved a CLI token — signed in (`sessions.sso_workos_org_id`, migration 0022).
Until WS-5's review round 1 it was checked at sign-in only, which left a session issued before
the flag went on (thirty days), a CLI token minted from one (possibly no expiry at all), and a
password newcomer accepting an invitation all outside it (S3). Now switching it on takes the
organisation from every such credential at its next request — and only that organisation; the
member's others are untouched — and invitation acceptance and CLI approval are held to it as
well. **Owners are exempt**, as a deliberate break-glass: an identity provider misconfigured
after the switch would otherwise lock the organisation out of itself with no self-service way
back. That is a trade-off, not a free one — an owner's password (or Google sign-in) remains a
way into the organisation its identity provider does not govern, so a stolen owner password is
worth exactly what it was before SSO — and every sign-in that uses it is audited in each
exempting organisation as `auth.sso_exemption_used`.

**Residual risk:** Medium. A user with legitimate read access can always exfiltrate what they
can read. Audit logs make it *detectable*, not preventable. This is inherent to the product.

---

### T4 — Stolen CLI credential (laptop theft, malware, leaked dotfile)

| | |
|---|---|
| **Goal** | Use a developer's stored token |
| **Impact** | High · **Likelihood** | Medium |

**Threats:** reading the credential from disk · another process on the machine reading it ·
the token appearing in shell history or a screen recording.

**Mitigations:** credentials stored in the **OS keychain** (macOS Keychain, Windows
Credential Manager, Linux Secret Service); the file fallback is `0600` with a visible warning
· tokens never printed, never passed via argv, never placed in a URL · every token is
revocable from the dashboard with device name, last-used time, and last-used IP · tokens
expire and refresh · the offline cache is encrypted with a separate key, also in the keychain.

**Residual risk:** Medium. An attacker with full control of an unlocked developer machine
wins — but that is true of every tool on that machine.

---

### T5 — Compromised CI environment

| | |
|---|---|
| **Goal** | Extract the service token or the secrets it retrieves |
| **Impact** | High · **Likelihood** | Medium (malicious PR, compromised action) |

**Threats:** a pull request modifying the workflow to print secrets · a compromised
third-party GitHub Action · secrets landing in build logs or a cached artifact.

**Mitigations:** service tokens are scoped to exactly **one project + one environment** and
are read-only by default · no user identity is attached, so a stolen CI token cannot touch
anything else · optional IP allowlist and expiry · every use is audited with source IP ·
documentation explicitly warns against granting production tokens to workflows triggered by
forked pull requests.

**Residual risk:** Medium–High, and largely outside our control. Mitigated by blast-radius
limitation. GitHub OIDC federation (no static token at all) is the planned v2 answer; the
token schema is already designed for it.

---

### T6 — Database compromise (Neon breach, stolen credentials, backup leak)

| | |
|---|---|
| **Goal** | Read secrets from the database directly |
| **Impact** | **Low for secrets**, Medium for metadata · **Likelihood** | Low |

**Mitigations:** **this is the attack envelope encryption exists to defeat.** The database
holds only ciphertext and wrapped keys; the Root KEK is never present in any column, backup,
or replica. Session and API tokens are stored as SHA-256 hashes, so a dump yields no usable
credentials. The application database role has no DDL rights.

**Residual risk:** Low for secret values. Metadata — org names, user emails, secret *names*,
audit history — is exposed and is genuinely sensitive intelligence. Accepted and documented.

---

### T7 — Application / Worker compromise (RCE, malicious dependency)

| | |
|---|---|
| **Goal** | Execute code inside the trust boundary |
| **Impact** | **Critical** · **Likelihood** | Low |

This is the worst realistic case: code running in the Worker holds the Root KEK in memory and
can decrypt anything.

**Mitigations:** minimal dependency count, reviewed before addition · `npm audit` and
Dependabot in CI · lockfiles committed; CI installs with `npm ci` · Root KEK imported as a
**non-extractable `CryptoKey`**, so it cannot be trivially serialised out · no `eval`, no
dynamic `import()` of user input · CSP · Cloudflare's V8 isolate provides a strong sandbox ·
all decryption is audited, so mass decryption is visible.

**Residual risk:** **Medium — and the highest residual risk in the system.** Envelope
encryption does not defend against an attacker inside the boundary. Only ADR 0001's rejected
E2E model would, at costs documented there. Detection (audit anomaly alerting) is the
practical answer.

---

### T8 — Supply-chain attack

| | |
|---|---|
| **Goal** | Ship malicious code into the Worker or the CLI binary |
| **Impact** | Critical · **Likelihood** | Low–Medium (rising industry-wide) |

**Mitigations:** few dependencies, each justified · lockfiles committed and CI-enforced ·
Dependabot with review required · release binaries checksummed and **signed with cosign** ·
reproducible Go builds · GitHub Actions pinned to commit SHAs, not tags · protected `main`
with required review.

**Residual risk:** Medium. A compromised upstream package is a real and growing threat.
`packages/core` deliberately has near-zero dependencies for exactly this reason.

---

### T9 — Insider (xecret operator with production access)

| | |
|---|---|
| **Goal** | Read customer secrets |
| **Impact** | Critical · **Likelihood** | Low |

**Honest statement:** under ADR 0001, an operator with production access **can** decrypt
customer secrets. No technical control in v1 fully prevents this.

**Mitigations:** Root KEK access is restricted in Phase.dev and Cloudflare with per-person
accounts and their own audit trails · production access requires MFA · this limitation is
stated plainly in `SECURITY.md` and the privacy documentation rather than obscured.

**Residual risk:** **High, and inherent to the trust model.** Customers who cannot accept it
need a zero-knowledge product. Saying so honestly is the only acceptable position.

---

### T10 — Loss of the Root KEK (not theft — loss)

| | |
|---|---|
| **Goal** | n/a — accident, not attack |
| **Impact** | **Existential** · **Likelihood** | Low, but non-zero |

Phase.dev account deleted, locked, or lost; Cloudflare account closed; the one person who
knew the ceremony leaves.

**Consequence:** **every customer's secrets become permanently unrecoverable.** A database
backup does not help — ciphertext without the key is noise.

**Mitigations:** 2-of-3 Shamir escrow stored offline in physically separate locations ·
documented, rehearsed restore procedure · quarterly drill assuming Phase.dev is gone · more
than one person knows the ceremony. See [`key-recovery.md`](key-recovery.md).

**Residual risk:** Low **only if the drills actually happen.** Untested backups are not
backups. This threat was entirely absent from the original project brief and is the reason
the recovery document is a hard gate on Phase 2.

---

### T11 — Account takeover through the vault reset (an unlocked laptop, or an inbox)

| | |
|---|---|
| **Goal** | Pass the vault reset's re-authentication on somebody else's account, then use the account |
| **Impact** | High · **Likelihood** | Low–Medium |

The vault reset destroys an account's vault and must stay reachable from a locked session, so
the vault lock cannot guard it. Two re-authentications do instead, in order and bound to the
session the first one issues ([ADR 0010](../adr/0010-workos-as-identity-provider.md), amending
ADR 0009's trade-off 6): **lock one**, a sign-in again through AuthKit (`reauth=1`, which sends
`max_age=0`), counted only for the methods `Password`, `Passkey`, `GoogleOAuth` and `SSO`; then
**lock two**, a one-time code WorkOS emails (Magic Auth) — and, for an account with an
authenticator app enrolled in WorkOS, its TOTP code as well.

**Lock one is not a fresh credential for everyone.** WorkOS documents `max_age` only for
AuthKit's own sign-in (`provider=authkit`). It does not make Google or an enterprise identity
provider ask again, so for a Google or SSO account a live session there satisfies lock one
silently. For a password or passkey account it is a fresh credential when AuthKit honours
`max_age=0` — and the server checks that it did: lock one counts only if the access token
WorkOS returns with the code carries an `auth_time` (the person's most recent *active*
authentication, unmoved by a reused session or a refresh) no earlier than the flow's start, less
30 seconds for clock difference. A token without one does not count.

**Threats:**
- somebody at an unlocked laptop whose browser holds the victim's Google (or identity-provider)
  session and has their Gmail open in another tab: lock one passes silently, the code arrives
  in the open inbox, and both locks fall without the attacker knowing anything;
- somebody in control of the inbox alone: AuthKit's "Forgot password" sets a new password, a
  Password sign-in with it counts as lock one, and the code arrives in the same inbox — both
  locks are inbox-strength;
- somebody at an unlocked laptop holding the victim's AuthKit session who strips `max_age=0`
  from the URL, and can read the inbox — closed by the `auth_time` check below;
- guessing the six-digit emailed code or the TOTP code;
- a stolen session cookie, replayed from another browser.

**The impact of a reset is not only destruction.** After resetting, the attacker sets up a new
vault on the victim's account, which unlocks the session they hold:
- through it they can **read** every server-mode (not end-to-end encrypted) environment the
  account can read;
- the reset re-queues a key share for every end-to-end-encrypted environment the account may
  still read, so the victim's teammates are prompted to re-share it — and a teammate who
  approves seals that environment's keys to the attacker's new vault.

The victim's own vault, and with it their copy of every end-to-end-encrypted key, is gone.

**Mitigations:**
- **Lock one checks the date of the sign-in, not just its method.** The callback reads
  `auth_time` from the access token returned in its own authenticated call to WorkOS (decoded,
  not verified — it arrived beside the user it describes), and arms lock one only if it falls
  within this flow. A stripped or ignored `max_age=0` produces a code dated by an earlier
  sign-in, which does not count. Confirmed against WorkOS Staging: `auth_time` is set by a
  sign-in, kept by a refresh, moved by the next sign-in.
- Both locks, in order, on one session. Lock two is refused unless lock one recorded a row for
  *this* session within ten minutes, and a sign-in completed by emailed code never counts as
  lock one. A cookie replayed from another browser has none of the victim's sessions at Google,
  AuthKit or the mail provider, so it stops at lock one.
- A one-time, five-minute proof, bound to the session and the user, stored as its SHA-256 and
  spent in one atomic UPDATE before anything is destroyed.
- **A guess budget in the database, not the rate limiter.** Every guess — the emailed code and
  the TOTP step alike — is reserved atomically before WorkOS is called: at most five per attempt,
  and at most ten per account in any rolling 24 hours across all its attempts, the second
  counted under the user's row lock. A guess is accepted only on an attempt whose code was
  actually requested, and a WorkOS error xecret cannot classify costs a guess too. The budget
  holds where the rate limiter is absent and fails open.
- **Code requests are capped the same way**: at most three per attempt, reserved under the same
  row lock before WorkOS is asked to send one, so a session past lock one cannot turn the
  account's inbox into a mail stream.
- **WorkOS MFA.** With an authenticator app enrolled, WorkOS answers a correct emailed code with
  an MFA challenge; xecret answers `{ mfaRequired: true, mfaToken }`, keeps only the SHA-256 of
  WorkOS's pending-authentication token, and mints the proof only after the TOTP code
  authenticates. An inbox, or an open Gmail tab, does not supply that code — this is what
  closes the paths above, and it is recommended for organisation owners. **It is unit-tested
  against WorkOS's documented error shape only**: MFA is not enabled in the Staging WorkOS
  environment, so the live check is pending.
- The other authentication errors WorkOS can raise on Magic Auth — organisation selection,
  email verification or SSO required, MFA enrolment required, a Radar challenge — are refused
  by name, never passed through as a success.
- Detection: `auth.reauthenticated` and `vault.reset` are audited, and re-sharing an
  end-to-end-encrypted environment is a teammate's deliberate act, not something the attacker
  can complete alone.

**Since P23 (2026-10-12) a reset is not destruction.** The old vault is retained for seven
days (migration 0020): the victim can recover it with their passphrase or a recovery code, from
Settings → Security, which re-seals its keys into whatever vault the account now has — and
nothing in xecret, the attacker's session included, can delete it early: the database refuses
the DELETE by its own clock, the application's role cannot update the window, and there is no
route that issues one. What an attacker who passes both locks gains is unchanged — server-mode
secrets, and re-share prompts to teammates — but what the victim loses is no longer permanent
within the window. The victim also receives the escape archive by email — or, when the vault was
too large and the person resetting chose to go without it, a notice — which tells them a reset
happened; an attacker who controls the inbox receives it too (T12).

**The way back from a hostile reset.** The victim signs in and secures the account; if the
attacker set up a vault of their own after the reset, the victim resets again and sets up their
own; then recovers the original vault with its passphrase. Each reset retains its own vault for
its own seven days, so the second reset does not touch the first retained vault — it only adds
the attacker's to the list. The user docs walk through this ("If somebody else reset your
vault"). **Recovery may have to wait up to an hour**: between the hostile reset
and the victim's own, which locks every session the account has, an attacker
unlocked into a vault of their own can send wrong proofs at the original's
`…/restore` and run its lockout to the maximum (`nextUnlockFailure`, one hour).
The window is not shortened by it, and the lockout can never outlast the purge.
The archive the attacker's reset emailed is treated as exposed (T12).

**Residual risk:** **Medium** without MFA — an unlocked laptop with a live Google or
identity-provider session and an open inbox, or full control of the inbox alone, passes both
locks, and the reset then opens the account's server-mode secrets and asks teammates for the
rest. Lower with MFA enrolled, once the TOTP branch is confirmed against WorkOS. By the product
owner's decision (2026-10-12) no waiting period comes before a reset; the seven-day retention is
the mitigation chosen instead, and it limits the *damage* of a hostile reset, not its
*occurrence*.

---

### T12 — The emailed escape archive (an inbox as a permanent, offline copy of a vault)

| | |
|---|---|
| **Goal** | Recover an account's secrets from the archive emailed at its vault reset |
| **Impact** | High · **Likelihood** | Low–Medium (depends on passphrase strength) |

At every vault reset the server assembles the account's **escape archive** — every ciphertext
its vault could open, still sealed, plus the passphrase wrap, the unused recovery wraps, the
Argon2id salt and parameters, and the encrypted X25519 private key (spec §14) — and **emails it
to the account's own address**. The product owner decided this on 2026-10-12, overriding the
earlier "browser download only" decision, and accepted the risk below after it was explained.

**What it concedes, stated without softening:**
- **The inbox becomes a permanent, offline-attackable copy of the vault.** Online, the
  passphrase is defended by the unlock backoff and lockout. Against the archive there is none:
  whoever holds a copy runs Argon2id (64 MiB, three passes per guess at current parameters) on
  their own hardware for as long as they like. A strong passphrase (the setup ceremony enforces
  twelve characters and a zxcvbn score of 4) holds; a weak one falls in time. **No revocation
  reaches a copy of a file.**
- Copies multiply where the product can never reach them: the mail provider, mailbox backups,
  search indexes, the Sent and Trash folders, forwards, mail clients' local caches.
- An attacker in control of the inbox (T11's inbox path) receives the archive as well as the
  reset code, and can attack it at leisure even if the victim recovers the live vault.
- The archive carries **names** — organisation, project, environment and secret names — in
  plain text. The product treats names as non-secret elsewhere (T6), but the mailbox is a new
  place they live.
- The archive is **confidential, not authenticated** (spec §14.7): a person who alters it
  before it is opened can add values that will open. Importing shows every value before it is
  written.

**What it does not concede:** nothing to xecret or to a database thief beyond what they already
hold (every byte in it is already in the database, under keys the server has never had); no
recovery code is weakened (each is 125 bits of uniform randomness); the Ed25519 signing key, the
unlock verifiers, PRF wraps, superseded passphrase wraps and redeemed codes are deliberately left
out.

**What it widens, for a stolen session, stated precisely.** `GET /api/auth/vault` serves the
passphrase wrap, salt and parameters to any session of the account, **locked or not**, because
the lock screen needs them — so a stolen *locked* session already permits the same offline
guessing of the passphrase. What a locked session does not give is the ciphertext and the
environment keys to use a guessed passphrase on once the session is revoked; the archive is
exactly that, in a copy no revocation reaches. A stolen *unlocked* session already reads
everything the account can while it lives. And **brief control of the inbox**, together with a
fresh sign-in (T11), is enough to trigger a reset and receive the archive.

**The retained vault is offline-attackable too, by any unlocked session.** For seven days
`GET /api/auth/vault/retained/{id}` serves the old vault's passphrase wrap, salt, encrypted
private key and grants to any *unlocked* session of the account — the recovery screen needs
them. The retained vault's own lockout counts misses at the API (`…/recovery-wrap`,
`…/restore`) and is **abuse control, not a defence of the passphrase**: the restore's proof is a
256-bit HKDF output nobody guesses, and an offline attack on the passphrase never goes through
the API at all.

**Mitigations:**
- The email, the archive's `README.txt`, the reset screen and the user docs all state the
  offline-attack risk first, in plain words, and say to save the file privately and delete the
  mail.
- The archive covers only end-to-end-encrypted environments the account **may still read**
  (`can(secret.read)` at assembly), only the latest version of each live secret, and only the
  keys the account held.
- The archive is sent **before** the reset; a provider refusal of any send resets nothing, and
  the reset then retains exactly the vault that was archived (a vault set up again in between is
  a 409). Each part's ZIP is at most 5 MiB — about 7 MB base64-encoded, under ZeptoMail's 15 MB
  per message and the 10 MB many receiving gateways still enforce — and at most two parts.
- **Never without the archive, silently** (owner decision, PR #121 round 1). The archive is sized
  in SQL before the reset is confirmed; one estimated over 8 MiB is never loaded or emailed. The
  reset screen states that before anybody re-authenticates, and the reset goes ahead only when
  the person ticks "Reset without the emailed archive" — a notice is emailed instead, and the
  seven-day retention is then the only way back. A production deployment with no mail provider
  refuses every reset.
- **Rotate environment keys if the archive may be exposed.** The exposure is the environment
  keys themselves, sealed to the old X25519 key, not only today's values: a passphrase guessed
  from the archive opens every EDK it carries. Rotating each environment's key (`envkey.rotated`)
  puts every future value out of the archive's reach; values already in it must be rotated at
  their source. The user docs say both.
- Importing writes only into end-to-end-encrypted environments — the archive is pinned as an
  `e2ee` source, so a server-mode target is refused — and only after a preview that shows every
  name and value, masked until revealed (spec §14.7).
- `vault.archive_emailed` records that it happened, with counts and never names.

**Residual risk:** **Medium**, accepted by the product owner — for an account with a weak
passphrase and a compromised or carelessly shared mailbox, every secret the archive covers is
exposed for as long as that mailbox's copies exist. Low for a strong passphrase.

---

### T13 — A customer's identity provider, or whoever can rewire it (WS-5)

| | |
|---|---|
| **Goal** | Sign in as an organisation's members — an owner, ideally — by controlling the identity provider that vouches for them |
| **Impact** | Critical (for that organisation) · **Likelihood** | Low–Medium |

**Threats:** an admin who points the organisation's SSO at an identity provider of their own,
then signs in as any member — an owner included — through it (an admin-to-owner escalation in
all but name) · a leaked setup-portal link, which lets whoever opens it change the identity
provider · somebody removed from the organisation but still in its identity provider, silently
re-admitted by just-in-time membership · an identity provider asserting addresses in somebody
else's company · a linked organisation whose `workos_org_id` belongs to a different WorkOS
environment (local development runs against WorkOS Staging over the production database).

**Mitigations:**
- **SSO administration is owners-only** (`sso.manage`, review S2): turning SSO on, minting a
  setup-portal link and switching either policy on. No custom role can carry it — none is
  based on `owner`, and a custom role only subtracts from its base. Admins keep reading the
  settings and switching a policy off.
- **The setup-portal link is treated as a credential.** Minted only for an owner whose
  session signed in again within the last ten minutes — its own record of a fresh
  authentication during a `reauth` flow (`sessions.fresh_auth_at`, round 2), by any method that
  re-proves who the person is, an emailed code included (the vault reset's lock one, which
  round 1 borrowed, refuses one by design and stranded such owners), dated by WorkOS's
  `auth_time` rather than by when a held-back sign-in was confirmed, and with lock one's
  residual: a live Google or SSO session satisfies it without a prompt. Audited every time,
  never logged or stored, and never placed in the dashboard tab's history (a blocked pop-up
  gets a link the owner clicks, not a navigation).
- **Domains are WorkOS's to verify, never ours to declare**: no `domainData` is ever sent, and
  an SSO sign-in is believed only for an address in a domain WorkOS reports as verified.
  Requiring SSO needs an active connection *and* a verified domain, and the settings count the
  members outside the verified domains before the switch.
- **Just-in-time membership is an explicit opt-in**, admits as `viewer` only, never reinstates
  a suspended member, and never re-admits a removed one: removal leaves a record
  (`org_member_removals`, migration 0022), the refusal is audited as `member.jit_denied`
  (`removed`), and only accepting an invitation sent *after* the removal clears it (round 2).
  A just-in-time join and a removal both withdraw every invitation still open for the address,
  under the organisation's lock, so a leftover link — possibly at a higher role — cannot bring a
  removed person back. The join itself waits for the sign-in confirmation, when there is one.
- **The link records its WorkOS environment** (`workos_client_id`, review S9); the settings
  refuse to act on a link made in another, an enable never adopts one, and the sign-in path
  resolves only links made in its own environment (no just-in-time join, no name on the
  confirmation page, through a foreign link). And **no link can be written from an environment
  the database does not belong to** (round 2): `workos_home` holds the one WorkOS client id the
  database's links may come from (seeded with production's by migration 0023), and turning SSO
  on — the only writer of a link, which checks it in the UPDATE's own predicate too — as well
  as opening the portal and switching a policy on refuse from any other, or while none is
  recorded. Switching a policy off is allowed from anywhere.
- **The owner exemption is audited where a credential is made with it**: at sign-in (each
  exempting organisation), at a CLI device approval by an owner from a non-SSO session, and at
  an owner's invitation accepted from one (round 2). A credential that already existed when the
  requirement went on is not re-audited on each request.
- **The add-on is the blast-radius gate.** An organisation without the single sign-on add-on —
  set by an operator, never self-served — cannot create a WorkOS organisation, open the portal
  or switch a policy on, so cannot attach an identity provider at all.

**Residual risk:** Low–Medium. Whoever is an owner controls the identity provider by design,
and an owner's password stays a way in past it (the break-glass, T3). A compromised customer
identity provider can sign in as any of that organisation's non-owner members, inside its
verified domains — that is what attaching one means, and it is bounded to that organisation.

*T14 — payments (P12) — is held by the billing branch, which merges first and puts its section
here.*

### T15 — The paid secret features as attack surface (P19)

Six new ways for data to move — references, inheritance, overrides, promotion, restore and
webhooks — and three policies. What each could have become, and what stops it:

- **A reference as a permission bypass** (T3). A developer with write access to staging writes
  `${production.DB_PASSWORD}` and pulls staging. Refused at write: every reference must name an
  environment the writer may read (`can()`, the same call a direct pull makes), and refused
  again at read — every contributing environment is authorised for the reader, and a referenced
  secret travels only as the one secret named, never its environment. A service token, pinned
  to one environment, is kept out of the situation entirely (no parent or outward reference on
  a pinned environment, and no token minted on one).
- **A link as a write path onto production** (T3, review round 1). Reading is held to `can()`;
  *writing* through a link is not a read at all. A production environment that inherits from
  staging, or holds a template reading `${staging.DB_HOST}`, takes its values from wherever
  staging's writers put them — so a developer who may change staging but not production changes
  what production runs, without production's grants or deny-by-default being asked. Not refused
  (a shared base of non-secret defaults is a real design), but never silent: a production
  environment newly linked to one that is not production needs `confirmCrossesProtection`, the
  refusal that asks names the source's writers (people and write tokens), and a confirmed link
  files `environment.link_crosses_protection` against production. Only the link being made is
  asked about — the direct parent or a reference the write adds.
- **A server that rewrites a reference** (T7). The declaration is plaintext the server could
  edit, so the client compares the decrypted template text against it and refuses a mismatch;
  every value is still bound by its AAD to its own row and environment, so a server cannot
  relocate a ciphertext into a view either.
- **A forged override** (T7, T9). The first draft sealed overrides to the owner's public key,
  which anybody holding it — the server included — could do: a compromised Worker could have
  set `NODE_OPTIONS` on a developer's machine. Overrides are now GCM under a key HKDF-derived
  from the owner's own private key (spec §2.2 type 13), so only the owner can make one the CLI
  accepts. A service token is refused every override route and no bundle carries one, so an
  override can never reach a CI run.
- **Promotion and restore as laundering** (T3). Both are ordinary writes held to ordinary
  grants on both sides, by a person, in one transaction, audited per secret. A restore is held to
  the instant's value tags, so a client cannot "restore" a value that was never there.
- **Webhooks as exfiltration or SSRF** (T1, T7). Payloads are an allowlist with no field a value
  could go in; endpoints are `https` only, never private, loopback or link-local literals,
  re-checked at every attempt, and redirects are never followed. A Worker cannot reach a
  private network anyway, but a DNS name pointing at one is not stopped by the literal check —
  the egress does that, not the validator. Signing secrets are sealed under the organisation's
  master key and redacted from logs by shape.
- **One tenant's webhook volume as another's outage** (T2, review round 1). Delivery is shared
  infrastructure, and one sweep claimed the oldest twenty-five deliveries in the whole table: a
  single large import into an organisation with several endpoints held every other
  organisation's deliveries behind it for days. A batch write now emits one event per kind of
  change rather than per secret, the sweep takes organisations in turns and keeps claiming under
  a time budget, so one organisation's backlog delays only its own deliveries.
- **Client-enforced policies** (T3). Disabling plaintext export and the secret policy's value
  rules run in the clients that hold the plaintext; a modified client skips them. They are
  documented as guard rails, not boundaries. The name rule, the token policy and every plan gate
  are server-side.
- **Read alerts as a mail bomb** (T1). One email an hour per organisation at most, whatever the
  number of new addresses; sightings are written after the response and never slow or refuse a
  read.

**Residual risk:** Low. The new surface reuses the existing authorisation call at every
crossing, and no feature here gives the server a plaintext it did not already have.

---

## 4. Risk summary

| ID | Threat | Impact | Likelihood | Residual |
|---|---|---|---|---|
| T1 | Unauthenticated attacker | Critical | High | Low |
| T2 | Cross-tenant access | Critical | High | **Medium** |
| T3 | Malicious team member | High | Medium | Medium |
| T4 | Stolen CLI credential | High | Medium | Medium |
| T5 | Compromised CI | High | Medium | **Medium–High** |
| T6 | Database compromise | Low (secrets) | Low | Low |
| T7 | Worker compromise | Critical | Low | **Medium** |
| T8 | Supply chain | Critical | Low–Med | Medium |
| T9 | Insider | Critical | Low | **High (inherent)** |
| T10 | Root key loss | Existential | Low | Low *if drilled* |
| T11 | Vault reset by whoever holds the browser or the inbox | High | Low–Med | **Medium** without MFA; recoverable for 7 days |
| T12 | The emailed escape archive, attacked offline | High | Low–Med | **Medium (accepted)**; Low with a strong passphrase |
| T13 | A customer's identity provider, or whoever can rewire it | Critical (one org) | Low–Med | Low–Medium |
| T15 | The paid secret features (references, overrides, promotion, restore, webhooks, policies) | High | Low–Med | Low |

**Where to spend effort, in order:** T2 (test matrix as a CI gate) · T10 (escrow drills) ·
T7 (dependency discipline, anomaly detection) · T5 (blast-radius limits, OIDC in v2).

## 5. Explicitly out of scope for v1

Nation-state adversaries · physical attacks on Cloudflare or Neon data centres · side-channel
and timing attacks against Web Crypto · malicious Cloudflare or Neon staff · compromise of a
customer's own systems after legitimate secret delivery.

## 6. Review log

| Date | Reviewer | Change |
|---|---|---|
| 2026-08-10 | — | Initial version, Phase 0 |
| 2026-10-12 | — | Identity moves from Firebase to WorkOS AuthKit (ADR 0010): T1 gains login CSRF and account takeover at sign-in; the CSP loses every Google and Firebase source |
| 2026-10-12 | — | T11 added: the vault reset's two locks — lock one is a live session, not a fresh credential, for Google and SSO accounts; a reset opens server-mode secrets and prompts re-shares; the guess budget; MFA as the mitigation, its live check pending |
| 2026-10-12 | — | T11: the product owner's decisions recorded — no waiting period before a reset; the seven-day recoverable reset and the archive emailed at reset time are follow-up P23, which restates T11 |
| 2026-10-14 | — | T11, round 2: lock one checks the access token's `auth_time` against the flow's start (the stripped-`max_age=0` path closed); code requests capped at three per attempt |
| 2026-10-14 | — | P23 built: T11 restated — a reset retains the vault for seven days, recoverable and undeletable, then purged hourly; T12 added — the emailed escape archive as a permanent offline target, the owner's accepted risk, and what it does and does not concede |
| 2026-10-14 | — | P23, review round 1: owner decision recorded — never reset without the archive silently (production without mail refuses; too large needs an explicit choice); T11 gains the way back from a hostile reset and loses "nobody can delete it"; T12 corrected on locked versus unlocked sessions and brief inbox control, states the retained vault is offline-attackable by any unlocked session and its lockout is abuse control, and adds rotating environment keys and the import's preview and e2ee-only targets |
| 2026-10-14 | — | P23, review round 2: T11 states that recovery after a hostile reset may wait up to an hour (the attacker can run the retained vault's lockout to its maximum before the victim's reset locks their sessions); a retained vault can no longer be inserted dated in the future; a locked session's reset preflight no longer reveals the archive's counts or size |
| 2026-10-18 | — | WS-5 (organisation SSO settings), review round 1: Boundary 4 added — a customer-attached identity provider; T1 corrected — `state` and PKCE do not cover the planted-AuthKit-session login CSRF, and the confirmation that does is described; T3 — `sso_required` is enforced per request again, and the owner exemption is recorded as a deliberate break-glass with a cost; T13 added — SSO administration owners-only with a step-up for the credential-grade portal link, JIT never re-admits a removed member, the link records its WorkOS environment, the add-on as the blast-radius gate |
| 2026-10-18 | — | WS-5, review round 2: T1 restated as it now stands — the confirmation → `next` → `?org=` redirect chain closed (no `next` under `/api/`, the deep link honoured only with the warning page's browser-bound token, an SSO sign-in through an organisation the account is not in always held back), sign-out ends the AuthKit session, the last-account cookie, a decline ends the AuthKit session and is audited, inert display of the address and the organisation name; T13 — the portal's own fresh-sign-in record (emailed codes count; dated by `auth_time`), stale invitations withdrawn at JIT join and removal, `workos_home` so no other environment can write a link, foreign links ignored on the sign-in path, the owner exemption audited at CLI approval and owner invitations |
| 2026-10-19 | — | WS-5, review round 3: T1 — reason (b), the not-member hold-back, restated as covering first-time and non-member identities only (in the attack the returning identity is a member of the attacker's organisation; the warning page's token and the `/api` refusal are what stop an unconfirmed deep link); a finished sign-in's `next` never names a sign-in screen; the double-click window swap on the two one-click screens added to what T1 leaves |
| 2026-10-20 | — | P19 (paid secret features): T15 added (written as T14, renumbered in review round 1 because P12 holds T14) — references held to `can()` at write and read, the declaration checked against the decrypted text, overrides made unforgeable by the server (symmetric under the owner's own key, replacing a sealed box), promotion and restore as ordinary audited writes, webhook payload allowlist and endpoint rules, client-enforced policies stated as guard rails, the read-alert throttle |
