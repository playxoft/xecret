import { fromBase64Url, randomBytes, timingSafeEqual, toBase64Url } from '../crypto/encoding';
import type { Bytes } from '../crypto/types';

/**
 * The unlock PIN: a short second factor between a long-lived session and the
 * secrets it can read.
 *
 * ── The problem it solves ──
 * A session lasts 30 days, which is what makes xecret pleasant to use and is
 * exactly what makes an unattended laptop dangerous. Signing in every day would
 * fix the second thing by destroying the first. So the session stays, and the
 * *screen* locks: the cookie proves which account this is, and the PIN proves
 * somebody who knows it is sitting there right now.
 *
 * ── What a six-digit PIN is and is not ──
 * It is not a password, and nothing here pretends otherwise. Six digits is a
 * million possibilities — trivially exhausted offline in the time it takes to
 * read this sentence. Its security comes from three things, in this order:
 *
 *  1. **The lockout.** Guesses are counted server-side and answered with an
 *     escalating delay. `evaluatePinLockout` is the actual control; the hash is
 *     what stops a database dump from turning into instant access.
 *  2. **It is never the only credential.** A PIN alone opens nothing. It unlocks
 *     a session that was already established by a verified Firebase identity, so
 *     an attacker needs the cookie *and* the PIN.
 *  3. **The KDF.** PBKDF2 at the highest cost the platform permits slows an
 *     offline sweep of a million candidates from milliseconds to minutes. That
 *     is a delay, not a wall — no iteration count makes six digits survive an
 *     offline attack — which is why the blocklist below matters: the PINs
 *     people actually choose are a few hundred, not a million.
 *
 * ── Why PBKDF2 and not argon2 or bcrypt ──
 * This runs in a Worker, where WebCrypto is the only primitive available without
 * shipping WebAssembly into the request path. PBKDF2-HMAC-SHA256 is the strongest
 * memory-hard-free option WebCrypto offers, and it is what the platform can do
 * natively. The stored format records its own parameters so the cost can be
 * raised later without a migration and without invalidating existing PINs.
 */

/**
 * Exactly six digits.
 *
 * A range would let people choose four, and the ones who need the extra strength
 * are not the ones who would choose twelve. Six is what a phone lock screen
 * trained everyone to expect, and the lockout is where the security budget is
 * actually spent.
 */
export const PIN_LENGTH = 6;

export const PIN_PATTERN = /^\d{6}$/;

/** Free guesses before the escalating delay starts. */
export const PIN_FREE_ATTEMPTS = 5;

/** The first lockout, doubling with each further failure. */
export const PIN_LOCKOUT_BASE_MS = 60 * 1000;

/**
 * The ceiling on that doubling.
 *
 * Uncapped escalation is a denial-of-service against the account's real owner:
 * an attacker who cannot guess the PIN can still lock it out for a week. An hour
 * is long enough that guessing is hopeless — 24 tries a day against a million
 * candidates — and short enough that the owner's own fat-fingering is not a
 * support ticket.
 */
export const PIN_LOCKOUT_MAX_MS = 60 * 60 * 1000;

/**
 * How long one unlock lasts.
 *
 * A working day. Long enough that nobody types it twice in a morning, short
 * enough that a laptop left in a hotel room re-locks itself overnight without
 * anyone remembering to do anything.
 */
export const PIN_UNLOCK_MS = 8 * 60 * 60 * 1000;

/** How long a PIN reset link is good for. */
export const PIN_RESET_TTL_MS = 15 * 60 * 1000;

/**
 * The **Workers runtime hard-caps PBKDF2 at 100,000 iterations** — verified
 * against production workerd, which throws `Pbkdf2 failed: iteration counts
 * above 100000 are not supported` (local `wrangler dev` does NOT enforce the
 * cap, so a local test proves nothing here). At 100,000 the derived bits match
 * Node's byte for byte.
 *
 * This constant was 600,000 once, and the result was a PIN that verified in
 * development and failed on every deployed request. Do not raise it above the
 * platform cap again: for a six-digit PIN the KDF was never the real defence —
 * the durable lockout is (see the header) — so the portable maximum is the
 * right value, not the largest one Node would accept.
 */
