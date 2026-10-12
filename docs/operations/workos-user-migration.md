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
| **`--soft-delete-disabled`** | the database | Soft-deletes the rows of Firebase users an operator disabled, settles their organisation memberships, or keeps them on purpose with `--keep <uid>`. Every decision is recorded and honoured by later runs. See "Disabled users" below. |
| **import** (default) | WorkOS | Creates one WorkOS user per importable Firebase user. A password user's Firebase scrypt hash goes with it. Each user carries `external_id = firebase uid`. Writes a `firebase_uid → workos_user_id` mapping next to the export. |
| **`--check-sign-in <uid>`** | WorkOS | Signs in to WorkOS as that imported user, with their password typed at a hidden prompt, then revokes the WorkOS session that sign-in opened. Proves the import end to end before anything is linked. |
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
  by identity and by address. In the same transaction:
  - their **sessions and CLI tokens are revoked**. Firebase's switch never touched xecret's own
    sessions, so a disabled user can hold a live one today.
  - their **memberships are settled the way account deletion settles them.** A deleted user who
    stays a member is invisible on the members page but still holds a seat and still counts as an
    active owner, so a co-owner could leave an organisation owned only by someone who can never
    sign in. So:

    | Membership | What happens |
    | --- | --- |
    | An organisation with other members | The membership is **removed**, and its grants go with it. |
    | Their **only active owner** among other members | **Refused**: nothing at all is written for that user. Make another member an owner first (§5), or keep them. |
    | An organisation they are **alone in** | Left exactly as it is, so a later restore gets it back. Account deletion soft-deletes these; this is a suspension, not an erasure. |

  - The vault is not touched.
- **kept**, knowingly, with `--keep <uid>`. That person can get back in through WorkOS.

The dry run lists each pending user's memberships and what would happen to each one, with the
organisations by id and name.

**Every decision is recorded** in `disabled-users-decisions.json` next to the export: soft-deleted
(with what was revoked and removed), kept, no row, or already deleted. **A recorded keep is
honoured by every later run** without repeating `--keep`, so the re-check after the final export
does not soft-delete someone you decided to keep. To change a recorded decision, delete its entry
from that file and run `--soft-delete-disabled` again.

The import and the backfill read the same file. A disabled user with a decision is a note
("kept active on purpose (decided <date>)"), and one without a decision is a problem.

Clearing `users.deleted_at` restores a soft-deleted account and its solo organisations. Removed
memberships, revoked sessions and revoked CLI tokens stay gone: the person is re-invited and signs
in afresh.

Nothing is written to the app's audit log. Audit records belong to an organisation, this acts on an
account, and #114 is reshaping the action list. The decisions file and the output are the record.

If the backfill later finds a disabled user's row linked by a WorkOS sign-in, and they weren't kept
on purpose, it reports it with `!!`: that person has access again.

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

The script's output, the mapping file and `disabled-users-decisions.json` are the record of the
migration. **Nothing is written to the audit log.** Keep the output of every `--apply` run by
piping it to a file as well as the screen. Use the same file name, so each run appends:

- bash: `npm run … --apply … 2>&1 | tee -a "$DIR/apply.log"`
- PowerShell: `npm run … --apply … 2>&1 | ForEach-Object { "$_" } | Tee-Object -Append -FilePath "$DIR\apply.log"`.
  The `ForEach-Object` turns error lines into plain text; without it, Windows PowerShell wraps each
  one in `NativeCommandError` noise.

Use one shell for all the runs: Windows PowerShell writes the file as UTF-16 and bash as UTF-8, so
mixing the two garbles it. Don't pipe the two password checks: they need nothing kept, and are
best left attached to the terminal.

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
- [ ] **A real console for the two password checks: PowerShell, or any shell inside Windows
      Terminal.** Git Bash inside Windows Terminal works. Git Bash's own window (mintty) does not:
      there, stdin is a pipe that still shows what you type, so the prompt refuses it. `winpty`
      does not help either, because `winpty npm …` fails with "npm: Not found in PATH".

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
repository root. Keep the output of every `--apply` by appending the capture from §1, "The record"
(`2>&1 | tee -a "$DIR/apply.log"` in bash, or
`2>&1 | ForEach-Object { "$_" } | Tee-Object -Append -FilePath "$DIR\apply.log"` in PowerShell).

