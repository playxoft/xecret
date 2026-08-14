#!/usr/bin/env -S npx tsx
/**
 * Validates the deployment's configuration before anything depends on it.
 *
 *   phase run -- npx tsx scripts/check-env.ts
 *
 * Every check here corresponds to a misconfiguration that is silent until it is
 * expensive. A root key of the wrong length surfaces as a decryption failure on
 * a customer's request; a `FIREBASE_PROJECT_ID` that disagrees with the client
 * config surfaces as a 401 the user cannot act on and the operator cannot
 * explain. Both are two lines of arithmetic to catch here.
 *
 * It reads values but never prints them. Where a value must be shown to be
 * useful — a project id, a key version — it is one that is already public.
 */

import { parseRootKeyMaterial } from '../packages/core/src/crypto/key-provider.ts';
import { parseFirebaseConfig } from '../apps/web/src/lib/firebase.ts';

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

function required(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    check(name, false, 'not set');
    return null;
  }
  return value;
}

function checkRootKeys(): void {
  const raw = required('XECRET_ROOT_KEYS');
  if (raw === null) return;

  const versionRaw = process.env['XECRET_ROOT_KEY_VERSION'] ?? '1';
  const version = Number(versionRaw);

  if (!Number.isInteger(version) || version < 1) {
    check('XECRET_ROOT_KEY_VERSION', false, `"${versionRaw}" is not a positive integer`);
    return;
  }

  try {
    // The same parser the Worker uses, so a value that passes here cannot fail
    // there for a reason this script did not consider.
    const material = parseRootKeyMaterial(raw, version);
    const versions = [...material.keys.keys()].sort((a, b) => a - b);

    check(
      'XECRET_ROOT_KEYS',
      true,
      `${material.keys.size} key(s), version(s) ${versions.join(', ')}, current ${material.currentVersion}`,
    );
    check('XECRET_ROOT_KEY_VERSION', true, `${version} — present in the key map`);
  } catch (error) {
    // InvalidRootKeyMaterialError messages are structural ("wrong length",
    // "not valid base64url") and never echo key material, so this is safe.
    check('XECRET_ROOT_KEYS', false, error instanceof Error ? error.message : 'unknown error');
  }
}

function checkFirebase(): string | null {
  const raw = required('NEXT_PUBLIC_FIREBASE_CONFIG');
  if (raw === null) return null;

  const parsed = parseFirebaseConfig(raw);
  if ('problem' in parsed) {
    check('NEXT_PUBLIC_FIREBASE_CONFIG', false, parsed.problem);
    return null;
  }

  check('NEXT_PUBLIC_FIREBASE_CONFIG', true, `project "${parsed.config.projectId}"`);
  return parsed.config.projectId;
}

/**
 * The cross-check that motivated this script.
 *
 * `FIREBASE_PROJECT_ID` is what the Worker checks an ID token's `aud` claim
 * against. If it disagrees with the project the browser signs in to, every
 * login produces a valid token that the server correctly rejects — and the
 * user sees "Authentication required" with nothing in the UI to act on. The two
 * are deliberately separate variables (server trust vs client config), which is
 * exactly why they can drift.
 */
function checkFirebaseAgreement(clientProjectId: string | null): void {
  const serverProjectId = required('FIREBASE_PROJECT_ID');
  if (serverProjectId === null || clientProjectId === null) return;

  const agree = serverProjectId === clientProjectId;
  check(
    'FIREBASE_PROJECT_ID',
    agree,
    agree
      ? `"${serverProjectId}" — matches the client config`
      : `"${serverProjectId}" does NOT match the client config's "${clientProjectId}". ` +
          'Every sign-in would be rejected.',
  );
}

function checkDatabase(): void {
  const app = process.env['DATABASE_URL'];
  const migration = process.env['MIGRATION_DATABASE_URL'];

  if (!app) {
    check('DATABASE_URL', false, 'not set');
    return;
  }

  const roleOf = (url: string | undefined): string | null => {
    if (!url) return null;
    try {
      const { username } = new URL(url);
      return username === '' ? null : decodeURIComponent(username);
    } catch {
      return null;
    }
  };

  const appRole = roleOf(app);
  const migrationRole = roleOf(migration);

  if (appRole !== null && appRole === migrationRole) {
    check(
      'DATABASE_URL',
      false,
      `connects as "${appRole}", the same role as MIGRATION_DATABASE_URL — ` +
        'the application would run with rights to drop tables and erase the audit log',
    );
    return;
  }

  check('DATABASE_URL', true, `connects as "${appRole ?? 'unknown'}"`);

  if (migration) {
    check('MIGRATION_DATABASE_URL', true, `connects as "${migrationRole ?? 'unknown'}"`);
  }
}

/**
 * Email, which is optional — so this reports rather than fails.
 *
 * A deployment without a mail provider works: the PIN reset flow says so, and
 * nothing else in the product sends anything. What is *not* fine is a
 * half-configuration, where a token is set but the from-address is missing, or
 * a token from the EU region is pointed at the default host. Both produce a
 * failure whose message says nothing about the cause, which is exactly what a
 * preflight check exists to prevent.
 */
function checkEmail(): void {
  const token = process.env['ZEPTOMAIL_TOKEN'];
  const from = process.env['ZEPTOMAIL_FROM_ADDRESS'];
  const apiUrl = process.env['ZEPTOMAIL_API_URL'];

  if (!token && !from) {
    check(
      'ZEPTOMAIL_TOKEN',
      true,
      'not set — email is optional; PIN reset will report it as unavailable',
    );
    return;
  }

  if (!token || !from) {
    check(
      token ? 'ZEPTOMAIL_FROM_ADDRESS' : 'ZEPTOMAIL_TOKEN',
      false,
      'half-configured: set both the token and the from-address, or neither',
    );
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    check('ZEPTOMAIL_FROM_ADDRESS', false, `"${from}" is not an email address`);
    return;
  }

  // The token itself is never printed. Its length is enough to distinguish "set
  // to something plausible" from "set to a placeholder".
  check('ZEPTOMAIL_TOKEN', token.length > 20, token.length > 20 ? 'set' : 'suspiciously short');
  check('ZEPTOMAIL_FROM_ADDRESS', true, from);

  if (apiUrl) {
    let host: string;
    try {
      host = new URL(apiUrl).host;
    } catch {
      check('ZEPTOMAIL_API_URL', false, 'not a valid URL');
      return;
    }
    check('ZEPTOMAIL_API_URL', host.endsWith('zeptomail.com') || host.includes('zeptomail'), host);
    return;
  }

  check(
    'ZEPTOMAIL_API_URL',
    true,
    'not set — using api.zeptomail.com. An EU or India account must set this',
  );
}

checkDatabase();
checkRootKeys();
checkFirebaseAgreement(checkFirebase());
checkEmail();

const width = Math.max(...results.map((r) => r.name.length));
const failed = results.filter((r) => !r.ok).length;

console.warn('');
for (const result of results) {
  console.warn(`${result.ok ? '✅' : '❌'}  ${result.name.padEnd(width)}  ${result.detail}`);
}

if (failed > 0) {
  console.error(
    `\n${failed} problem(s). See .env.example for what each variable is, and ` +
      'docs/operations/database-setup.md for the database ones.\n',
  );
  process.exit(1);
}

console.warn('\nConfiguration is valid.\n');
