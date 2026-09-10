'use client';

import { toBase64Url } from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';

/**
 * One-touch unlock, through the WebAuthn PRF extension.
 *
 * ── What a passkey is used for here, and what it is not ──
 * It is **not** an authentication factor. Nothing in this file is verified by
 * the server: there is no challenge endpoint, no attestation check, no signature
 * comparison, and adding them would buy nothing, because the assertion is not
 * what this flow trusts. What it trusts is the PRF output — a value the
 * authenticator derives from a secret that never leaves it, which this client
 * turns into a key that opens a wrap of the User Key. If the wrap does not open,
 * there is no unlock, and no amount of lying to this code produces one.
 *
 * That is why the challenges below are locally generated random bytes. A
 * challenge exists to stop assertion replay against a *verifier*; there is no
 * verifier. Saying so plainly is better than shipping a ceremony that looks
 * server-checked and is not.
 *
 * ── Why a passkey can never be the only wrap ──
 * The passphrase wrap is created first, by the setup ceremony, and has no
 * removal path (see the `prf` route's header). Enrolment adds a door; it never
 * replaces one. An authenticator that is lost, reset or left at home is then an
 * inconvenience rather than an unrecoverable vault — and unenrolling the last
 * passkey is safe for the same reason.
 *
 * ── PRF is not detectable in advance ──
 * There is no `isPRFAvailable()`. The only honest answer comes from asking: a
 * credential is created with the extension requested, and its client extension
 * results say whether the authenticator honoured it. So {@link enrollPasskey}
 * creates, checks `prf.enabled`, and reports {@link PasskeyUnsupportedError}
 * when the answer is no — at which point the credential that was just created is
 * abandoned rather than stored, because a passkey whose PRF output we cannot
 * obtain would be a row in the passkey list that never unlocks anything.
 */

/**
 * The PRF input, fixed for the life of the format.
 *
 * The authenticator derives its output from (credential secret, this salt), so
 * changing this value would silently invalidate every enrolled passkey: the wrap
 * on the server would still be there and would simply never open again. It is
 * domain-separated with the same `xecret.v2.` prefix as every other constant in
 * the specification, and it is hashed to a fixed 32 bytes so that the input is
 * one uniform size on every authenticator regardless of how the string is
 * encoded.
 *
 * This is not a secret and does not need to be: the security of the wrap key is
 * the credential secret's, and the salt's only job is to make sure that xecret's
 * PRF output is not the same value some other site's would be.
 */
const PRF_SALT_DOMAIN = 'xecret.v2.prf-salt';

let prfSalt: Promise<Bytes> | null = null;

function passkeyPrfSalt(): Promise<Bytes> {
  prfSalt ??= crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(PRF_SALT_DOMAIN))
    .then((digest) => new Uint8Array(digest));
  return prfSalt;
}

/**
 * Raised when this browser or authenticator cannot do what the flow needs.
 *
 * Distinct from a user cancelling, and from a network failure, because the UI
 * says something different about each: an unsupported device gets a permanent
 * "not on this device" state and no retry button, while a cancellation gets the
 * button back.
 */
export class PasskeyUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyUnsupportedError';
  }
}

/** Raised when the person dismissed the browser's prompt. Not a failure. */
export class PasskeyCancelledError extends Error {
  constructor() {
    super('The passkey prompt was dismissed.');
    this.name = 'PasskeyCancelledError';
  }
}

/**
 * What this environment can offer, decided from the globals alone.
 *
 * ── Why it takes its scope as an argument ──
 * So the three answers can be asserted without a DOM. Every one of them changes
 * what the Security screen renders, and "we show the enrol button on a browser
 * that has no `PublicKeyCredential`" is exactly the bug a test should catch
 * rather than a reviewer.
 *
 * `insecure-context` is separated from `unsupported` because it has a fix the
 * user can act on and the other does not: it is what a developer sees on a
 * plain-HTTP origin, and telling them "your browser does not support passkeys"
 * would send them looking in the wrong place entirely.
 */
export type PasskeyAvailability = 'available' | 'insecure-context' | 'unsupported';

export function passkeyAvailability(scope: {
  isSecureContext?: boolean;
  PublicKeyCredential?: unknown;
  navigator?: { credentials?: unknown };
}): PasskeyAvailability {
  if (scope.isSecureContext === false) return 'insecure-context';
  if (typeof scope.PublicKeyCredential === 'undefined') return 'unsupported';
  if (scope.navigator?.credentials === undefined) return 'unsupported';
  return 'available';
}

/** {@link passkeyAvailability} against the real page. `unsupported` on the server. */
export function currentPasskeyAvailability(): PasskeyAvailability {
  if (typeof window === 'undefined') return 'unsupported';
  return passkeyAvailability(window);
}

/** What an enrolment produced: the credential to store, and the key it derives. */
export interface PasskeyEnrolment {
  credentialId: string;
  transports: string[] | undefined;
  /** The 32-byte PRF output. The caller HKDFs it and wraps the User Key with it. */
  prfOutput: Bytes;
}

function asBytes(source: BufferSource): Bytes {
  return source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer);
}

/**
 * The authenticator's declared transports, filtered to what the API accepts.
 *
 * A hint for the browser's next prompt and nothing more, so an unrecognised
 * value is dropped rather than being cause to fail an enrolment. `getTransports`
 * is not implemented everywhere; an absent list is meaningful and stays absent
 * rather than becoming a guess.
 */
function readTransports(response: AuthenticatorAttestationResponse): string[] | undefined {
  if (typeof response.getTransports !== 'function') return undefined;

  const transports = response
    .getTransports()
    .filter((transport) => /^[a-z-]{1,32}$/.test(transport))
    .slice(0, 8);

  return transports.length > 0 ? transports : undefined;
}

