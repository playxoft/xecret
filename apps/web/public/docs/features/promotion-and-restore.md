---
title: Environment promotion and point-in-time restore
navTitle: Promotion and restore
description: Promote values from staging to production with a masked diff, and put an environment back the way it was at an earlier moment — atomically, and without losing history.
keywords: [environment promotion, promote secrets, secret diff, point in time restore, secrets rollback]
updated: 2026-10-20
---

Two ways of changing many secrets at once, both on the Pro plan and above, and
both built the same way: your browser decides what changes and re-encrypts each
value, and the server writes the lot in **one transaction** — all of it, or none.

## Promotion

*Environment → Promote from…* on the environment you are promoting **into**.
Pick the source, and the dashboard shows the difference between the two:

| Status | Means |
|---|---|
| Added | The source has it; the target does not |
| Changed | Both have it, with different values |
| Unchanged | Both have it, with the same value |
| Removed | The target has it; the source does not — removed only if you tick it |

Values are **masked** until you ask to see one. Choose what to include, check the
preview, apply.

What travels is the source's own secrets — not values it inherits from a
parent — with their types. A template travels as a template, and the templates
of one promotion are checked together, so a template can travel with the
values it refers to.

Your browser reads both environments, decrypts each value, and encrypts it again
under the **target's** key for the target's row. The server cannot read either
side and does not try; what it checks is everything it can:

- you can read the source, and create and update — and, if you remove anything,
  delete — in the target;
- every name written is one the source holds, with the source's type, and every
  name removed is one the target holds and the source does not;
- the target's [secret policy](policies.md#secret-naming-and-strength) for every
  name the promotion introduces;
- no template is left referring to nothing.

A promotion is a person's act: service tokens cannot promote. It is recorded as
one `environment.promoted` event with the counts, plus the ordinary
`secret.created`, `secret.updated` and `secret.deleted` records for each secret,
so every secret's own history shows it.

## Point-in-time restore

*Environment settings → Restore to a point in time*. Pick a moment, and the
preview — which always comes first — lists what restoring to it would do:

| Action | Means |
|---|---|
| Update | The secret's value then differs from now; it gets its old value back |
| Recreate | The secret existed then and has been deleted since; it comes back |
| Delete | The secret was created since; it is removed |
| Unchanged | Nothing to do |

### Restore never deletes history

It writes **forward**. An old value comes back as a *new* version; a removed
secret is soft-deleted, its history kept; a deleted one is created again beside
the old record rather than undeleted, so the fact that it was deleted stays on
the record. A restore is therefore itself restorable: undoing one is restoring
to the moment before it.

### How far back

| Plan | Window |
|---|---|
| Pro | 30 days |
| Team | 180 days |
| Enterprise | 365 days |

A point outside your plan's window is refused, naming the plan whose window
reaches it.

### Older keys

A value written before a key rotation is encrypted under the key that was
active then. Your browser opens it with your grant for that older key, which a
rotation keeps. A value under a key you never held cannot be restored by you;
the preview says which, and the restore leaves those as they are and lists them.

Each value your browser sends back is checked against the one stored for that
moment, so a stale or mistaken client cannot restore the wrong value.

The preview reads the environment as it was, and is recorded as a `secret.read`.
The restore itself is one `environment.restored` event with the moment and the
counts, plus the per-secret records.

### What is not restored

Names are not versioned: a secret renamed since keeps today's name. Notes and
declared types are labels on the secret, not on a version, and are not rolled
back either.

## Both features

End-to-end encrypted environments only. Neither asks the plan on any read, and
neither changes what a pull or a CI run receives except by the values it writes.

## Next

- [Webhooks](webhooks.md) — `environment.promoted` and `environment.restored` events.
- [The audit log](../security/audit-log.md) — every record these write.
