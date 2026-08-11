import { TOKEN_PREFIXES } from '../auth/tokens';

/**
 * Redaction: the safety net underneath the type system, not the control itself.
 *
 * The control that keeps secret values out of audit records is `AuditMetadata`
 * — an allowlist of field names with no `value` and no index signature, so there
 * is no expression a developer can write that puts a plaintext secret in a
 * record. Nothing in this file provides that guarantee.
 *
 * What this file defends is the second problem. `secretName`, `targetEmail` and
 * `reason` are fields we *do* accept, their contents are attacker-influenced,
 * and they are rendered in a dashboard and shipped to a log aggregator where a
 * far wider set of people can read them (threat model §1 — audit metadata is
 * genuinely sensitive intelligence, and T9: an operator reads everything the
 * aggregator holds). Two things go wrong there in practice: someone pastes a
 * credential into a field that was only ever meant to hold a name, and someone
 * embeds control characters to forge a log line.
 *
 * Be clear-eyed about `looksLikeCredential`: it is a pattern matcher. It
 * recognises the shapes that are cheap to recognise, and it will miss a bespoke
 * credential that looks like an ordinary word — no heuristic can do otherwise.
 * It catches mistakes. It does **not** make it safe to pass a secret value into
 * an audit field, and any future code that leans on it for that has drawn the
 * wrong conclusion from its presence.
 */

/**
 * The one replacement marker. Bracketed so it cannot be mistaken for a value
 * that happened to be stored, and fixed so every redaction looks identical in a
 * log search.
 */
export const REDACTED = '[redacted]';

/**
 * The canonical replacement for anything that must not be recorded.
 *
 * A constant, never a transformation of the input. Two alternatives were
 * considered and rejected:
 *
 * - **A prefix preview** (`hunt…`, "just the first four characters"). This is
 *   normal for showing a user a token they already hold, and wrong here. Audit
 *   metadata carries low-entropy, guessable values — a password, a database
 *   name, an email. Four characters of `hunter2` is most of `hunter2`, and four
 *   characters of a 40-character API key still tells an attacker which vendor to
 *   attack and narrows an offline search. A preview also leaks length, which
 *   alone fingerprints a credential format.
 * - **A hash.** A deterministic digest of a low-entropy value is reversible by
 *   dictionary in milliseconds. Worse, a digest that is stable across records
 *   turns the audit log into a correlation oracle — "did this user ever store
 *   *this* value" — which is precisely the question an insider would ask.
 *
 * The parameter is accepted and deliberately discarded: call sites read as a
 * transformation, and there is no path by which the input can reach the output.
 */
export function redactValue(_value: string): string {
  return REDACTED;
}

/**
 * xecret's own token prefixes, read from the single place they are defined.
 *
 * Deriving the pattern from `TOKEN_PREFIXES` rather than restating it means a
 * new token class cannot be added to the auth layer and silently escape the
 * detector here. The environment segment (`_live_` / `_test_`) is not required,
 * so a future token layout still matches.
 */
const XECRET_TOKEN = String.raw`\b(?:${Object.values(TOKEN_PREFIXES).join('|')})_[A-Za-z0-9_-]{8,}`;

/**
 * Third-party credential shapes worth recognising.
 *
 * Held as sources rather than compiled patterns because two forms are needed: a
 * stateless one for `looksLikeCredential` (a global regex carries `lastIndex`
 * between `test()` calls and would return alternating answers) and a global one
 * for replacement.
 *
 * Each pattern requires a plausible payload after its prefix. Matching a bare
 * `sk_live_` would redact the sentence "rotated the sk_live_ key", which is
 * exactly the sort of false positive that teaches people to distrust the log.
 */
const CREDENTIAL_SOURCES: readonly string[] = [
  XECRET_TOKEN,
  // AWS access key id; ASIA covers STS session credentials.
  String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
  // GitHub personal / OAuth / user / server / refresh tokens, and fine-grained PATs.
  String.raw`\bgh[pousr]_[A-Za-z0-9]{16,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  // Slack bot / user / app / refresh / legacy tokens.
  String.raw`\bxox[baprs]-[A-Za-z0-9-]{8,}`,
  // Stripe secret and restricted keys. Test keys are included: a leaked test key
  // is a smaller problem, not a non-problem, and it should not be in a log.
  String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}`,
  // Google API key.
  String.raw`\bAIza[0-9A-Za-z_-]{35}`,
  // Any PEM private key header. The body is caught by the entropy rule below.
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  // JWT. The header always begins `eyJ` — base64url of `{"`. A trailing empty
  // signature is allowed because `alg: none` tokens are still bearer material.
  String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*`,
];

const CREDENTIAL_PATTERNS = CREDENTIAL_SOURCES.map((source) => new RegExp(source));
const CREDENTIAL_PATTERNS_GLOBAL = CREDENTIAL_SOURCES.map((source) => new RegExp(source, 'g'));

/**
 * `scheme://user:password@host` — the shape of a connection string.
 *
 * The userinfo component must appear before the first `/`, `?` or `#`, which is
 * what keeps `https://example.com/users/@nitheesh` and `https://host:8443/@me`
 * from matching. A password of at least one character is required, so
 * `https://user:@host` (no password) is left alone rather than gaining a
 * redaction marker it never earned.
 */
const URL_USERINFO_SOURCE = String.raw`([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@:]+):([^\s/?#@]+)@`;
const URL_USERINFO = new RegExp(URL_USERINFO_SOURCE, 'i');
const URL_USERINFO_GLOBAL = new RegExp(URL_USERINFO_SOURCE, 'gi');

/**
 * Minimum lengths and entropy for the "unrecognised blob" rule, which is the
 * only detector here that does not key off a known prefix.
 *
 * The alphabets are deliberately narrow. Base64url's `-` and `_` are **not**
 * included: `MY_LONG_SECRET_NAME_FOR_PRODUCTION` and `production-eu-west-1` are
 * ordinary, legitimate metadata values, and admitting those two characters is
 * what turns this rule from a useful signal into a nuisance that redacts secret
 * names. xecret's own base64url tokens carry a prefix and are caught above.
 *
 * The thresholds follow the ones `detect-secrets` settled on: hex tops out at 4
 * bits per character, so 3.0 separates a digest from `deadbeefdeadbeef…`, while
 * base64 needs 4.5 — over 32 characters that requires roughly 25 distinct
 * symbols, which prose and identifiers do not reach.
 */
const HEX_BLOB = /^[0-9a-fA-F]{32,}$/;
const BASE64_BLOB = /^[A-Za-z0-9+/]{32,}={0,2}$/;
const MIN_HEX_ENTROPY = 3.0;
const MIN_BASE64_ENTROPY = 4.5;

/**
 * True when a value has the shape of something that must never be logged.
 *
 * Prefix patterns are searched anywhere in the value, so a credential pasted
 * into the middle of a sentence is still found. The entropy rules apply to the
 * value as a whole, because a high-entropy *substring* of prose means nothing —
 * `sanitizeMetadataString` gets per-word granularity by calling this on each
 * word rather than by weakening the rule here.
 */
export function looksLikeCredential(value: string): boolean {
  const userinfo = URL_USERINFO.exec(value);
  // An already-redacted URL is not a finding. Without this, sanitising a
  // connection string twice would discard the host and path — the part that
  // makes the record worth keeping.
  if (userinfo !== null && userinfo[3] !== REDACTED) return true;

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) return true;
  }

  return isHighEntropyBlob(value);
}