export const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = 'SHA-256';
const SALT_BYTES = 16;
const DERIVED_BYTES = 32;
const ALGORITHM = 'pbkdf2-sha256';

export type PinProblem = 'length' | 'nonNumeric' | 'tooCommon' | 'sequential' | 'repeated';

export interface PinCheck {
  valid: boolean;
  problem?: PinProblem;
  /** Safe to show the user. Never contains the PIN. */
  message?: string;
}

/**
 * The PINs a guessing attack tries first.
 *
 * Not a large list on purpose — this is not a password blocklist. These are the
 * handful that appear in every leaked-PIN analysis with wildly disproportionate
 * frequency; `123456` alone is somewhere around one in ten. Rejecting a few
 * hundred candidates removes most of the value from an online guessing attempt,
 * and rejecting more would start refusing PINs people can actually remember.
 */
const COMMON_PINS = new Set([
  '123456',
  '654321',
  '111111',
  '000000',
  '121212',
  '123123',
  '112233',
  '696969',
  '666666',
  '159753',
  '007007',
  '123321',
  '789456',
  '147258',
  '852456',
  '101010',
  '202020',
  '123654',
  '696969',
  '420420',
]);

/**
 * Validates a candidate PIN.
 *
 * Rejecting a weak PIN is friction at the one moment the user is paying
 * attention, in exchange for removing the guesses an attacker would make first.
 * Every message says what to do rather than merely what is wrong.
 */
export function checkPin(pin: string): PinCheck {
  if (pin.length !== PIN_LENGTH) {
    return {
      valid: false,
      problem: 'length',
      message: `Your PIN must be exactly ${PIN_LENGTH} digits.`,
    };
  }

  if (!PIN_PATTERN.test(pin)) {
    return { valid: false, problem: 'nonNumeric', message: 'Your PIN must be digits only.' };
  }

  if (COMMON_PINS.has(pin)) {
    return {
      valid: false,
      problem: 'tooCommon',
      message: 'That is one of the most commonly used PINs. Choose another.',
    };
  }

  if (isRepeated(pin)) {
    return {
      valid: false,
      problem: 'repeated',
      message: 'Your PIN cannot be the same digit six times.',
    };
  }

  if (isSequential(pin)) {
    return {
      valid: false,
      problem: 'sequential',
      message: 'Your PIN cannot be six digits in a row, up or down.',
    };
  }

  return { valid: true };
}

function isRepeated(pin: string): boolean {
  return new Set(pin).size === 1;
}

/** `123456` and `654321`, including the wrap-around `890123`. */
function isSequential(pin: string): boolean {
  let ascending = true;
  let descending = true;

  for (let i = 1; i < pin.length; i += 1) {
    const previous = Number(pin[i - 1]);
    const current = Number(pin[i]);
    if ((previous + 1) % 10 !== current) ascending = false;
    if ((previous + 9) % 10 !== current) descending = false;
  }

  return ascending || descending;
}

/**
 * Derives the stored form of a PIN.
 *
 * The result is self-describing — `pbkdf2-sha256$100000$<salt>$<hash>` — so the
 * iteration count can be raised later and old rows keep verifying against the
 * count they were written with. A bare hash column would make that a migration
 * over every user, at a moment (a security response) when nobody wants one.
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await derive(pin, salt, PBKDF2_ITERATIONS);
  return `${ALGORITHM}$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

/**
 * Verifies a PIN against its stored form.
 *
 * Returns `false` rather than throwing for a malformed or unknown-algorithm
 * record. A corrupt row must read as "wrong PIN" — which sends the user to the
 * reset flow that can repair it — not as a 500 that leaves them with no way
 * forward and a stack trace in the log.
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parsed = parseStoredPin(stored);
  if (parsed === null) return false;

  const derived = await derive(pin, parsed.salt, parsed.iterations);
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * True when `stored` was written at any cost other than the current one.
 *
 * `!==`, not `<`, deliberately: a rehash must also *lower* a cost. Rows hashed
 * at 600,000 iterations exist from before the platform cap was understood, and
 * they can only ever verify under Node — one successful unlock there rewrites
 * them at the portable cost, after which every runtime agrees.
 */