function rethrowAsPasskeyError(cause: unknown): never {
  if (cause instanceof DOMException) {
    // `NotAllowedError` is what both a dismissal and a timeout produce, and the
    // specification is explicit that they are indistinguishable — deliberately,
    // so a site cannot tell "no such credential" from "the user said no".
    if (cause.name === 'NotAllowedError' || cause.name === 'AbortError') {
      throw new PasskeyCancelledError();
    }
    if (cause.name === 'NotSupportedError' || cause.name === 'SecurityError') {
      throw new PasskeyUnsupportedError('This browser refused the passkey request.');
    }
  }
  throw cause;
}

/**
 * Creates a credential and obtains its PRF output.
 *
 * Two round trips through the authenticator, not one, and that is a property of
 * the extension rather than a missed optimisation: `create()` reports only
 * whether PRF is *enabled* on most platforms — the results are permitted to be
 * absent — so a `get()` follows immediately to evaluate it. The user sees two
 * prompts once, at enrolment, and one on every unlock afterwards.
 */
export async function enrollPasskey(params: {
  userId: string;
  email: string;
  displayName: string;
  /** Credentials already enrolled, so the authenticator does not offer a duplicate. */
  existingCredentialIds: readonly Bytes[];
}): Promise<PasskeyEnrolment> {
  if (currentPasskeyAvailability() !== 'available') {
    throw new PasskeyUnsupportedError('This browser cannot use passkeys.');
  }

  const salt = await passkeyPrfSalt();

  let created: Credential | null;
  try {
    created = await navigator.credentials.create({
      publicKey: {
        // See the header: not verified by anything, because nothing on the
        // server consumes this ceremony. Random rather than fixed all the same,
        // so no two enrolments produce an identical authenticator data blob.
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'xecret', id: window.location.hostname },
        user: {
          id: new TextEncoder().encode(params.userId),
          name: params.email,
          displayName: params.displayName,
        },
        // ES256 first, RS256 as the fallback every platform authenticator
        // supports. The algorithm is irrelevant to the PRF output; it is here
        // because the parameter is required.
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        excludeCredentials: params.existingCredentialIds.map((id) => ({
          type: 'public-key' as const,
          id,
        })),
        authenticatorSelection: {
          residentKey: 'preferred',
          // The PRF output is a key to this account's vault. A credential that
          // unlocks it on a picked-up phone without a biometric or a device PIN
          // would be a weaker door than the passphrase it stands beside.
          userVerification: 'required',
        },
        extensions: { prf: {} },
      },
    });
  } catch (cause) {
    rethrowAsPasskeyError(cause);
  }

  if (created === null || !(created instanceof PublicKeyCredential)) {
    throw new PasskeyUnsupportedError('The browser did not return a passkey.');
  }

  if (created.getClientExtensionResults().prf?.enabled !== true) {
    // The credential exists on the authenticator at this point and is left
    // there, unrecorded. Deleting it is not something a website can do, and
    // storing it would put a row in the passkey list that can never unlock.
    throw new PasskeyUnsupportedError(
      'This passkey cannot derive an encryption key. Some security keys and older ' +
        'platform authenticators do not support the PRF extension.',
    );
  }

  const credentialId = new Uint8Array(created.rawId);
  const prfOutput = await evaluatePrf([credentialId], salt);

  return {
    credentialId: toBase64Url(credentialId),
    transports: readTransports(created.response as AuthenticatorAttestationResponse),
    prfOutput,
  };
}

/**
 * Asks an already-enrolled credential for its PRF output.
 *
 * `allowCredentials` names every enrolled passkey, so the browser offers the
 * choice between them; `evalByCredential` is deliberately not used, because
 * every one of them evaluates the same salt.
 */
export async function assertPasskeyPrf(
  credentialIds: readonly Bytes[],
): Promise<{ credentialId: string; prfOutput: Bytes }> {
  if (currentPasskeyAvailability() !== 'available') {
    throw new PasskeyUnsupportedError('This browser cannot use passkeys.');
  }
  if (credentialIds.length === 0) {
    throw new PasskeyUnsupportedError('No passkey is enrolled for this account.');
  }

  const salt = await passkeyPrfSalt();
  return evaluatePrfWithId(credentialIds, salt);
}

async function evaluatePrf(credentialIds: readonly Bytes[], salt: Bytes): Promise<Bytes> {
  return (await evaluatePrfWithId(credentialIds, salt)).prfOutput;
}

async function evaluatePrfWithId(
  credentialIds: readonly Bytes[],
  salt: Bytes,
): Promise<{ credentialId: string; prfOutput: Bytes }> {
  let asserted: Credential | null;
  try {
    asserted = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: window.location.hostname,
        allowCredentials: credentialIds.map((id) => ({ type: 'public-key' as const, id })),
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } },
      },
    });
  } catch (cause) {
    rethrowAsPasskeyError(cause);
  }

  if (asserted === null || !(asserted instanceof PublicKeyCredential)) {
    throw new PasskeyUnsupportedError('The browser did not return a passkey.');
  }

  const first = asserted.getClientExtensionResults().prf?.results?.first;
  if (first === undefined) {
    throw new PasskeyUnsupportedError(
      'This passkey did not return an encryption key. It may have been enrolled on a ' +
        'device that does not support the PRF extension.',
    );
  }

  return {
    credentialId: toBase64Url(new Uint8Array(asserted.rawId)),
    prfOutput: asBytes(first),
  };
}