### Before the deploy

```bash
# 0. A private directory under your user profile, readable by you alone.
#    PowerShell:
#      $DIR = "$HOME\xecret-migration"; New-Item -ItemType Directory -Force $DIR | Out-Null
#      icacls $DIR /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
#    Git Bash (umask and chmod do nothing on Windows drives there; icacls does):
#      DIR="$HOME/xecret-migration"; mkdir -p "$DIR"
#      MSYS_NO_PATHCONV=1 icacls "$(cygpath -w "$DIR")" /inheritance:r /grant:r "$USERNAME:(OI)(CI)F"
#    Either way, `icacls <dir>` should then list only you.

# 1. Sign the Firebase CLI in again, then take a rehearsal export.
firebase login --reauth
firebase auth:export "$DIR/users.json" --format=json --project xecret-management

# 2. Prove the hash parameters against YOUR OWN account (password typed at a hidden prompt;
#    PowerShell or Windows Terminal, see §2). Expect "Hash parameters: MATCH" and RESULT: ok.
#    On NO MATCH, stop: either the password is not the account's current one, or the
#    FIREBASE_SCRYPT_* values are wrong.
npm run phase:migrate-users:production -- --check-hash-params <your firebase uid> --export "$DIR/users.json"

# 3. Prove WorkOS Production verifies the hash format (creates and deletes one synthetic user;
#    if it reports that the delete failed, see §6).
npm run phase:migrate-users:production -- --self-test

# 4. Rehearsal dry run of the import. Read every problem.
#    Note the MFA users it lists: tell them to enrol again after the cutover.
npm run phase:migrate-users:production -- --export "$DIR/users.json"

# 5. Disabled users. The dry run lists each one with their organisation memberships and what
#    would happen to each. Decide each person, then apply ONE of these:
npm run phase:migrate-users:production -- --soft-delete-disabled --export "$DIR/users.json"
#    soft-delete them all:
npm run phase:migrate-users:production -- --soft-delete-disabled --export "$DIR/users.json" --apply
#    or keep some on purpose, one --keep per person kept (recorded; later runs honour it):
npm run phase:migrate-users:production -- --soft-delete-disabled --export "$DIR/users.json" --apply --keep <uid> --keep <uid>
#    A user the dry run marks "--apply would REFUSE" is the only active owner of an organisation
#    with other members: make another member an owner first (§5), or --keep them.
```

Checklist, all before the deploy:

- [ ] `firebase login --reauth`, and a rehearsal export
- [ ] `--check-hash-params` with your own account: **MATCH**
- [ ] `--self-test`: `RESULT: ok`
- [ ] rehearsal import dry run read; every problem understood
- [ ] every disabled user soft-deleted or kept on purpose: the `--soft-delete-disabled` dry run
      lists nothing "to soft-delete", and shows each kept user as "kept active on purpose
      (decided …)"

### Deploy

Deploy #114 (run the deployment-check skill first). Then, without a break:

### After the deploy

```bash
# 6. The final export: Firebase passwords are frozen now.
firebase auth:export "$DIR/users.json" --format=json --project xecret-management

# 7. Anyone disabled since the rehearsal? Your recorded decisions are honoured, so expect nothing
#    "to soft-delete". If someone new appears, decide and --apply as in step 5.
npm run phase:migrate-users:production -- --soft-delete-disabled --export "$DIR/users.json"

# 8. Import: dry run, read it, then apply.
npm run phase:migrate-users:production -- --export "$DIR/users.json"
npm run phase:migrate-users:production -- --export "$DIR/users.json" --apply --confirm-client client_01M36CECX3Z66Q2FYY2FN8WG73

# 9. One real sign-in with your own imported account, before anything is linked.
#    Expect "Sign-in: OK", "WorkOS session … revoked" and RESULT: ok.
#    REFUSED: stop, and do not run the backfill. See "If the sign-in check is refused" below.
npm run phase:migrate-users:production -- --check-sign-in <your firebase uid> --export "$DIR/users.json"

# 10. Backfill: dry run, read it, then apply.
npm run phase:migrate-users:production -- --backfill --export "$DIR/users.json"
npm run phase:migrate-users:production -- --backfill --export "$DIR/users.json" --apply --confirm-client client_01M36CECX3Z66Q2FYY2FN8WG73
```

