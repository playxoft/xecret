---
title: How to rotate a secret without taking production down
description: Rotation is avoided because it is a distributed change, not a hard one. The overlap pattern, finding every consumer first, and what to do without overlap.
keywords: [secret rotation, key rotation, rotate API keys, credential rotation, zero downtime rotation]
published: 2026-06-30
author: The xecret team
role: Playxoft
category: Practices
---

Typing a new password is not the hard part. `ALTER ROLE app WITH PASSWORD` takes
four seconds and nobody has ever been afraid of it. The reason a credential
issued three years ago is still live is that changing it is a **distributed
change**: the value lives in more places than the person changing it can
enumerate, and every one of those places fails at a different moment after the
old value stops working.

So rotation gets deferred until an incident forces it, which is precisely when
you have the least appetite for a distributed change you have never rehearsed.

## Find every consumer before you touch anything

The step people skip. You cannot make a change safely across a set you have not
listed, and the list is never the one in your head.

Four places to look, in the order that usually pays:

**Your secret manager's audit log.** This is where an audit log earns its keep.
If reads are recorded per actor, thirty days of history is a consumer list
somebody else already wrote for you: which service tokens pulled the
environment, which people revealed the individual value, and when. In xecret
that is `secret.read` for a bulk pull and `secret.revealed` for a single value,
both attributed to a named person or a named token — see [the audit
log](/docs/security/audit-log).

**The provider's own key usage view.** Many API providers show a last-used
timestamp per key, and some show the calling IP. A key with no use in ninety
days is a different rotation from one serving a thousand requests a minute.

**Your code and infrastructure.** Grep for the variable name across every
repository, not just the obvious one — then the Terraform state, the Kubernetes
manifests, the CI configuration and the container image definitions.

**People.** Ask. Somebody has it in a `.env` on a laptop, and somebody's cron
job on a box nobody owns has been using it for two years. The audit log usually
shows you these before anybody admits to them.

Write the result down as a table you can tick off, with a column for how each
consumer picks up a new value. That column determines your whole plan: one that
re-reads on every request needs only the new value; one that reads at boot needs
a restart; one that caches a signed session for thirty days needs a thirty-day
window.

> **Tip** — Do this inventory once, properly, and keep the file. The second
> rotation of the same credential is an afternoon rather than a project, and the
> emergency rotation at 3am becomes a checklist you already trust.

## The overlap pattern

Almost every safe rotation is the same five steps. The name varies — dual
credentials, overlap, make-before-break — but the property is what matters:
**at no moment is the only valid credential one that some consumer has not got
yet.**

```text
1. Issue      new credential, alongside the old one
2. Overlap    both valid — nothing has changed for any consumer
3. Migrate    move consumers one at a time, verifying each
4. Verify     prove the old credential has no traffic
5. Revoke     the old credential, and only then
```

Step 2 is where the safety lives. During the overlap your rollback is "keep
using the old one" — no coordination, no deploy. A big-bang rotation converts a
routine change into an outage whose rollback involves typing an old password
back in from memory.

Step 4 is the one that gets rushed, and it causes most of the outages that do
happen: somebody revokes because the migration *looked* complete, and the
consumer nobody knew about fails at 02:00 on its next scheduled run. Do not
infer that the old credential is unused — prove it, and give the proof enough
time to cover your slowest consumer's cycle. A nightly job needs a night.

## Which credentials support overlap, and what to do when they do not

| Credential type | Two valid at once? | Strategy |
|---|---|---|
| API key at a SaaS provider | Usually | Issue a second key, migrate, delete the first. The common case. |
| OAuth client secret | Often | Many providers allow two active secrets with an overlap window. Check before you plan. |
| Webhook signing secret | Often | Verify against both secrets during the window; sign with the new one after. |
| Database password on one role | No | Create a *second login role* with the same grants; migrate connection strings; drop the old role. |
| Database where a second role is impossible | No | Scheduled window with connection draining, or put a connection pooler in front that holds the real credential. |
| Symmetric signing key (HMAC) | Yes, with a key id | Verify against a set, sign with one. |
| Asymmetric signing key (JWT `RS256`) | Yes, with `kid` and a JWKS | Publish both public keys, switch signing after propagation, retire after the token lifetime. |
| TLS certificate | Yes | Ordinary renewal overlap; serve the new chain before the old expires. |
| SSH key | Yes | Add the new public key, migrate clients, remove the old one. |
| Encryption key for data at rest | Special case | Not a rotation but a re-encryption — unless you use envelope encryption, where rotating the outer key rewraps a handful of data keys instead of every row. |
| Cloud account root credential | Yes, technically | Overlap is available; the inventory is the hard part, and it is usually enormous. |

