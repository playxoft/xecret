import 'client-only';

import { getApps, initializeApp } from 'firebase/app';
import type { FirebaseApp } from 'firebase/app';
import {
  browserPopupRedirectResolver,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  inMemoryPersistence,
  initializeAuth,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  verifyPasswordResetCode,
} from 'firebase/auth';
import type { Auth, User } from 'firebase/auth';

import { api } from './api';

/**
 * Firebase Authentication — identity provider only.
 *
 * ┌─ ADR 0003, and the thing most likely to be got wrong later ─────────────┐
 * │                                                                         │
 * │ Firebase proves *who the user is*, once, at sign-in. It is never the    │
 * │ app's session and never a source of authorization state in the UI.      │
 * │                                                                         │
 * │ The only thing this module is permitted to do with a Firebase ID token  │
 * │ is hand it to `POST /api/auth/session`, which verifies it server-side   │
 * │ and issues xecret's own `__Host-xecret_session` cookie. Every           │
 * │ subsequent request authenticates with that cookie. §2 of the API        │
 * │ contract makes this structural: `/api/auth/session` is the only         │
 * │ endpoint that accepts a Firebase token at all.                          │
 * │                                                                         │
 * │ Concretely, this means:                                                 │
 * │   • Do not gate UI on `auth.currentUser`. Ask the API — `GET            │
 * │     /api/auth/me` — because only the server knows whether the session   │
 * │     has been revoked, and revocation is the entire reason we mint our   │
 * │     own sessions (a Firebase ID token cannot be revoked; it stays       │
 * │     valid for up to an hour after a compromise).                        │
 * │   • Do not read roles or organisation membership from a Firebase        │
 * │     custom claim. Authorization lives in our database.                  │
 * │   • Do not persist the ID token. See the persistence note below.        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

/**
 * Public Firebase configuration.
 *
 * These four values are public by design — they identify the project, they do
 * not authorise anything. They are read through direct `process.env.NEXT_PUBLIC_*`
 * member access because that is the form Next.js statically replaces at build
 * time; a computed lookup would come back `undefined` in the browser.
 */
const FIREBASE_CONFIG_ENV = {
  NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
} as const;

/**
 * Raised when the deployment has not been configured.
 *
 * Without this, an unconfigured build fails somewhere inside the Firebase SDK
 * with `auth/invalid-api-key` — which sends the reader looking for a wrong
 * key rather than a missing one. Self-hosters hit this on their first run, so
 * the message names the variables and points at the setup document.
 */
