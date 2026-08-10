# Root Key: Ceremony, Escrow, Recovery, and Rotation

**Status:** Required before any cryptographic code is written. This is a hard gate on Phase 2.
**Owner:** Nitheesh (Playxoft) · **Last drill:** _never — schedule before first production key_

---

## Read this first

If the Root KEK is lost, **every customer's secrets become permanently unrecoverable.**

A database backup does not help. The backup contains ciphertext, and ciphertext without its
key is indistinguishable from random noise. There is no vendor to call, no support ticket, no
brute force. The data is gone, for everyone, forever.

This is not a hypothetical failure mode to plan for later. It is the most likely way this
company dies, and it is caused by an accident rather than an attacker.

Untested backups are not backups. **The drill in §5 is the part that matters.**

---

## 1. The key hierarchy

```
Root KEK (256-bit, AES-GCM)                    ← never in the database
   │                                              lives in Phase.dev + CF Secrets Store
   │ wraps
   ▼
Org Master Key (per organisation)              ← stored wrapped, in `org_keys`
   │ wraps
   ▼
Env Data Key (per environment)                 ← stored wrapped, in `env_keys`
   │ encrypts
   ▼
Secret Version ciphertext                      ← `secret_versions.ciphertext`
```

Every level carries a version number, so any level can be rotated without touching the levels
below it.

**Recovering the Root KEK recovers everything.** Losing it loses everything. Nothing else in
the system needs to be escrowed — the wrapped keys are all in ordinary database backups and
are worthless on their own.

---

## 2. Key ceremony — generating the Root KEK

Performed **once** per environment (production, staging). Repeat only when rotating.

### Preconditions
- A machine that is **offline** for the generation step, freshly booted, full-disk encrypted.
- Two people present. One operates, one witnesses and signs the log.
- Three physical escrow carriers ready: 2 × USB drives, 1 × archival paper.
- Clipboard managers, screen recording, and shell history disabled.

### Steps

1. **Generate.** 256 bits from the OS CSPRNG.
   ```bash
   npx tsx scripts/keygen.ts --shares 3 --threshold 2
   ```
   The script prints the key once and three Shamir shares. It never writes the key to disk.

2. **Record the fingerprint.** SHA-256 of the key, first 16 hex characters. This is safe to
   store in plaintext and is how a recovered key is verified as correct later.

3. **Load into Phase.dev.** Paste directly into the Phase web UI as `XECRET_ROOT_KEK` in the
   correct environment. Never via a shell command (shell history), never via a file.

4. **Distribute escrow shares.** Any 2 of 3 reconstruct the key. One share alone reveals
   nothing.

   | Share | Carrier | Location | Holder |
   |---|---|---|---|
   | 1 | Encrypted USB | Office safe | Nitheesh |
   | 2 | Archival paper, sealed envelope | Bank deposit box / off-site | Nitheesh |
   | 3 | Encrypted USB | Second trusted holder, different building | _TBD — must not be blank_ |

   **Rules:** never two shares in one physical location · never all three digital · never a
   share in Phase.dev, a password manager, cloud storage, email, or chat.

5. **Clear.** Wipe the clipboard, close the terminal, power off the machine. If any step used
   a file, shred it.

6. **Sign the log** (§7). Both people.

7. **Verify.** Deploy to staging, encrypt a canary value, decrypt it, confirm the fingerprint
   matches. Only then is the ceremony complete.

### Never
Generate the key in CI · store it in git, even encrypted · send it over any network except
the Phase.dev TLS session · let one person hold two shares · skip the fingerprint record.

---

## 3. Normal operation — how the key reaches production

```
Phase.dev                    ← system of record. Humans read it only here.
   │
   │  phase run -- wrangler deploy       (deploy time, once per release)
   ▼
Cloudflare Secrets Store     ← bound to the Worker as env.XECRET_ROOT_KEK
   │
   │  binding read at isolate start, imported as a NON-EXTRACTABLE CryptoKey
   ▼
Worker memory                ← unwraps Org key → Env key → secret. No network calls.
```

**The Worker never contacts Phase.dev at runtime.** See
[ADR 0002](../adr/0002-root-key-custody.md) for the four reasons why. A Phase.dev outage must
never affect secret retrieval.

---

## 4. Recovery scenarios

### 4.1 Phase.dev is temporarily unavailable
**Impact:** none on running production. Deploys are blocked.
**Action:** wait. Do not fetch the key from escrow for a transient outage — every escrow
access increases exposure. If a deploy is truly urgent, the key is already in Cloudflare
Secrets Store and the existing binding continues to work.

### 4.2 Phase.dev account lost, locked, or deleted
**Impact:** production keeps running (Cloudflare holds the runtime copy). Key rotation and
clean redeploys are blocked.
**Action:**
1. Do **not** panic-delete anything in Cloudflare. That copy is now load-bearing.
2. Reconstruct the key from any 2 escrow shares (§5).
3. Verify the fingerprint matches the recorded value.
4. Stand up a replacement secret manager, load the key, resume normal operation.
5. Treat as a security event: two shares have now been handled. Plan a rotation (§6).