Re-running any step is safe. The mapping goes to `$DIR/workos-mapping.production.json` unless
`--mapping` points elsewhere.

`--check-sign-in` really signs in to WorkOS, then revokes the WorkOS session that sign-in opened, and
says so. It touches nothing in xecret. If it reports that the revoke failed, end that session in the
WorkOS dashboard (Users → your user → Sessions).

#### If the sign-in check is refused

Nothing is linked yet, so this is fully recoverable. What to do depends on the code it printed:

- **`invalid_credentials`**: first, try once more, carefully. If it is refused again, the imported
  hashes are wrong:
  1. Delete the WorkOS users the import made. They are the mapping's `created` and
     `already-imported` entries (both carry `external_id` = the Firebase uid). **Never** delete the
     `reuse-existing` ones: those signed up themselves. In PowerShell (`phase shell` starts a new
     shell, so `$DIR` is set again inside it):

     ```powershell
     phase shell --env Production --shell powershell
     $DIR = "$HOME\xecret-migration"
     $m = Get-Content "$DIR\workos-mapping.production.json" -Raw | ConvertFrom-Json
     foreach ($e in $m.entries.PSObject.Properties) {
       if ($e.Value.outcome -in @('created', 'already-imported')) {
         Invoke-RestMethod -Method Delete -Uri "https://api.workos.com/user_management/users/$($e.Value.workosUserId)" -Headers @{ Authorization = "Bearer $env:WORKOS_API_KEY" } | Out-Null
         "deleted $($e.Value.workosUserId)"
       }
     }
     exit
     ```

  2. Delete `$DIR/workos-mapping.production.json` and `$DIR/hash-params-verified.production.json`.
  3. Fix the `FIREBASE_SCRYPT_*` values in Phase Production, then run steps 2, 8 and 9 again.
- **Any other code** (`mfa_enrollment`, `mfa_challenge`, `radar_…`, `sso_required`,
  `email_verification_required`): something in front of the password check refused, so the hashes
  may be fine. Check the WorkOS Production authentication settings (MFA required? Radar?), then run
  step 9 again.

**Then smoke-test** (plan §6.3):

- password sign-in with an imported user's *existing* password;
- Google sign-in for a Google-only user;
- a new sign-up;
- logout and session revocation;
- vault unlock and reset;
- the CLI PKCE flow.

**Afterwards:**

- Delete the export. It holds every password hash.
- Keep the mapping, `disabled-users-decisions.json` and `apply.log` until the decommission
  migration. None of them holds a secret.

---

## 5. Resolving what the output lists

| Problem | What it means | What to do |
| --- | --- | --- |
| `disabled, and nothing decided yet` / `not imported (disabled) … soft-delete its row` | A disabled Firebase user with no recorded decision. | `--soft-delete-disabled`: soft-delete them, or `--keep` them knowingly (§1, "Disabled users"). |
| `disabled — kept active on purpose (decided …)` and the other `decided` notes | The decision recorded in `disabled-users-decisions.json`. | Nothing. To change it, delete the entry from that file and run `--soft-delete-disabled` again. |
| `--apply would REFUSE it` / `REFUSED, nothing written — sole active owner among others in <org>` | That disabled user is the only active owner of an organisation others belong to. Removing them would leave nobody able to administer it. | Make another member an owner first. Nobody can do that in the app while its only owner cannot sign in, so do it in the database: `npm run phase:studio`, table `org_members`, the row with that `org_id` and the chosen member's `user_id`: set `role` to `owner` and `custom_role_id` to null. Then re-run. Or `--keep` them. |
| `the decision was made but NOT written to …` | The database change happened, but the decisions file could not be written (permissions, a full disk). | Fix the cause, then paste the printed entry into the file's `entries` by hand. |
| `!! … LINKED … the Firebase account is DISABLED, and this person has access again` | A disabled user signed in through WorkOS and was adopted, and was not kept on purpose. | `--soft-delete-disabled --apply` locks them out again, unless they may stay (then `--keep`). |
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
by id from the mapping's `created` entries, or with the loop in §4 ("If the sign-in check is
refused") run in a `phase shell --env Development --shell powershell` against the staging mapping.
Keep the API key out of command lines. For one user, in PowerShell inside that shell:

```powershell
Invoke-RestMethod -Method Delete -Uri "https://api.workos.com/user_management/users/<user_id>" -Headers @{ Authorization = "Bearer $env:WORKOS_API_KEY" }
```

In bash, the header goes through a here-string, which is part of the shell, so the key never
reaches `curl`'s arguments:

```bash
curl -sS -X DELETE "https://api.workos.com/user_management/users/<user_id>" -K - <<< "header = \"Authorization: Bearer $WORKOS_API_KEY\""
```

**If `--self-test` cannot delete its synthetic user** (it reports `FAIL synthetic user deleted`,
with the user's id and `migration-selftest+…@example.net` address): delete that user in the
dashboard (Production → Users, search for `migration-selftest`), or with the command above in a
`phase shell --env Production --shell powershell`. It is a throwaway user with a random password
nobody knows, so nothing is exposed meanwhile, but it should not stay.

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
  `disabled-users-decisions.json` in front of you. That restores the account and its solo
  organisations. It does not restore the memberships that were removed (listed in the decisions
  file: the person is re-invited), the revoked sessions or the revoked CLI tokens. Then remove the
  user's entry from the decisions file, or record them as kept.
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

### 2026-10-12, review round 2

- **End to end on WorkOS Staging with a throwaway database** (PGlite, every real migration, over
  postgres.js). The synthetic export had five users: one owner and four disabled users.
  - The `--soft-delete-disabled` dry run listed each pending user's memberships:
    - a shared organisation: membership to be removed;
    - a solo organisation: left as it is;
    - a sole owner of an organisation with other members: `--apply would REFUSE`.
  - `--apply --keep <one>`:
    - removed the shared membership and kept the solo organisation intact;
    - revoked the user's session;
    - refused the sole owner and wrote nothing for them;
    - recorded the keep.
  - A second dry run **without** `--keep` showed the kept user as "kept active on purpose
    (decided …)", not as pending.
  - The import and backfill reported the decided users as notes and the undecided one as a problem.
  - `--check-sign-in` returned OK and revoked its WorkOS session. The WorkOS sessions API then
    listed 0 sessions for that user.
  - With the decisions file made read-only, `--apply` still committed the next soft-delete, and
    reported "the decision was made but NOT written", printing the entry to add by hand. The
    temporary file is cleaned up.
  - The synthetic Staging users were deleted.
- **Runbook commands run for real:**
  - the §4 recovery loop deleted exactly the `created` and `already-imported` users and left the
    `reuse-existing` one;
  - `icacls` from Git Bash (with `MSYS_NO_PATHCONV=1` and `cygpath -w`) leaves only the owner;
  - the bash `tee -a` capture, and the PowerShell `ForEach-Object { "$_" } | Tee-Object` capture,
    log the run with the `RESULT:` line and no `NativeCommandError` noise.
- **Consoles:** node sees a TTY from Git Bash inside a Windows pseudo console (as in Windows
  Terminal), and `winpty npm …` fails ("npm: Not found in PATH"). So the runbook and the prompt's
  refusal now say: PowerShell, or any shell inside Windows Terminal.
- **Self-test re-run on WorkOS Staging:** every step passed.
- **Mutation check:** 8 mutations of the round-2 rules, all caught:
  - never blocking a sole owner;
  - ignoring the block at apply time;
  - treating a solo organisation as shared;
  - removing solo memberships;
  - counting a suspended owner as active;
  - forgetting recorded keeps;
  - not scrubbing addresses;
  - accepting any `sid`.