The row worth dwelling on is the database password, because it is the one people
assume is impossible and then schedule downtime for.

### Rotating a database password with no window

The trick is to stop treating the login role as the thing that holds
permissions. Put the grants on a group role, and login roles become disposable:

```sql
-- Do this once, long before you need it. Grants live here, not on a login.
CREATE ROLE app_rw NOLOGIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;

-- Rotation, step 1: a new login role with the same authority.
-- Both roles are now valid. Nothing has broken.
CREATE ROLE app_2026_07 LOGIN PASSWORD :'new_password' IN ROLE app_rw;

-- Steps 3 and 4 happen outside the database: update the connection string
-- in your secret manager, restart consumers, then watch who is still connected.

-- Step 5, once the old role has shown no sessions for longer than your
-- longest-lived process.
DROP ROLE app_2026_06;
```

The verification is a single query, and it is the reason this works:

```bash
psql "$ADMIN_URL" -Atc "
  select usename, count(*), max(backend_start)
  from pg_stat_activity
  where usename like 'app\_%'
  group by usename
  order by usename"
```

Zero rows for the old role, sustained across a full cycle of your slowest
scheduled job, is the evidence you need before step 5. A connection pooler
complicates this — the pool holds connections open, so restart the pool, not
just the application.

Where a second role genuinely is not available, the fallback order is: put a
pooler in front so the application never holds the real credential; failing
that, drain connections during a scheduled window and accept a short one;
failing that, the credential is a single point of failure, and that fact belongs
in a risk register rather than in a runbook.

### Rotating an API key

The easy one, and worth writing down so the order is not improvised: issue the
new key, store it, roll the consumers, confirm zero usage on the old key at the
provider, delete the old key. Do not delete first and create second because the
provider's interface puts the buttons in that order.

If consumers read the value at process start, "roll the consumers" means a
restart, and that restart is the real change — plan it like any deploy, one
environment at a time, production last.

### Rotating a signing key

Signing keys are the one type where the overlap has a length you can calculate,
and calculating it is not optional.

A signature outlives the moment it was made. If sessions last thirty days, a
token signed today must still verify in twenty-nine days' time, so the old
*verification* key cannot retire for at least thirty days after its last
signature. The sequence is three states, not two:

1. **Sign with old, verify with old and new.** The new key is published and
   trusted before anything uses it. Wait for propagation — caches, CDNs, client
   JWKS refresh intervals.
2. **Sign with new, verify with old and new.** The switch. Everything issued
   from now on carries the new key.
3. **Verify with new only.** Reached no earlier than the last signature with the
   old key plus the maximum lifetime of anything it signed.

This only works if every signature says which key made it. That is what a key id
is for — `kid` in a JWT header, a version prefix in a token you designed
yourself. Without one, verification has to try every key in turn, which works
and destroys two things you need: you can no longer tell a rotation in progress
from an attacker feeding you garbage, and you can never prove the old key is
unused, so retiring it becomes a guess.

## Make secret rotation boring by rehearsing it

The difference between a team that rotates comfortably and one that does not is
not tooling. It is that the first team has done it before, on a day when nothing
was wrong.

- Rotate a development credential on a fixed schedule you did not choose — the
  first Monday of the month — so the procedure gets exercised by whoever is on
  rota rather than by whoever wrote it.
- Rotate staging monthly, using the production runbook verbatim. A runbook that
  does not survive staging will not survive production.
- Make the first production rotation the fourth time you have run it.
- Keep the consumer inventory in version control beside the runbook, and update
  it during the rotation rather than after.
- Time it. "Rotation takes forty minutes and one person" is the sentence that
  gets a rotation approved during an incident.

An emergency rotation is then the same procedure with the overlap compressed to
minutes — survivable precisely because everything else about it is familiar.

## Where xecret fits

In its own section, so you can skip it. xecret does not rotate credentials at
your providers — nothing can, since only Stripe can issue a Stripe key. What it
does is remove the two things that make rotation frightening: there is one place
the value is edited rather than a dozen files on a dozen laptops, and there is
an append-only record of every read, so "who is still using this?" has an answer
before you start rather than after something breaks. Writes are versioned, so
the previous value stays visible and restorable during the overlap. Values are
decrypted server-side and we can technically read them — the model is written
out plainly in the [trust model](/docs/security/trust-model) — which is the
trade that makes CI tokens and team sharing work without a key exchange. The
[quickstart](/docs/quickstart) takes five minutes, and [what it
does](/features) is the short version.
