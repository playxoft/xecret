# Firebase → WorkOS user migration

How existing users move from Firebase Auth to WorkOS and keep signing in with the same password.
One-off, run by the owner at cutover. The design is `.local/workos-auth.md` §6, with §5 (the
linking rules) and PR #100's "For WS-2" notes 6, 9 and 12.

The tool is `scripts/migrate-users-to-workos.ts`. Its rules live in
`packages/db/src/firebase-migration/`, where the `@xecret/db` test suite covers them.

---

## 1. What it does

Six modes. The three that write are dry runs unless given `--apply`.

| Mode | Talks to | What it does |
| --- | --- | --- |
| **`--check-hash-params <uid>`** | nothing | Asks for that Firebase user's password at a hidden prompt, recomputes their exported hash with the `FIREBASE_SCRYPT_*` parameters, and prints MATCH or NO MATCH. **The only check that catches wrong parameters**, and the import refuses to send password hashes until it has passed. |
| **`--soft-delete-disabled`** | the database | Soft-deletes the rows of Firebase users an operator disabled, unless kept on purpose with `--keep <uid>`. See "Disabled users" below. |
| **import** (default) | WorkOS | Creates one WorkOS user per importable Firebase user. A password user's Firebase scrypt hash goes with it. Each user carries `external_id = firebase uid`. Writes a `firebase_uid → workos_user_id` mapping next to the export. |
| **`--check-sign-in <uid>`** | WorkOS | Signs in to WorkOS as that imported user, with their password typed at a hidden prompt. Proves the import end to end before anything is linked. |
| **`--backfill`** | WorkOS, the database | Runs `UPDATE users SET workos_user_id = $w WHERE firebase_uid = $f AND workos_user_id IS NULL`, row by row. Before that, it re-checks every mapped id against WorkOS. |
| **`--self-test`** | WorkOS | Creates one synthetic user with a hash built exactly as the import builds one, signs in with the right password and a wrong one, and deletes the user. It proves WorkOS verifies the hash format. It is self-consistent, so it cannot catch the wrong project's parameters; that is `--check-hash-params`. |

### Who is imported

