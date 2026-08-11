import { Auth, WorkersKVStoreSingle } from 'firebase-auth-cloudflare-workers';
import type { KeyStorer } from 'firebase-auth-cloudflare-workers';
import { IdentityVerificationError } from '@xecret/core/auth';
import type { IdentityProvider, VerifiedIdentity } from '@xecret/core/auth';
import type { Bindings } from './bindings';
import { MissingBindingError } from './bindings';

/**
 * Firebase ID token verification.
 *
 * Firebase authenticates a person; xecret decides what that person may do. The
 * ID token is used **exactly once**, at login, and is then discarded in favour
 * of an xecret session. See ADR 0003 for why — the short version is that a
 * Firebase ID token cannot be revoked, so a product whose whole job is guarding
 * secrets cannot use one as its ongoing credential.
 *
 * The Admin SDK is not an option on Workers: it depends on Node's crypto and
 * filesystem. `firebase-auth-cloudflare-workers` verifies the same signatures
 * using Web Crypto, and an ESLint rule blocks `firebase-admin` from being
 * imported by accident.
 */

/**
 * How much clock difference to tolerate on `iat`.
 *
 * Cloudflare's clocks are NTP-synchronised, so this is small on purpose: a
 * generous window widens the replay opportunity for a token captured before it
 * was formally valid, and there is no legitimate client that needs more.
 */
const CLOCK_SKEW_SECONDS = 10;

/** KV key under which Google's signing certificates are cached. */
const JWKS_CACHE_KEY = 'firebase-jwks';

/**
 * In-memory fallback for the JWKS cache.
 *
 * Used when the `JWKS_CACHE` binding is absent — local development, and tests.
 * A Worker isolate is short-lived, so in production this would mean re-fetching
 * Google's certificates on most cold starts: an outgoing connection on the login
 * path, against a budget of six. That is why the KV binding is the real answer
 * and this is only a fallback.
 */
export class InMemoryKeyStore implements KeyStorer {
  #value: string | null = null;
  #expiresAt = 0;

  async get<ExpectedValue = unknown>(): Promise<ExpectedValue | null> {
    if (this.#value === null || Date.now() >= this.#expiresAt) return null;
    return JSON.parse(this.#value) as ExpectedValue;
  }

  async put(value: string, expirationTtl: number): Promise<void> {
    this.#value = value;
    this.#expiresAt = Date.now() + expirationTtl * 1000;
  }
}

/**
 * The slice of Firebase's client this module depends on.
 *
 * Narrowing it here is what makes the provider testable without a live Firebase
 * project: a test supplies a verifier that returns a fixed claim set, and the
 * mapping and rejection logic below is exercised for real.
 */
export interface IdTokenVerifier {
  verifyIdToken(
    idToken: string,
    checkRevoked?: boolean,
    env?: undefined,
    clockSkewSeconds?: number,
  ): Promise<FirebaseClaims>;
}

/** The claims xecret reads. Firebase sets many more; none of them are used. */
export interface FirebaseClaims {
  sub: string;
  email?: string | undefined;
  email_verified?: boolean | undefined;
  name?: string | undefined;
  picture?: string | undefined;
  firebase: { sign_in_provider: string };
}

export class FirebaseIdentityProvider implements IdentityProvider {
  readonly #auth: IdTokenVerifier;

  constructor(auth: IdTokenVerifier) {
    this.#auth = auth;
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    // A structural check before any work: `verifyIdToken` will reject this
    // anyway, but not before base64-decoding attacker-supplied input.
    if (token === '' || token.length > 8192) {
      throw new IdentityVerificationError('malformed');
    }

    let claims: FirebaseClaims;
    try {
      // `checkRevoked` is false, and that is correct rather than a shortcut: it
      // would cost a round trip to Firebase's backend to ask whether a token
      // that we are about to throw away has been revoked. xecret's own session
      // is the revocable credential, and it is checked on every request.
      claims = await this.#auth.verifyIdToken(token, false, undefined, CLOCK_SKEW_SECONDS);
    } catch (cause) {
      // The reason is for logs and metrics only. Returning it to the client
      // would tell an attacker which part of a forged token to fix next.
      throw new IdentityVerificationError(verificationFailureReason(cause));
    }

    const email = claims.email;
    if (!email) {
      // Every xecret account is keyed by email: it is how invitations are
      // addressed and how a member is identified in an audit record. An
      // anonymous or phone-only Firebase account has no place to attach to.
      throw new IdentityVerificationError('no-email');
    }

    const identity: VerifiedIdentity = {
      subject: claims.sub,
      email,
      emailVerified: claims.email_verified === true,
    };

    // `exactOptionalPropertyTypes` means an absent field must be absent, not
    // present-and-undefined, or it would overwrite a stored profile with null.
    if (claims.name) identity.displayName = claims.name;
    if (claims.picture) identity.avatarUrl = claims.picture;

    return identity;
  }
}

/**
 * Maps a verification failure to a stable, loggable category.
 *
 * Categories rather than messages, so a dashboard can distinguish "our clock
 * drifted" (a wave of `token-expired`) from "someone is probing us" (a wave of
 * `invalid-token`) without parsing free text.
 */
function verificationFailureReason(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return cause instanceof Error ? cause.name : 'unknown';
}

/**
 * Builds the provider from the request's bindings.
 *
 * `Auth.getOrInitialize` memoises per isolate, which is what keeps the JWKS
 * fetch off the common path. One deployment serves exactly one Firebase project,
 * so the memoisation cannot return an instance configured for a different one.
 */
export function firebaseIdentityProvider(env: Bindings): FirebaseIdentityProvider {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new MissingBindingError('FIREBASE_PROJECT_ID');

  const keyStore = env.JWKS_CACHE
    ? WorkersKVStoreSingle.getOrInitialize(JWKS_CACHE_KEY, env.JWKS_CACHE)
    : new InMemoryKeyStore();

  return new FirebaseIdentityProvider(Auth.getOrInitialize(projectId, keyStore));
}