/**
 * Replaces the password in any `scheme://user:password@host` URL with the
 * redaction marker, leaving the rest intact.
 *
 * The username survives on purpose: `postgres`, `app_rw` or a service account
 * name is diagnostic rather than secret, and an audit record that reads
 * `postgres://app_rw:[redacted]@db.internal/xecret` still answers "which
 * database". A URL that carries a bare token *as* the username —
 * `https://ghp_…@github.com/org/repo` — is not handled here; it is caught by
 * the credential patterns instead, which redact the whole value.
 */
export function redactUrlCredentials(value: string): string {
  return value.replace(
    URL_USERINFO_GLOBAL,
    (_match: string, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
  );
}

/**
 * Characters that must never survive into a record.
 *
 * **Log-injection defence.** A newline in an attacker-controlled field lets that
 * attacker forge a log line: a secret named
 * `FOO\n2026-08-11 admin@example.com deleted PRODUCTION_KEY` becomes two
 * entries in every line-oriented log viewer and alerting pipeline downstream,
 * one of which never happened. Forging entries is how an intruder hides — and
 * the audit log is the only thing that makes an insider detectable at all.
 *
 * The set is wider than `\n` on purpose, and is expressed as Unicode categories
 * rather than a hand-written list of code points so it cannot drift:
 *
 * - `Cc` — C0 and C1 controls. Covers `\r`, `\n`, `\t`, and the NUL that
 *   PostgreSQL refuses to store in a `jsonb` string at all.
 * - `Zl`/`Zp` — U+2028 and U+2029, which several log viewers also treat as line
 *   breaks even though `\n` is the only one most code checks for.
 * - `Cf` — format characters, which are invisible when rendered. This is the
 *   bidirectional override family (the Trojan Source trick, applied to a log:
 *   a record that reads in a different order than it is stored) plus the
 *   zero-width joiner and the BOM. Nothing invisible belongs in a record whose
 *   entire job is to be read by a human afterwards.
 */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Makes an attacker-influenced string safe to store and to render: one line, no
 * control characters, no recognisable credential, bounded length.
 *
 * Every string that reaches an audit record passes through here.
 */
export function sanitizeMetadataString(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';

  // Unsafe characters become spaces rather than vanishing: deleting a tab would
  // silently weld two words together and change what the record says.
  const singleLine = value.replace(UNSAFE_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();

  // Redaction runs before truncation. The other order lets the length limit cut
  // a credential short enough that its pattern no longer matches, which would
  // turn `maxLength` into a way to smuggle one through.
  return truncate(redactCredentials(redactUrlCredentials(singleLine)), maxLength);
}

function redactCredentials(value: string): string {
  let out = value;
  for (const pattern of CREDENTIAL_PATTERNS_GLOBAL) {
    out = out.replace(pattern, REDACTED);
  }

  // The blob rule is a judgement about a whole token, so it is applied word by
  // word: "restored from a4f3…" keeps its first three words.
  return out
    .split(' ')
    .map((word) => (isHighEntropyBlob(word) ? redactValue(word) : word))
    .join(' ');
}

function isHighEntropyBlob(value: string): boolean {
  if (HEX_BLOB.test(value)) return shannonEntropy(value) >= MIN_HEX_ENTROPY;
  if (BASE64_BLOB.test(value)) return shannonEntropy(value) >= MIN_BASE64_ENTROPY;
  return false;
}

/** Shannon entropy of the value's character distribution, in bits per character. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  // Cutting between the halves of a surrogate pair leaves a lone surrogate,
  // which PostgreSQL rejects in a `jsonb` column — an emoji in a secret name
  // would fail the audit insert rather than truncating.
  let end = maxLength - 1;
  const lastKept = value.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;

  return `${value.slice(0, end)}…`;
}
