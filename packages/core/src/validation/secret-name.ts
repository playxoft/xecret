import * as z from 'zod/mini';

/**
 * Secret names become environment variables in the user's process, so they must
 * be valid POSIX-ish identifiers. The database enforces the same pattern as a
 * CHECK constraint (see docs/architecture/database-schema.md §5) — this is the
 * application-layer half of that pair.
 */
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SECRET_NAME_MAX_LENGTH = 256;

/**
 * Names that would shadow something the child process needs, or that make
 * `xecret run` behave surprisingly. Rejected rather than silently injected.
 */
const RESERVED_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'PWD',
  'OLDPWD',
  'IFS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

export type SecretNameProblem =
  'empty' | 'tooLong' | 'invalidCharacters' | 'leadingDigit' | 'reserved';

export interface SecretNameCheck {
  valid: boolean;
  problem?: SecretNameProblem;
  /** Human-readable, safe to show a user directly. */
  message?: string;
  /** A corrected name to offer as a one-click fix, when one can be derived. */
  suggestion?: string;
}

/**
 * `LD_PRELOAD` and friends can hijack a spawned process. Injecting one from a
 * secret store would turn `xecret run` into a code-execution primitive for
 * anyone with write access to an environment.
 */
export function isReservedSecretName(name: string): boolean {
  return RESERVED_NAMES.has(name.toUpperCase());
}

/**
 * Converts an arbitrary key into a valid `UPPER_SNAKE_CASE` secret name.
 *
 * Used by the import flow (`.env`, JSON, YAML), where source keys are often
 * `database.url` or `my-api-key`. Returns an empty string when nothing usable
 * can be derived, which callers must treat as "cannot auto-fix".
 */
export function normalizeSecretName(input: string): string {
  const normalized = input
    .trim()
    // Split on word boundaries before uppercasing destroys the signal.
    // Acronym boundary first: "myAPIKey" → "myAPI_Key", so the second pass can
    // then produce "my_API_Key" rather than the unreadable "MYAPIKEY".
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    // camelCase / PascalCase: "databaseUrl" → "database_Url", "s3Bucket" → "s3_Bucket"
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  if (normalized === '') return '';
  // A leading digit is invalid; prefix rather than discard the character.
  return /^[0-9]/.test(normalized) ? `_${normalized}` : normalized;
}

/** Validates a secret name and, where possible, suggests a corrected form. */
export function checkSecretName(name: string): SecretNameCheck {
  if (name.length === 0) {
    return { valid: false, problem: 'empty', message: 'Secret name cannot be empty.' };
  }

  if (name.length > SECRET_NAME_MAX_LENGTH) {
    return {
      valid: false,
      problem: 'tooLong',
      message: `Secret name cannot be longer than ${SECRET_NAME_MAX_LENGTH} characters.`,
    };
  }

  if (isReservedSecretName(name)) {
    return {
      valid: false,
      problem: 'reserved',
      message: `"${name}" is reserved by the operating system and cannot be used as a secret name.`,
    };
  }

  if (!SECRET_NAME_PATTERN.test(name)) {
    const suggestion = normalizeSecretName(name);
    const leadingDigit = /^[0-9]/.test(name);
    const check: SecretNameCheck = {
      valid: false,
      problem: leadingDigit ? 'leadingDigit' : 'invalidCharacters',
      message: leadingDigit
        ? 'Secret name cannot start with a digit.'
        : 'Secret name may only contain letters, digits and underscores.',
    };
    // Only offer a suggestion that is itself valid and actually different.
    if (suggestion !== '' && suggestion !== name && SECRET_NAME_PATTERN.test(suggestion)) {
      check.suggestion = suggestion;
    }
    return check;
  }

  return { valid: true };
}

export const secretNameSchema = z.string().check(
  z.minLength(1, 'Secret name cannot be empty.'),
  z.maxLength(SECRET_NAME_MAX_LENGTH),
  z.regex(SECRET_NAME_PATTERN, 'Secret name may only contain letters, digits and underscores.'),
  z.refine((name) => !isReservedSecretName(name), {
    message: 'This name is reserved by the operating system.',
  }),
);
