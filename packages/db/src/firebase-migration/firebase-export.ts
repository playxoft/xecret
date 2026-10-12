import { decodeBase64 } from './firebase-scrypt';

/**
 * Reads the file `firebase auth:export <file> --format=json` writes.
 *
 * Operator tooling for the Firebase → WorkOS import; see `firebase-scrypt.ts`
 * for why this directory is Node-only and never reaches the application.
 *
 * The file holds every user's password hash and salt. Nothing here logs,
 * returns in an error, or otherwise surfaces a field's value: errors name the
 * record by its index and the field by its name.
 *
 * Structural damage — not JSON of the right shape, a record without a uid, a
 * uid twice — throws, because a partially trusted export is worse than none.
 * A password field that does not decode does *not* throw: it marks that one
 * user `malformed`, and the import reports and skips them.
 */

export interface FirebaseProviderInfo {
  /** `google.com`, `password`, `github.com`, … */
  readonly providerId: string;
  readonly displayName: string | null;
}

export type FirebasePassword =
  | { readonly hash: Uint8Array; readonly salt: Uint8Array }
  /** A hash or salt was present but did not decode, or only one of the two was. */
  | 'malformed';

export interface FirebaseExportUser {
  /** Firebase's `localId`. */
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly disabled: boolean;
  readonly displayName: string | null;
  readonly password: FirebasePassword | null;
  readonly providers: readonly FirebaseProviderInfo[];
  /** Enrolled second factors. WorkOS cannot import them; reported, not migrated. */
  readonly mfaEnrolled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string, where: string) {
  const value = record[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${where}: "${key}" is not a string.`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string, where: string) {
  const value = record[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new Error(`${where}: "${key}" is not a boolean.`);
  return value;
}

function parsePassword(record: Record<string, unknown>, where: string): FirebasePassword | null {
  const hash = optionalString(record, 'passwordHash', where);
  const salt = optionalString(record, 'salt', where);
  if (hash === null && salt === null) return null;
  if (hash === null || salt === null) return 'malformed';
  try {
    return {
      hash: decodeBase64(hash, `${where}: passwordHash`),
      salt: decodeBase64(salt, `${where}: salt`),
    };
  } catch {
    return 'malformed';
  }
}

function parseProviders(record: Record<string, unknown>, where: string): FirebaseProviderInfo[] {
  const raw = record['providerUserInfo'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${where}: "providerUserInfo" is not an array.`);
  return raw.map((entry: unknown, i) => {
    const at = `${where}.providerUserInfo[${i}]`;
    if (!isRecord(entry)) throw new Error(`${at} is not an object.`);
    const providerId = entry['providerId'];
    if (typeof providerId !== 'string' || providerId === '') {
      throw new Error(`${at}: "providerId" is missing.`);
    }
    return { providerId, displayName: optionalString(entry, 'displayName', at) };
  });
}

export function parseFirebaseExport(json: unknown): FirebaseExportUser[] {
  if (!isRecord(json) || !Array.isArray(json['users'])) {
    throw new Error('Not a Firebase auth export: expected an object with a "users" array.');
  }
  const seen = new Set<string>();
  return (json['users'] as unknown[]).map((entry, index) => {
    const where = `users[${index}]`;
    if (!isRecord(entry)) throw new Error(`${where} is not an object.`);
    const uid = entry['localId'];
    if (typeof uid !== 'string' || uid === '') throw new Error(`${where}: "localId" is missing.`);
    if (seen.has(uid)) throw new Error(`${where}: uid ${uid} appears more than once.`);
    seen.add(uid);
    const mfa = entry['mfaInfo'];
    return {
      uid,
      email: optionalString(entry, 'email', where),
      emailVerified: optionalBoolean(entry, 'emailVerified', where),
      disabled: optionalBoolean(entry, 'disabled', where),
      displayName: optionalString(entry, 'displayName', where),
      password: parsePassword(entry, where),
      providers: parseProviders(entry, where),
      mfaEnrolled: Array.isArray(mfa) && mfa.length > 0,
    };
  });
}