export class FirebaseNotConfiguredError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Firebase is not configured. Missing: ${missing.join(', ')}. ` +
        'Set these in Phase.dev (or your environment) and restart — see .env.example ' +
        'and docs/adr/0003-firebase-as-identity-provider.md. Self-hosted deployments ' +
        'need their own Firebase project.',
    );
    this.name = 'FirebaseNotConfiguredError';
    this.missing = missing;
  }
}

/** Which required variables are absent. Empty means the app can sign in. */
export function missingFirebaseConfig(): readonly string[] {
  return Object.entries(FIREBASE_CONFIG_ENV)
    .filter(([, value]) => typeof value !== 'string' || value.length === 0)
    .map(([name]) => name);
}

export function isFirebaseConfigured(): boolean {
  return missingFirebaseConfig().length === 0;
}

let cachedAuth: Auth | null = null;

/**
 * Initialises on first use, never at module scope.
 *
 * Module-scope initialisation would throw during the build, when
 * `NEXT_PUBLIC_FIREBASE_*` is legitimately unset — a deployment must be able to
 * compile before its secrets exist.
 */
export function getFirebaseAuth(): Auth {
  if (cachedAuth) return cachedAuth;

  const missing = missingFirebaseConfig();
  if (missing.length > 0) throw new FirebaseNotConfiguredError(missing);

  const existing = getApps()[0];
  const app: FirebaseApp =
    existing ??
    initializeApp({
      apiKey: FIREBASE_CONFIG_ENV.NEXT_PUBLIC_FIREBASE_API_KEY as string,
      authDomain: FIREBASE_CONFIG_ENV.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN as string,
      projectId: FIREBASE_CONFIG_ENV.NEXT_PUBLIC_FIREBASE_PROJECT_ID as string,
      appId: FIREBASE_CONFIG_ENV.NEXT_PUBLIC_FIREBASE_APP_ID as string,
    });

  try {
    cachedAuth = initializeAuth(app, {
      // ── The ID token is never stored client-side. ──
      // Firebase's default persistence writes the user's refresh token into
      // IndexedDB, where it survives the tab and is readable by any script
      // that achieves XSS on this origin. We need Firebase for the few seconds
      // between "user typed a password" and "server issued our session
      // cookie", and not one moment longer. In-memory persistence means the
      // token dies with the page.
      //
      // The visible consequence: reloading mid-flow (for example while an
      // email verification is pending) requires signing in again. That is the
      // correct trade for a product whose job is protecting credentials.
      persistence: inMemoryPersistence,
      // Loaded explicitly so the redirect resolver — which the popup flow
      // needs — is the only auxiliary module pulled into the bundle.
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    // Fast Refresh re-evaluates this module while the Firebase app instance
    // survives, and `initializeAuth` refuses a second call for the same app.
    // The already-configured instance is the one we want.
    cachedAuth = getAuth(app);
  }

  return cachedAuth;
}

export type AuthOutcome =
  | { status: 'signed-in' }
  /** Firebase authenticated the user but the address is unverified, so no
   *  xecret session was created. The server would reject the token anyway. */
  | { status: 'email-unverified'; email: string };

/**
 * The single point at which a Firebase ID token exists in this application.
 *
 * The token is a local `const`: it is never returned, stored, logged, or put
 * into React state. It goes straight into the request body and is unreachable
 * the moment this function returns.
 */
async function exchangeForSession(user: User): Promise<AuthOutcome> {
  if (!user.emailVerified) {
    return { status: 'email-unverified', email: user.email ?? '' };
  }

  const idToken = await user.getIdToken();
  await api.post('/auth/session', { idToken }, { redirectOnUnauthenticated: false });

  // The Firebase session has done its one job. Dropping it now means a stolen
  // browser tab cannot mint a second ID token from the refresh token.
  await firebaseSignOut(getFirebaseAuth());

  return { status: 'signed-in' };
}

export async function signInWithGoogle(): Promise<AuthOutcome> {
  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  // Without this, a user with several Google accounts is silently signed in as
  // whichever one the browser saw last — a real hazard when personal and work
  // accounts have different organisation access.
  provider.setCustomParameters({ prompt: 'select_account' });

  const credential = await signInWithPopup(auth, provider);
  return exchangeForSession(credential.user);
}

export async function signInWithEmail(email: string, password: string): Promise<AuthOutcome> {
  const credential = await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
  return exchangeForSession(credential.user);
}

export async function signUpWithEmail(
  email: string,
  password: string,
  displayName: string,
): Promise<AuthOutcome> {
  const auth = getFirebaseAuth();
  const credential = await createUserWithEmailAndPassword(auth, email, password);

  if (displayName.length > 0) {
    await updateProfile(credential.user, { displayName });
  }
  await sendEmailVerification(credential.user);

  // Always unverified at this point, so this reports `email-unverified`
  // rather than creating a session. Stated as a call rather than a literal so
  // the two paths cannot diverge if the verification policy changes.
  return exchangeForSession(credential.user);
}

/**
 * Re-sends the verification email for the user Firebase currently holds.
 *
 * Returns `false` when there is no such user — most often because the page was
 * reloaded, which drops the in-memory Firebase session by design.
 */
export async function resendVerificationEmail(): Promise<boolean> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return false;
  await sendEmailVerification(user);
  return true;
}

/** Re-checks verification after the user has clicked the emailed link. */
export async function retrySessionAfterVerification(): Promise<AuthOutcome | null> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  await user.reload();
  return exchangeForSession(user);
}

/**
 * Always resolves, whether or not the address has an account.
 *
 * `auth/user-not-found` is swallowed deliberately: a reset form that reports
 * "no such user" tells an attacker which addresses are registered. The UI says
 * "if that address has an account, we've sent a link" in every case.
 */
export async function sendPasswordReset(email: string): Promise<void> {
  try {
    await sendPasswordResetEmail(getFirebaseAuth(), email);
  } catch (error) {
    if (authErrorCode(error) === 'auth/user-not-found') return;
    throw error;
  }
}

/** Validates the emailed code and returns the address it belongs to. */
export async function checkPasswordResetCode(oobCode: string): Promise<string> {
  return verifyPasswordResetCode(getFirebaseAuth(), oobCode);
}

export async function completePasswordReset(oobCode: string, newPassword: string): Promise<void> {
  await confirmPasswordReset(getFirebaseAuth(), oobCode, newPassword);
}

/**
 * There is deliberately no `signOut` here.
 *
 * Signing out of the product means revoking the xecret session, which is
 * `endSession()` in `lib/api.ts`. By the time a user is inside the app there
 * is no Firebase session left to end — `exchangeForSession` drops it as soon
 * as the cookie exists, and persistence is in-memory so a reload would not
 * restore it. Putting sign-out here would also drag the Firebase SDK into
 * every bundle that renders the account menu.
 */

function authErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * A human message for a Firebase failure.
 *
 * ── Why several distinct codes collapse into one message ──
 * `auth/user-not-found`, `auth/wrong-password` and `auth/invalid-credential`
 * are all reported as "Email or password is incorrect." Distinguishing them
 * turns the sign-in form into a user-enumeration oracle: an attacker submits
 * an address with a junk password and learns from the error text whether that
 * person has an account here. Knowing that someone uses a secret manager is
 * itself worth something to them.
 *
 * Modern Firebase projects return the generic `auth/invalid-credential` once
 * Email Enumeration Protection is enabled in the console, but the specific
 * codes still arrive from older projects and self-hosted setups — so the
 * collapse is enforced here rather than assumed.
 */
export function describeAuthError(error: unknown): string {
  if (error instanceof FirebaseNotConfiguredError) return error.message;

  switch (authErrorCode(error)) {
    case 'auth/invalid-credential':
    case 'auth/invalid-email':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'Email or password is incorrect.';

    case 'auth/user-disabled':
      return 'This account has been disabled. Contact your organisation owner.';

    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';

    case 'auth/email-already-in-use':
      // Not collapsed with the sign-in message because the user needs a next
      // step, but worded so it does not confirm the address is registered.
      return 'That email cannot be used to create a new account. Try signing in, or reset your password.';

    case 'auth/weak-password':
      return 'Choose a password of at least 8 characters.';

    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Google sign-in was cancelled.';

    case 'auth/popup-blocked':
      return 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.';

    case 'auth/account-exists-with-different-credential':
      return 'This email is already registered with a different sign-in method.';

    case 'auth/network-request-failed':
      return 'Could not reach the authentication service. Check your connection and try again.';

    case 'auth/expired-action-code':
    case 'auth/invalid-action-code':
      return 'This link has expired or has already been used. Request a new one.';

    case 'auth/unauthorized-domain':
      return 'This domain is not authorised for sign-in. Add it to the Firebase console.';

    default:
      // The raw Firebase message is deliberately not surfaced: it is written
      // for developers, sometimes echoes the submitted input, and occasionally
      // names the exact verification step that failed.
      return 'Sign-in failed. Please try again.';
  }
}
