'use client';

/**
 * How good a master passphrase has to be, and how that is measured.
 *
 * ── Why an estimator and not a composition rule ──
 * "One capital, one digit, one symbol" measures obedience, not strength: it
 * passes `Password1!` and fails `correct horse battery staple`, and it is
 * precisely backwards about which of those an attacker cracks first. zxcvbn
 * estimates guesses against the patterns people actually use — dictionary words,
 * names, dates, keyboard walks, l33t substitutions, repeats — and reports what
 * it found, so the feedback a user reads is about their passphrase rather than
 * about our checkbox list.
 *
 * ── Why score 4, which is the maximum ──
 * The bar is set by the threat, not by convention. `VaultMaterialPayload` states
 * it plainly: a stolen session cookie, or a database dump, hands an attacker
 * every wrap — and therefore an *offline* Argon2id oracle against the passphrase,
 * unbounded by the server's lockout. Argon2id at 64 MiB makes each guess
 * expensive; it does not make a guessable passphrase safe. Nothing else stands
 * behind this one string, so the product asks for the strongest thing the
 * estimator will certify, and ADR 0009 records the choice.
 *
 * Twelve characters *as well as* score 4, because the two catch different
 * things. Score 4 can be reached by a short high-entropy string that a person
 * will not remember and will therefore write down badly; the length floor pushes
 * towards a passphrase rather than a password.
 *
 * ── Loading ──
 * The dictionaries are about a megabyte of JSON and belong in nobody's initial
 * bundle. {@link estimatePassphrase} imports them on first use — which is the
 * moment somebody focuses the passphrase field, not the moment the dashboard
 * loads.
 */

/** Characters, not bytes — this is a human-facing floor (plan §4.1 step 2). */
export const PASSPHRASE_MIN_LENGTH = 12;

/** zxcvbn's maximum. See the header for why nothing less will do. */
export const PASSPHRASE_MIN_SCORE = 4;

export interface PassphraseStrength {
  /** 0–4, zxcvbn's own scale. */
  score: number;
  /** The one thing most wrong with it, in the estimator's words. `null` if nothing is. */
  warning: string | null;
  /** What would make it better. Rendered as-is; these are entropy notes, not rules. */
  suggestions: readonly string[];
  /**
   * How long an offline attacker with slow-hash-grade hardware would need.
   *
   * The *offline slow* figure specifically, out of the four zxcvbn reports,
   * because it is the one this product's threat model actually describes: the
   * attacker has the wraps and is running Argon2id against them at their own
   * pace. Quoting the online-throttled number would be a comforting lie.
   */
  crackTime: string;
}

/**
 * The estimator, built once with the English dictionaries loaded.
 *
 * Cached as the promise rather than the result, so two fields racing to
 * initialise it — the passphrase and its confirmation, or the change-passphrase
 * form mounting twice under Strict Mode — share one import instead of two.
 */
let estimator: Promise<(passphrase: string, userInputs: string[]) => PassphraseStrength> | null =
  null;

async function loadEstimator(): Promise<
  (passphrase: string, userInputs: string[]) => PassphraseStrength
> {
  const [{ ZxcvbnFactory }, common, english] = await Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
    import('@zxcvbn-ts/language-en'),
  ]);

  const zxcvbn = new ZxcvbnFactory({
    translations: english.translations,
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...english.dictionary },
    // Catches a dictionary word with a character or two changed, which is the
    // single most common way a weak passphrase gets past a naive matcher. The
    // library defaults it off for speed; this form runs the estimate once per
    // keystroke on strings of at most a few dozen characters, and the cost is
    // not measurable against that.
    useLevenshteinDistance: true,
  });

  return (passphrase, userInputs) => {
    const result = zxcvbn.check(passphrase, userInputs);
    return {
      score: result.score,
      warning: result.feedback.warning,
      suggestions: result.feedback.suggestions,
      crackTime: result.crackTimes.offlineSlowHashingXPerSecond.display,
    };
  };
}

/**
 * Estimates a passphrase, loading the dictionaries if they are not loaded yet.
 *
 * `userInputs` should carry the account's own email and name: a passphrase built
 * out of them is exactly as guessable as they are public, and zxcvbn only knows
 * that if it is told.
 */
export async function estimatePassphrase(
  passphrase: string,
  userInputs: readonly string[] = [],
): Promise<PassphraseStrength> {
  estimator ??= loadEstimator();
  return (await estimator)(passphrase, [...userInputs]);
}

/**
 * Why this passphrase cannot be accepted yet, or `null` when it can.
 *
 * Pure, and separated from the estimator on purpose: this is the gate the
 * ceremony's Continue button reads, and a rule that decides whether a vault may
 * be created should be readable and testable without a megabyte of dictionaries
 * and a DOM. `score` is passed in rather than computed, because the estimate is
 * asynchronous and the button must have an answer on every render.
 *
 * The order matters. Length is reported before strength because it is the one a
 * user can act on without reading anything else, and a "too weak" message on a
 * four-character string tells them nothing they did not know.
 */
export function passphraseProblem(input: {
  passphrase: string;
  confirm: string;
  /** The latest estimate, or `null` while one is still being computed. */
  score: number | null;
}): string | null {
  if (input.passphrase.length === 0) return 'Choose a master passphrase.';

  if (input.passphrase.length < PASSPHRASE_MIN_LENGTH) {
    return `Use at least ${PASSPHRASE_MIN_LENGTH} characters — a phrase of several words is easier to remember and much harder to guess.`;
  }

  // Not yet estimated. Refusing rather than allowing: the button is disabled for
  // the fraction of a second the estimate takes, which is the safe direction to
  // be wrong in.
  if (input.score === null) return 'Checking how strong that is…';

  if (input.score < PASSPHRASE_MIN_SCORE) {
    return 'That passphrase is guessable. Nothing else protects your vault, so it has to be strong.';
  }

  if (input.confirm.length === 0) return 'Type the passphrase again to confirm it.';
  if (input.confirm !== input.passphrase) return 'The two passphrases do not match.';

  return null;
}