| Firebase user | What happens | Why |
| --- | --- | --- |
| Verified email, has a password | Imported **with** its hash | The same password keeps working. |
| Verified email, Google only | Imported **without** a password | WorkOS attaches their Google credential to this user at their first Google sign-in ([identity linking](https://workos.com/docs/authkit/identity-linking)). That needs Google OAuth in WorkOS, see §2. |
| Verified email, another provider only | Imported without a password | They can use "forgot password", or that provider once WorkOS is configured for it. |
| **Unverified email** | **Skipped** | Plan §6 allows "import without a password, or skip". Skip is the stricter choice. Whoever registered an address they don't own must not end up holding a WorkOS user for it. With a password, that is a pre-account-takeover (PR #100 note 12). Even without one, the real owner later collides with it. Nothing is lost: the Firebase sign-in already refuses unverified addresses, so these people have no xecret account. |
| **Disabled** | **Skipped**, and their row must be decided **before the deploy** | See below. |
| No email (phone or anonymous) | Skipped | WorkOS users are keyed by email. |
| Password fields that do not decode | Skipped, and listed | The import does not quietly turn a working password into a forced reset. |
| Had Firebase MFA | Imported, and **listed by uid** | WorkOS cannot import second factors. Ask those people to enrol again in WorkOS. |

Names come from Firebase's `displayName`, falling back to Google's: the first word becomes the
first name and the rest the last name. These fields are for display only.

### Disabled users

WorkOS users have no disabled state, so the import skips disabled Firebase users. **Skipping
alone does not keep them out.** Their xecret row stays active and unlinked. Once the WorkOS
sign-in (#114) is live, they can sign up in AuthKit with the same verified address, and the
linking pass (§5 step 2) adopts that row. Firebase was the only thing keeping them out.

So, **before the deploy**, each disabled user's row is either:

- **soft-deleted** with `--soft-delete-disabled --apply`. Both sign-in paths refuse a deleted row,
  by identity and by address. Their sessions and CLI tokens are revoked in the same transaction:
  Firebase's switch never touched xecret's own sessions, so a disabled user can hold a live one
  today. Nothing else is touched, so no vault, organisation or membership is affected. It is the
  equivalent of Firebase's switch, not an account deletion, and it is undone by clearing
  `users.deleted_at` (sessions stay revoked; the person signs in afresh).
- **kept**, knowingly, with `--keep <uid>`. That person can get back in through WorkOS.

Each soft-delete is recorded in `disabled-users-soft-deleted.json` next to the export. It doesn't
write to the app's audit log: audit records belong to an organisation, and this acts on an account,
while #114 is reshaping the action list.

If the backfill later finds a disabled user's row linked by a WorkOS sign-in, it reports it with
`!!`: that person has access again.

### Idempotency, and WorkOS users that already exist

Every run looks the user up by `external_id`, then by email, and never modifies or deletes an
existing WorkOS user:

- **Found by `external_id`**: imported by an earlier run, so the user is reused. A re-run creates
  nothing.
- **Found by email, verified, no `external_id`, same address**: someone signed up in WorkOS
  directly. That user is **reused** and mapped, with no password and no `external_id` written.
  WorkOS has proven they own the inbox, which is exactly what the linking pass adopts on (§5 step 2).
- **The lookup by email returned a different address** (a Unicode lookalike, say): a **conflict**,
  reported and left alone.
- **Found by email, unverified**: a **conflict**, reported and left alone. An unverified WorkOS user
  may carry a password someone else chose.
- **Found by email with another `external_id`**, or found by `external_id` with a different address
  now: a **conflict**, reported and left alone.

PR #100 note 9 asked whether the import can set `external_id = firebase_uid`. **Yes**, through the
Create User API. The backfill uses it as its proof of identity.

### The record

The script's output, the mapping file and `disabled-users-soft-deleted.json` are the record of the
migration. **Nothing is written to the audit log.** Keep the output of every `--apply` run.

---

## 2. Prerequisites (owner)

- [ ] **Firebase CLI signed in as the project owner.** Run `firebase login --reauth`. On
      2026-10-12 the stored login had expired: Google refused the refresh token.
- [x] **Phase Production has the four `FIREBASE_SCRYPT_*` values** (copied from Development
      2026-10-12; same Firebase project, `xecret-management`). `--check-hash-params` proves
      they are right; their presence alone does not.
- [x] **Phase Production has `WORKOS_API_KEY` and `WORKOS_CLIENT_ID`**, verified as a matching
      pair 2026-10-12.
- [ ] **WorkOS Production authentication settings:**
  - [x] Email + Password on (2026-10-12).
  - [ ] **Google OAuth uses the Firebase project's own Google OAuth client** (plan §8 Q1): copy
        its client ID and secret from Google Cloud Console into WorkOS, and add WorkOS's redirect
        URI to that client. Without this, Google-only users cannot sign in with Google. They can
        still use "forgot password".
- [ ] **Your own Firebase uid**, from the Firebase console (Authentication → Users → User UID),
      for an account that **signs in with a password** whose password you know. The two checks use
      it.
- [ ] **A private directory outside the repository** for the export and everything written beside
      it. The export holds every user's password hash. The script refuses paths inside the
      repository.
- [ ] **A real console.** The two password checks need one: PowerShell or Windows Terminal. In
      Git Bash's default window (mintty), prefix the command with `winpty`. The prompt refuses a
      piped stdin, because a pipe in mintty still shows what you type.

### The two environments

Each `--env` is **pinned** in the script to xecret's WorkOS client. The script refuses a run whose
Phase environment carries a different client, or whose API key WorkOS says belongs to another
environment.

Every `--apply` that touches WorkOS or the links (import, backfill) must also name the client with
`--confirm-client`. Type it from this table: the script never prints it.

| WorkOS environment | `--confirm-client` | Phase environment | npm script |
| --- | --- | --- | --- |
| Staging | `client_01M36CECEQ1FY9TA1F952FY958` | Development | `npm run phase:migrate-users:staging --` |
| Production | `client_01M36CECX3Z66Q2FYY2FN8WG73` | Production | `npm run phase:migrate-users:production --` |

---

## 3. Safety rules the script enforces

- **Dry run unless `--apply`.** A dry run reads WorkOS and the database, and writes nothing.
- **The WorkOS environment is verified, not assumed.**
  - Each `--env` is pinned to a client id, and `WORKOS_CLIENT_ID` must be it.
  - A WorkOS API key does not reveal its environment (the current format is `sk_` plus base64 of
    `key_<id>,<secret>`). WorkOS does, however, say whether a key and a client belong together.
    The script checks that before any other request.
  - Every import or backfill `--apply` needs `--confirm-client`.
  - Any flag given twice (`--env staging … --env production`) is refused.
- **Password hashes are sent only after `--check-hash-params` passed** for the same parameters in
  the same environment. The check leaves `hash-params-verified.<env>.json` next to the export, with
  a fingerprint of the parameters it proved (not the parameters).
- **A mapping is bound to its environment and client id.** The backfill re-checks every id against
  WorkOS and links a row only if:
  - the WorkOS user exists in the environment in use;
  - its email is verified;
  - it is provably this Firebase account: `external_id` equals the uid, or, for a reused user,
    the address matches;
  - and **the current export still imports that Firebase user**. A user disabled since an earlier
    run is never linked, whatever the mapping says.
- **A staging backfill `--apply` is refused.** Development and Production share one database. A
  Staging id in `users.workos_user_id` sits where the Production id belongs: the real Production
  sign-in then hits a `conflict`, and the backfill, which only fills NULLs, can no longer fix it.
  `--staging-database` overrides this only for a self-hoster whose staging database is separate.
- **Everything written lives outside the repository.**
- **Nothing secret is printed.** Users are named by Firebase uid, xecret user id and WorkOS id. No
  hash, salt, hash parameter, key, password or address appears in the output, and WorkOS error
  messages are scrubbed of what the request sent.
- **Never forces.**
  - The backfill only fills a NULL.
  - A row a sign-in already linked is reported, never overwritten.
  - `23505` (`users_workos_user_id_unique`: the id is already on another row) and `23514`
    (`users_workos_user_id_format_check`) are reported for a human to resolve.
  - Each row is its own statement, so one refusal doesn't stop the rest.
- **Soft-deleted rows are linked too.** Linking one does not reopen the account, because the linker
  refuses a deleted row by identity and by address alike. It does mean a row restored later comes
  back already linked, and it leaves one fewer unlinked row for the decommission migration to
  decide about.

### Reading the outcome

The last line of every run is the result:

| Line | Meaning |
| --- | --- |
| `RESULT: ok` | Finished, nothing to review. |
| `RESULT: problems` | Finished. Read the "Problems to review" list just above. |
| `RESULT: refused` | Refused before writing anything. The reason is above it. |
| `RESULT: failed` | A check failed, or something broke. |

**Read the `RESULT:` line, not the exit code.** `phase run` passes 0 and 1 through but turns the
script's 2 ("problems") into 1, so through the npm scripts a run with problems looks like a
failure.

---

## 4. Production cutover

**Order:** decide everything first, deploy the WorkOS sign-in (#114), then export, import and
backfill straight away. Plan §6.3.

Deploying first removes the Firebase sign-in, which freezes every Firebase password. If you import
earlier, anyone who changes their Firebase password between the import and the deploy keeps their
*old* password in WorkOS, because a re-run never modifies an existing WorkOS user.

During the gap between deploy and import, a user who signs in simply signs up in AuthKit: §5 step 2
adopts their account by verified email, and the import then reuses their WorkOS user. **Keep the
gap short.** The checklist below moves every decision before the deploy, so that only mechanical
steps remain after it.

The commands run unchanged in PowerShell and in bash, except where `$DIR` is set. Run them from the
repository root.

### Before the deploy

```bash
# 0. A private directory outside the repository.
#    bash:        umask 077; DIR=/c/Users/<you>/xecret-migration; mkdir -p -m 700 "$DIR"
#    PowerShell:  $DIR = "$HOME\xecret-migration"; New-Item -ItemType Directory -Force $DIR | Out-Null
#                 icacls $DIR /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null

# 1. Sign the Firebase CLI in again, then take a rehearsal export.
firebase login --reauth
firebase auth:export "$DIR/users.json" --format=json --project xecret-management

# 2. Prove the hash parameters against YOUR OWN account (password typed at a hidden prompt).
#    Expect "Hash parameters: MATCH" and RESULT: ok. On NO MATCH, stop: either the password is not
#    the account's current one, or the FIREBASE_SCRYPT_* values are wrong.
npm run phase:migrate-users:production -- --check-hash-params <your firebase uid> --export "$DIR/users.json"

# 3. Prove WorkOS Production verifies the hash format (creates and deletes one synthetic user).
npm run phase:migrate-users:production -- --self-test

# 4. Rehearsal dry run of the import. Read every problem.
#    Note the MFA users it lists: tell them to enrol again after the cutover.
npm run phase:migrate-users:production -- --export "$DIR/users.json"

# 5. Disabled users: list them, decide each one, then apply.
#    Keep someone only if they may have access back: add --keep <uid> per person.
npm run phase:migrate-users:production -- --soft-delete-disabled --export "$DIR/users.json"
npm run phase:migrate-users:production -- --soft-delete-disabled --export "$DIR/users.json" --apply
```

Checklist, all before the deploy:

- [ ] `firebase login --reauth`, and a rehearsal export
- [ ] `--check-hash-params` with your own account: **MATCH**
- [ ] `--self-test`: `RESULT: ok`
- [ ] rehearsal import dry run read; every problem understood
- [ ] every disabled user soft-deleted or kept on purpose (`--soft-delete-disabled` dry run shows no
      pending rows)

### Deploy

Deploy #114 (run the deployment-check skill first). Then, without a break:

### After the deploy

```bash
# 6. The final export: Firebase passwords are frozen now.
firebase auth:export "$DIR/users.json" --format=json --project xecret-management

# 7. Anyone disabled since the rehearsal? Expect no pending rows. If there are, decide and --apply as in step 5.
npm run phase:migrate-users:production -- --soft-delete-disabled --export "$DIR/users.json"

# 8. Import: dry run, read it, then apply.
npm run phase:migrate-users:production -- --export "$DIR/users.json"
npm run phase:migrate-users:production -- --export "$DIR/users.json" --apply --confirm-client client_01M36CECX3Z66Q2FYY2FN8WG73

# 9. One real sign-in with your own imported account, before anything is linked.
#    Expect "Sign-in: OK" and RESULT: ok. If it is refused, stop and do not run the backfill.
npm run phase:migrate-users:production -- --check-sign-in <your firebase uid> --export "$DIR/users.json"

# 10. Backfill: dry run, read it, then apply.
npm run phase:migrate-users:production -- --backfill --export "$DIR/users.json"
npm run phase:migrate-users:production -- --backfill --export "$DIR/users.json" --apply --confirm-client client_01M36CECX3Z66Q2FYY2FN8WG73
```

Re-running any step is safe. The mapping goes to `$DIR/workos-mapping.production.json` unless
`--mapping` points elsewhere.

`--check-sign-in` really signs in to WorkOS. That updates your WorkOS user's last sign-in time and
nothing in xecret.

**Then smoke-test** (plan §6.3):

- password sign-in with an imported user's *existing* password;
- Google sign-in for a Google-only user;
- a new sign-up;
- logout and session revocation;
- vault unlock and reset;
- the CLI PKCE flow.

**Afterwards:**

- Delete the export. It holds every password hash.
- Keep the mapping, `disabled-users-soft-deleted.json` and the saved output of each run until the
  decommission migration. None of them holds a secret.

---

## 5. Resolving what the output lists

| Problem | What it means | What to do |
| --- | --- | --- |
| `skipped (disabled)` / `not imported (disabled)` | A disabled Firebase user whose row is still active. | `--soft-delete-disabled`, or `--keep` it knowingly (§1, "Disabled users"). |
| `!! … LINKED … the Firebase account is DISABLED, and this person has access again` | A disabled user signed in through WorkOS and was adopted. | `--soft-delete-disabled --apply` locks them out again, unless they may stay. |
| `its mapping entry was ignored` | That user was imported by an earlier run but is now skipped (disabled or unverified since). | Nothing is linked. Decide their row as above; delete the WorkOS user if they must not have one. |
| `conflict (email-held-by-unverified-user)` | Someone started a WorkOS sign-up for that address and never verified it. | Delete that WorkOS user in the dashboard, then re-run the import. |
| `conflict (email-lookup-mismatch)` | WorkOS returned a user whose address is not this one. | Investigate in the dashboard. Nothing was changed. |
| `conflict (email-held-by-other-identity)`, `conflict (external-id-email-mismatch)`, `conflict (imported-user-unverified)` | WorkOS holds something that doesn't match this Firebase user. | Investigate in the dashboard. Nothing was changed. |
| `skipped (malformed password)`, or a hash-length error | The export's hash doesn't fit the hash parameters. | Check that the export and the parameters both come from `xecret-management`. |
| `had Firebase MFA` (a note) | Their second factor was not migrated. | Ask them to enrol again in WorkOS. |
| backfill: `already linked to …, mapping says …` | A WorkOS sign-in linked the row first. | Compare the two WorkOS users. Nothing was changed. |
| backfill: `would be 23505`, or `23505: … is already on user …` | Another row holds that WorkOS id. Usually a second account created by a sign-in made before the backfill. | Merge by hand. |
| backfill: `…'s address is held by user …` | The link is right, but another row holds the WorkOS user's current address, so that person's first sign-in will be a 409. | Sort out the two rows by hand (usually: the other row is a duplicate created during the gap). |
| backfill: `mapping entry rejected (…)` | The WorkOS user is missing (wrong environment, or deleted), unverified, or not provably this account. | Re-run the import, or investigate. |
| backfill: `not imported (email-unverified)` | The row stays unlinked. | Nothing. Their first WorkOS sign-in, once verified, adopts it by email (§5 step 2). |
| backfill: `importable but not in the mapping` | The import has not created this user (or reported a problem for it). | Re-run the import and read its problems. |
| backfill: `no such Firebase user in the export` | The Firebase account was deleted. | Decide before the decommission migration (0018's warning). |
| `Firebase users with no xecret row` (count) | They never signed in to xecret. | Nothing. Their first WorkOS sign-in creates their account (§5 step 3). |

---

## 6. Staging rehearsal and cleanup

Run the same commands through `npm run phase:migrate-users:staging --` with
`--confirm-client client_01M36CECEQ1FY9TA1F952FY958`. `--check-hash-params` must pass for staging
too, since the marker is per environment.

`--soft-delete-disabled` and the backfill `--apply` write to the database, which Staging and
Production **share**. The staging backfill `--apply` is refused for that reason. Don't
`--soft-delete-disabled --apply` from a rehearsal unless you mean it: it acts on the real rows.

To remove staging users the import created, delete them in the WorkOS dashboard (Staging → Users),
or by id from the mapping's `created` entries. Keep the API key out of command lines. In
PowerShell, inside `phase shell --env Development`:

```powershell
Invoke-RestMethod -Method Delete -Uri "https://api.workos.com/user_management/users/<user_id>" -Headers @{ Authorization = "Bearer $env:WORKOS_API_KEY" }
```

In bash, the header goes through a here-string, which is part of the shell, so the key never
reaches `curl`'s arguments:

```bash
curl -sS -X DELETE "https://api.workos.com/user_management/users/<user_id>" -K - <<< "header = \"Authorization: Bearer $WORKOS_API_KEY\""
```

Only delete *Production* users before the backfill has linked them. Once a row holds an id,
deleting that WorkOS user strands the row: the person's next sign-up gets a new id, and §5 reports
a conflict.

⚠ **The shared database and Staging sign-ins.** The linking pass adopts accounts by verified email
(§5 step 2). A sign-in to a local or staging build against WorkOS Staging, made with a real user's
address, therefore writes a *Staging* id onto that real row. That blocks the production link
exactly as a staging backfill would. Test WorkOS Staging sign-ins with addresses that have no row
in the shared database.

Also note that in WorkOS Staging, `example.com` belongs to WorkOS's built-in SSO test
organisation, so every password attempt for an `@example.com` user is answered `sso_required`.
The self-test uses `example.net` for that reason.

---

## 7. Rollback, and when this tooling goes

- **Neither the import nor the backfill touches `firebase_uid`.** Rollback stays what plan §6.5
  describes: the column and the Firebase project remain until the decommission migration.
- **Undoing a backfill** means setting those rows' `workos_user_id` back to NULL, but only for rows
  no WorkOS sign-in has used since. Do it by hand, with the mapping in front of you.
- **Undoing a soft-delete of a disabled user** means clearing that row's `deleted_at`, with
  `disabled-users-soft-deleted.json` in front of you.
- **This tooling is deleted in the decommission migration**, together with `users.firebase_uid`:
  `scripts/migrate-users-to-workos.ts`, `packages/db/src/firebase-migration/`, and the
  `migrate:users` / `phase:migrate-users:*` npm scripts.

---

## 8. Verification record

### 2026-10-12, first round

- **Self-test on WorkOS Staging** with the project's hash parameters: every step passed.
- **End to end on Staging with a synthetic export:** created, re-run idempotent, original passwords
  signed in, wrong ones refused.
- **Backfill `--apply` against a throwaway PostgreSQL** (every real migration, the production
  driver): linked, left a sign-in's link alone, reported 23505 and 23514.
- WorkOS Staging and Production left with no users.

### 2026-10-12, review round 1

- **`--check-hash-params` through a real Windows console.** The command ran exactly as in §4
  (`npm run phase:migrate-users:staging -- --check-hash-params …`, so npm → `phase run` → npm →
  tsx) inside a Windows pseudo console (ConPTY, as Windows Terminal uses). The password was typed
  key by key, including a non-ASCII character and a typo corrected with Backspace:
  - the right password, against an export hashed with the real parameters: **MATCH**,
    `RESULT: ok`, marker written;
  - a wrong password: **NO MATCH**, `RESULT: failed`;
  - the right password, against an export hashed with a **wrong signer key**: **NO MATCH**. This is
    the case the self-test cannot see;
  - the password never appeared in the output;
  - a piped stdin was refused (`RESULT: refused`).
- **End to end on Staging, with a synthetic export and a throwaway database:**
  - the import `--apply` refused before `--check-hash-params`, and proceeded after it;
  - the MFA user was listed as a note;
  - `--check-sign-in` returned OK with the right password and REFUSED (`invalid_credentials`)
    with a wrong one.
  - The backfill dry run:
    - ignored the mapping entry of a user disabled since the import;
    - flagged `!!` a disabled user whose row a WorkOS sign-in had linked;
    - warned about a mapped address held by another row.
  - `--soft-delete-disabled`:
    - the dry run listed 3 rows;
    - a `--keep` naming nobody was refused;
    - `--apply --keep <one>` soft-deleted 2 rows, revoked the linked one's session, kept 1 and
      wrote the record.
  - The backfill `--apply` then linked the 3 importable rows and nothing else.
  - The synthetic Staging users were deleted.
- **Refusals:**
  - `--env` given twice;
  - two modes;
  - `--apply` on a check;
  - a `--keep` outside `--soft-delete-disabled`;
  - staging credentials run with `--env production` (pinned client);
  - `--apply` without `--confirm-client`, or with the other environment's client (neither refusal
    prints a client id).
- **Production, read-only:** the key and the pinned client verified. The import dry run reports
  "Hash parameters: present, NOT VERIFIED (never checked)" until the owner runs
  `--check-hash-params`.
- **Still waiting on the owner:** the real export, so the real-user dry run (`firebase login
  --reauth`).
