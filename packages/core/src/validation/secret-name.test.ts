import { describe, expect, it } from 'vitest';
import {
  checkSecretName,
  isReservedSecretName,
  normalizeSecretName,
  secretNameSchema,
} from './secret-name';

describe('checkSecretName', () => {
  it.each(['DATABASE_URL', 'API_KEY', '_PRIVATE', 'a', 'X1', 'lower_case_is_allowed'])(
    'accepts %s',
    (name) => {
      expect(checkSecretName(name).valid).toBe(true);
    },
  );

  it('rejects an empty name', () => {
    expect(checkSecretName('')).toMatchObject({ valid: false, problem: 'empty' });
  });

  it('rejects a name longer than the limit', () => {
    expect(checkSecretName('A'.repeat(257))).toMatchObject({ valid: false, problem: 'tooLong' });
  });

  it('rejects a leading digit and suggests a fix', () => {
    const result = checkSecretName('1PASSWORD');
    expect(result).toMatchObject({ valid: false, problem: 'leadingDigit' });
    // The digit→uppercase split also fires here, giving "_1_PASSWORD". That is
    // accepted: keeping the digit boundary is what makes "s3Bucket" normalize to
    // "S3_BUCKET", which is far more common in real JSON config than "1PASSWORD".
    // The suggestion is a one-click convenience, not a mandate — it stays editable.
    expect(result.suggestion).toBe('_1_PASSWORD');
  });

  it('rejects invalid characters and suggests a fix', () => {
    const result = checkSecretName('my-api.key');
    expect(result).toMatchObject({ valid: false, problem: 'invalidCharacters' });
    expect(result.suggestion).toBe('MY_API_KEY');
  });

  it('offers no suggestion when nothing usable can be derived', () => {
    expect(checkSecretName('!!!').suggestion).toBeUndefined();
  });

  // Injecting LD_PRELOAD from a secret store would turn `xecret run` into a
  // code-execution primitive for anyone with write access to an environment.
  it.each(['PATH', 'path', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'home'])(
    'rejects the reserved name %s',
    (name) => {
      expect(checkSecretName(name)).toMatchObject({ valid: false, problem: 'reserved' });
    },
  );

  it('treats reserved names case-insensitively', () => {
    expect(isReservedSecretName('Ld_PreLoad')).toBe(true);
    expect(isReservedSecretName('DATABASE_URL')).toBe(false);
  });
});

describe('normalizeSecretName', () => {
  it.each([
    ['database.url', 'DATABASE_URL'],
    ['my-api-key', 'MY_API_KEY'],
    ['  spaced  out  ', 'SPACED_OUT'],
    ['already_valid', 'ALREADY_VALID'],
    ['__leading__and__trailing__', 'LEADING_AND_TRAILING'],
    ['dots...and---dashes', 'DOTS_AND_DASHES'],
    ['9lives', '_9LIVES'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeSecretName(input)).toBe(expected);
  });

  it('splits camelCase before uppercasing, so the word boundary survives', () => {
    expect(normalizeSecretName('databaseUrl')).toBe('DATABASE_URL');
    expect(normalizeSecretName('s3Bucket')).toBe('S3_BUCKET');
  });

  it('splits acronym boundaries rather than running words together', () => {
    expect(normalizeSecretName('myAPIKey')).toBe('MY_API_KEY');
    expect(normalizeSecretName('awsSDKRegion')).toBe('AWS_SDK_REGION');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(normalizeSecretName('!!!')).toBe('');
    expect(normalizeSecretName('   ')).toBe('');
  });

  it('always produces a valid name when it produces anything at all', () => {
    const inputs = ['database.url', 'my-api-key', '9lives', 'a b c', '--x--'];
    for (const input of inputs) {
      const out = normalizeSecretName(input);
      if (out !== '') expect(checkSecretName(out).valid).toBe(true);
    }
  });
});

describe('secretNameSchema', () => {
  it('parses a valid name', () => {
    expect(secretNameSchema.parse('DATABASE_URL')).toBe('DATABASE_URL');
  });

  it.each(['', 'my-key', 'PATH', 'A'.repeat(257)])('rejects %s', (name) => {
    expect(secretNameSchema.safeParse(name).success).toBe(false);
  });
});
