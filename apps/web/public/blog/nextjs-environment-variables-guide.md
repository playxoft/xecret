---
title: Next.js environment variables: what NEXT_PUBLIC_ really does, and the three ways secrets end up in the browser bundle
description: The inlining model for the App Router: build time versus runtime, which .env file wins, the server-only boundary, and how to grep what actually shipped.
keywords: [Next.js environment variables, NEXT_PUBLIC_, server-only secrets, app router env, next.js build time variables]
published: 2026-08-05
author: The xecret team
role: Playxoft
category: Engineering
---

Most Next.js teams can recite the rule — prefix it with `NEXT_PUBLIC_` and it
reaches the browser, leave the prefix off and it does not. The rule is
correct and it is also not enough, because it describes a naming convention
while the thing that actually decides is a build-time text substitution and a
module graph. This is about the App Router in Next.js 16 with React Server
Components; the mechanics differ from the Pages Router in ways that matter.

## The prefix is a substitution, not a permission

`NEXT_PUBLIC_ANALYTICS_ID` is not "a variable the browser is allowed to read".
During `next build`, the bundler finds every literal occurrence of
`process.env.NEXT_PUBLIC_ANALYTICS_ID` in code destined for the client and
replaces the expression with the value as a string constant. There is no
lookup at runtime. There is no `process.env` in the browser. There is a
JavaScript file with your value typed into it.

Three consequences follow, and each one surprises somebody:

**The value is public forever, not merely public now.** It is baked into a
static asset. Every previously deployed build that is still reachable — a
preview deployment, a CDN edge holding an old chunk, a customer's browser
cache — contains the value you had at that build. Changing it later publishes
a new constant; it does not retract the old one. If you ever prefixed a real
credential, rotation is the only remedy.

**Only literal references are substituted.** The bundler is doing textual
replacement, so `process.env.NEXT_PUBLIC_X` is replaced and
`process.env[name]` is not, and neither is a destructured `const { NEXT_PUBLIC_X } = process.env`.
People discover this when a dynamic lookup returns `undefined` in production
and works in `next dev`, where a real Node process with a real environment is
running underneath.

**Unprefixed variables in client code become an empty string.** Next.js does
not leave `process.env.STRIPE_SECRET_KEY` alone in a client bundle — it
substitutes an empty string. This is a genuinely good default, and it is also
why the failure mode of leaking is usually a confusing `401` rather than a
loud error.

## Build time and runtime are different moments

The second concept people conflate. There are two distinct occasions on which
a value can be read, and which one applies decides where the value has to
exist.

| Read at | Applies to | Where the value must be present |
|---|---|---|
| Build | Every `NEXT_PUBLIC_` reference, and anything read while prerendering a static route | The environment of the machine running `next build` |
| Request | `process.env` in a dynamically rendered Server Component, Route Handler or Server Action | The environment of the running server, at the moment of the request |

This is what bites on a serverless or edge deploy. You set a variable in your
platform's dashboard, redeploy, and the server-side code picks it up while the
client-side one stubbornly shows the old value — because the client-side one
was frozen into a chunk during the build that ran before your change, and the
platform's dashboard variables were injected into the *runtime*, not the
build. The same asymmetry is why promoting a single Docker image between
staging and production works for server secrets and silently does not work for
`NEXT_PUBLIC_` values: one image, one build, one set of baked constants.

If you need a value to be genuinely per-deployment on the client, it cannot be
an inlined constant. It has to be fetched — from a Route Handler, or read on
the server during dynamic rendering and passed down. Which brings us, shortly,
to the third leak.

## Which file wins

Next.js resolves each variable by looking in these places in order and
stopping at the first hit:

1. `process.env` — the real environment of the process
2. `.env.$(NODE_ENV).local`
3. `.env.local` — skipped entirely when `NODE_ENV` is `test`
4. `.env.$(NODE_ENV)`
5. `.env`

The first line is the one worth internalising: **the real process environment
beats every file.** That is why an injector works without any code change —
`xecret run -- next dev` populates the process environment before Next.js
starts, so the files become unnecessary rather than overridden.

`NODE_ENV` takes only `production`, `development` or `test`, and if you have
not set it Next.js assigns one: `development` for `next dev`, `production` for
every other command. So
`.env.production` is loaded during `next build` and `next start` on your own
laptop too, which trips people who assumed the filename referred to their
hosting environment rather than to `NODE_ENV`.

> **Warning** — The `env` key in `next.config.ts` is a different mechanism with
> a much worse default. Anything listed there is inlined into the client
> bundle regardless of its name; the `NEXT_PUBLIC_` prefix only governs values
> arriving through the environment or `.env` files. A secret placed in that
> config object ships to the browser with no prefix and no warning.

## The three ways a secret reaches the browser

### 1. The prefix applied to something that should not have it

The mundane one, and the most common. It happens for a specific and
sympathetic reason: a value read fine on the server, someone moved the code
into a Client Component, the value became an empty string, and adding
`NEXT_PUBLIC_` made the error go away. The prefix is now doing exactly what it
promises, and the promise was the wrong one.