### 4.3 Cloudflare Secrets Store entry deleted
**Impact:** **total outage.** No secret is decryptable until restored.
**Action:** re-run `phase run -- wrangler deploy` to re-populate from Phase.dev. Expect
minutes, not hours. If Phase.dev is *also* gone, go to §4.4.

### 4.4 Both Phase.dev and Cloudflare are lost — full disaster recovery
**Impact:** total outage. This is what escrow exists for.
**Action:**
1. Convene both share holders.
2. Reconstruct per §5.
3. Verify the fingerprint. **If it does not match, stop.** A wrong key silently produces
   garbage; do not write anything with it.
4. Rebuild infrastructure, load the key, restore the database from backup, verify with the
   canary value.
5. Full incident report. Rotate the Root KEK (§6) — the key has been handled by humans.

### 4.5 Root KEK suspected compromised
**Impact:** assume all customer secrets are readable by the attacker.
**Action:**
1. Rotate the Root KEK immediately (§6) — this is fast, because it only re-wraps org keys.
2. Notify all customers. They must rotate the underlying credentials themselves; xecret
   cannot rotate a Stripe key on their behalf.
3. Revoke all sessions, CLI tokens, and service tokens.
4. Post-mortem published.

---

## 5. Reconstruction procedure — and the quarterly drill

**Run this every quarter. Put it in the calendar. A drill that is skipped twice means the
escrow does not exist.**

The drill is performed **as if Phase.dev and Cloudflare are permanently gone.** Using either
one during a drill invalidates it.

1. Retrieve any 2 of the 3 shares. Record which two, and when, in the log.
2. On an offline, freshly booted machine:
   ```bash
   npx tsx scripts/keygen.ts --verify --share "<share-1>" --share "<share-2>"
   ```
3. Compare the printed fingerprint with §7. It must match exactly.
4. Decrypt the canary ciphertext (checked into `docs/security/canary.json` — a known
   plaintext encrypted under the production Root KEK, safe to publish because it proves
   nothing without the key).
5. Confirm the plaintext is the expected value.
6. Wipe the machine. Return both shares to their locations.
7. Record the drill in §7, signed.

**Drill success criteria:** fingerprint matches, canary decrypts, total elapsed time under 4
hours, and it was completed **without** consulting anyone not present. If a step required
knowledge that only one person had, that is a finding — write it down and fix the runbook.

---

## 6. Rotation

### Root KEK rotation — routine, cheap
Because secrets are not encrypted directly under the Root KEK, rotation only re-wraps the org
keys. No secret ciphertext is touched.

```bash
phase run -- npx tsx scripts/rotate-root-key.ts --from N-1 --to N
```

1. Generate a new Root KEK by the §2 ceremony. It becomes version N.
2. Load into Phase.dev alongside the old version — **both must be readable during rotation.**
3. Deploy. The Worker now holds both versions.
4. Run the rotation script: for each organisation, unwrap the Org Master Key with version
   N−1 and re-wrap with N, in a transaction, updating `org_keys.root_key_version`.
5. Verify no rows remain on version N−1.
6. Remove version N−1 from Phase.dev and Cloudflare. **Keep its escrow shares for 90 days** in
   case a stale backup must be restored, then destroy them and record it.

**Cadence:** annually, or immediately on suspected compromise or staff departure with access.

### Environment key rotation — expensive
Re-encrypts every secret in that environment. Used on customer request or after a suspected
environment-level compromise. Runs in a transaction per environment; the old key is retained
until every secret version is confirmed re-encrypted.

### Cryptographic erasure
Deleting an environment's data key renders every secret in that environment permanently
unreadable, without touching a single ciphertext row. This is how "delete my data" is
honoured even where backups still hold the rows.

---

## 7. Records

### Key fingerprints
| Environment | Key version | SHA-256 (first 16 hex) | Created | Ceremony by | Retired |
|---|---|---|---|---|---|
| production | — | _not yet generated_ | — | — | — |
| staging | — | _not yet generated_ | — | — | — |

### Escrow share register
| Share | Carrier | Location | Holder | Placed | Last verified present |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

### Drill log
| Date | Shares used | Fingerprint match | Canary decrypted | Duration | Findings | Signed |
|---|---|---|---|---|---|---|
| _none yet_ | | | | | | |

---

## 8. Open items blocking production

- [ ] Identify and confirm the **third share holder** (§2 step 4). A 2-of-3 scheme with two
      shares held by one person is a 1-of-1 scheme.
- [ ] Choose and document the off-site location for share 2.
- [ ] Write `scripts/keygen.ts` and `scripts/rotate-root-key.mjs` (Phase 2).
- [ ] Generate the staging key and run the **first drill against staging** before the
      production ceremony. Never rehearse for the first time on production.
- [ ] Add the quarterly drill to a shared calendar with a second reminder to the witness.