export function pinNeedsRehash(stored: string): boolean {
  const parsed = parseStoredPin(stored);
  return parsed === null || parsed.iterations !== PBKDF2_ITERATIONS;
}

interface ParsedPin {
  iterations: number;
  salt: Bytes;
  hash: Bytes;
}

function parseStoredPin(stored: string): ParsedPin | null {
  const [algorithm, iterations, salt, hash] = stored.split('$');
  if (algorithm !== ALGORITHM) return null;
  if (iterations === undefined || salt === undefined || hash === undefined) return null;

  const rounds = Number(iterations);
  if (!Number.isInteger(rounds) || rounds < 1) return null;

  try {
    return { iterations: rounds, salt: fromBase64Url(salt), hash: fromBase64Url(hash) };
  } catch {
    return null;
  }
}

async function derive(pin: string, salt: Bytes, iterations: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);

  const bits = await crypto.subtle.deriveBits(
    // `salt` is a `Uint8Array`; WebCrypto wants a BufferSource and is satisfied
    // by one. Passing the view rather than `.buffer` matters: a view into a
    // larger pooled buffer would otherwise salt with the whole pool.
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: PBKDF2_HASH },
    key,
    DERIVED_BYTES * 8,
  );

  return new Uint8Array(bits);
}

/** What the database records about a user's recent guesses. */
export interface PinAttemptState {
  /** Consecutive failures since the last success. Reset to 0 on success. */
  failedAttempts: number;
  /** When the current lockout ends, or `null` when there is none. */
  lockedUntil: Date | null;
}

export interface PinLockout {
  locked: boolean;
  /** Milliseconds until another attempt is allowed. 0 when not locked. */
  retryAfterMs: number;
}

/**
 * Whether a guess may be attempted right now.
 *
 * Pure, and separated from storage, so every escalation step is testable without
 * a database and there is one definition of "locked out" rather than one per
 * call site.
 */
export function evaluatePinLockout(state: PinAttemptState, now: Date): PinLockout {
  if (state.lockedUntil === null) return { locked: false, retryAfterMs: 0 };

  const remaining = state.lockedUntil.getTime() - now.getTime();
  if (remaining <= 0) return { locked: false, retryAfterMs: 0 };

  return { locked: true, retryAfterMs: remaining };
}

/**
 * The state after one more wrong guess.
 *
 * The delay doubles from `PIN_LOCKOUT_BASE_MS` once the free attempts are spent,
 * and stops doubling at `PIN_LOCKOUT_MAX_MS`. `failedAttempts` keeps counting
 * past that so the escalation does not restart when a lockout expires — an
 * attacker who waits out each delay must keep waiting the maximum, rather than
 * being handed five fresh free guesses every hour.
 */
export function nextPinFailure(state: PinAttemptState, now: Date): PinAttemptState {
  const failedAttempts = state.failedAttempts + 1;

  if (failedAttempts <= PIN_FREE_ATTEMPTS) {
    return { failedAttempts, lockedUntil: null };
  }

  const step = failedAttempts - PIN_FREE_ATTEMPTS - 1;
  const delay = Math.min(PIN_LOCKOUT_BASE_MS * 2 ** step, PIN_LOCKOUT_MAX_MS);

  return { failedAttempts, lockedUntil: new Date(now.getTime() + delay) };
}

/** The state after a correct PIN: the slate is wiped. */
export function clearedPinFailures(): PinAttemptState {
  return { failedAttempts: 0, lockedUntil: null };
}

/**
 * Whether a session is currently unlocked.
 *
 * `null` means it has never been unlocked, which is the state a session is in
 * the moment it is created — so a fresh sign-in still passes through the PIN
 * screen, and the cookie alone is never enough to read a secret.
 */
export function isSessionUnlocked(pinVerifiedAt: Date | null, now: Date): boolean {
  if (pinVerifiedAt === null) return false;
  return now.getTime() - pinVerifiedAt.getTime() < PIN_UNLOCK_MS;
}

/** When the current unlock lapses, for the client to schedule a re-lock against. */
export function unlockExpiryFrom(pinVerifiedAt: Date): Date {
  return new Date(pinVerifiedAt.getTime() + PIN_UNLOCK_MS);
}

export function pinResetExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + PIN_RESET_TTL_MS);
}