The tell is semantic, not syntactic. Ask of every prefixed variable: *if I
posted this in a public issue, what would I have to rotate?* Publishable keys,
project ids, public API base URLs and analytics tokens survive that question.
Anything with `secret`, `private`, `password`, `token` or a service account in
it does not.

### 2. A server module pulled into the client graph

In the App Router the boundary is the module graph, not the file's location.
A file is server-only until something reachable from a `'use client'` module
imports it — at which point it and everything it imports are compiled for the
browser.

Next.js blanks unprefixed `process.env` reads in that bundle, so this usually
does not leak the credential itself. What it does leak is everything else in
the module: internal hostnames, undocumented endpoints, query shapes, table
names, the structure of your admin API. And there is one shape where the
actual value does ship — a literal in the source:

```ts
// lib/payments.ts — the fallback is a string literal, not an env read.
// Nothing blanks it. If this module reaches the client graph it ships verbatim.
const key = process.env.STRIPE_SECRET_KEY ?? 'sk_live_51H8xExampleNotARealKey';
```

The fix is to make the boundary explicit rather than remembered:

```ts
// lib/payments.ts
import 'server-only';

export async function chargeCard(amount: number) {
  const key = process.env.STRIPE_SECRET_KEY;
  // …
}
```

`server-only` has no runtime behaviour. Importing it makes the build fail —
at build time, with a stack trace naming the offending import chain — the
moment anything in the client graph reaches this module. That failure is the
entire product. Put it at the top of every module that touches a credential, a
database handle or a signing key, and the import boundary stops depending on
whether the person doing the refactor happened to remember it.

### 3. A config object serialised into props

This is the one that actually leaks values in a modern App Router codebase,
and no prefix rule protects you from it.

Props passed from a Server Component to a Client Component are serialised into
the RSC payload, which is embedded in the HTML document the browser receives.
Not fetched, not derived — inlined in the response, viewable with *view
source*. So a Server Component that reads a secret and passes an object
containing it across the boundary has published it, whatever the variable was
called.

```tsx
// app/settings/page.tsx — a Server Component
import { ClientPanel } from './client-panel';

export default async function Page() {
  // Reading these on the server is fine. Handing the object to a Client
  // Component is not: every field is serialised into the HTML.
  const config = {
    region: process.env.AWS_REGION,
    apiBase: process.env.NEXT_PUBLIC_API_BASE,
    signingKey: process.env.WEBHOOK_SIGNING_KEY,
  };

  return <ClientPanel config={config} />;
}
```

The habit that prevents it is to pass the *result* of using a secret rather
than the secret, and to construct props field by field rather than spreading a
config object across the boundary:

```diff
-  return <ClientPanel config={config} />;
+  // Explicit fields, so adding a secret to `config` later cannot silently
+  // start shipping it to the browser.
+  return <ClientPanel region={config.region} apiBase={config.apiBase} />;
```

The same rule applies to database rows. `<UserCard user={user} />` where
`user` came straight from an ORM sends the password hash and the session token
to the browser, because the serialiser has no opinion about which columns you
meant. React's experimental taint APIs exist to catch this, but the durable
practice is narrower: never spread a server-side object into client props.

> **Tip** — Make the boundary reviewable. If every `'use client'` component
> takes explicitly named primitive props, a code review can check the leak by
> reading a function signature instead of tracing an object.

## Checking what actually shipped

Do not reason about this. Grep it. After a build, two places matter, and
checking only the first is the common mistake.

```bash
npx next build

# 1. The static chunks — where an inlined NEXT_PUBLIC_ value lands.
grep -rl 'sk_live_' .next/static/

# 2. The rendered HTML — where serialised props land. Start the app first.
npx next start &
curl -s http://localhost:3000/settings | grep -o 'sk_live_[A-Za-z0-9]\{6\}'
```

Search for the *value*, or a distinctive prefix of it, rather than for the
variable's name — the name is exactly what disappears during inlining. Run
both checks in CI against a known-bad canary string and you have a regression
test for the whole class of problem.

## Where xecret fits

Clearly marked so you can skip it. None of the above is solved by where the
values are stored — the inlining model is the same whichever tool fills
`process.env`. What a tool can do is make the build-time step unmissable and
the values themselves accountable: with xecret you run `xecret run -- next
build` so the build has the environment it needs, keep one value per
environment rather than a `.env.local` per laptop, and get an audit record of
every read. The [Next.js guide](/docs/guides/nextjs) covers the deployment
patterns, [the quickstart](/docs/quickstart) is five minutes, and the
[trust model](/docs/security/trust-model) states plainly what we can and cannot
see — server-side envelope encryption, so we can technically decrypt, which is
the trade that makes team sharing and CI tokens work without a key exchange.
It is pre-alpha; [everything is currently on for everyone](/pricing) with no
card collected.
