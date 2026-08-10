# 0003 — Firebase Auth as identity provider only; xecret issues its own sessions

**Status:** Accepted
**Date:** 2026-08-10

## Context

We want Google sign-in and email/password without operating password hashing, reset flows,
email deliverability, or OAuth client registration ourselves. Firebase Authentication is the
chosen provider.

Two complications:

1. **The Firebase Admin SDK cannot run on Cloudflare Workers.** It depends on Node-native
   modules and gRPC. Anything that needs it is off the table.
2. **Firebase ID tokens cannot be revoked.** They are self-contained JWTs valid for roughly
   one hour. If one leaks, there is no server-side kill switch — it stays valid until it
   expires. For a product whose entire job is protecting credentials, that is unacceptable.

## Options considered

### A. Firebase ID token as the API credential on every request
- ✅ Trivial to implement.
- ❌ No revocation. A stolen token is valid for up to an hour with no recourse.
- ❌ Couples every API call to Firebase's token lifetime and refresh behaviour.
- ❌ Gives us nowhere sensible to hang CLI and CI credentials.

### B. Firebase session cookies (via `createSessionCookie`)
- ✅ Longer-lived, revocable through Firebase.
- ❌ Minting them **requires the Admin SDK** or a service-account-signed call to the Identity
  Toolkit REST API — extra complexity in a Worker for no real gain.
- ❌ Still leaves session state owned by Firebase rather than by us.

### C. Firebase for authentication only; xecret mints its own sessions
- ✅ Verify the ID token exactly once, at login.
- ✅ Sessions live in our database — instant revocation, visible device list, one session
  model shared by dashboard, CLI, and CI.
- ✅ No Admin SDK anywhere.
- ✅ Firebase becomes swappable.
- ❌ We own session expiry, rotation, and cookie security. Well-understood work.

## Decision

**Option C.**

```
Browser ──Firebase JS SDK (Google / email+password)──▶ Firebase
Browser ──POST /api/auth/session { idToken }─────────▶ Worker
Worker  ──verify RS256 against Google JWKS (firebase-auth-cloudflare-workers, JWKS cached in KV)
        ──assert aud == projectId, iss, exp, email_verified
        ──upsert user, insert session row
        ──Set-Cookie: __Host-xecret_session; HttpOnly; Secure; SameSite=Lax
Browser ──every later request uses OUR session, never a Firebase token
```

The session cookie carries a 256-bit opaque random token. **Only its SHA-256 hash is
stored** — a database leak does not yield usable sessions.

Verification uses [`firebase-auth-cloudflare-workers`](https://github.com/Code-Hex/firebase-auth-cloudflare-workers):
zero dependencies, Web Standard APIs only, purpose-built for this runtime.
`firebase-admin` is blocked by an ESLint `no-restricted-imports` rule so it cannot arrive as
a transitive convenience later.

Firebase sits behind an `IdentityProvider` interface:

```ts
interface IdentityProvider {
  verifyToken(token: string): Promise<VerifiedIdentity>  // { subject, email, emailVerified }
}
```

## Consequences

### Positive
- Real revocation: "sign out everywhere" and "revoke this device" actually work.
- One session and credential model for browser, CLI, and CI.
- No Node-only dependency can sneak into the Worker bundle.
- We never store or handle passwords.

### Negative
- **Self-hosters must create their own Firebase project.** This is real friction for an
  open-source product and is stated plainly in `docs/self-hosting.md` rather than hidden.
  The `IdentityProvider` interface means a contributor can add a Postgres-native provider
  without touching authorization, crypto, or the API.
- Google is in our availability path for login (not for secret reads — an existing session
  keeps working during a Firebase outage).
- We must get cookie security right ourselves: `__Host-` prefix, `HttpOnly`, `Secure`,
  `SameSite=Lax`, plus CSRF tokens on cookie-authenticated mutations.

### Revisit when
Self-hosting friction shows up repeatedly in issues, or an enterprise customer requires
SAML/OIDC — at which point a second `IdentityProvider` implementation is the answer, not a
rewrite.
