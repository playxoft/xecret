import type { MigrationEnvironment } from './mapping';

/**
 * The record that `--check-hash-params` proved the Firebase hash parameters in
 * use against a real user's exported hash.
 *
 * The import's `--apply` refuses to send password hashes without one. Every
 * other check is self-consistent: the self-test builds its own hash with the
 * same parameters it then asks WorkOS to verify, so a wrong signer key,
 * separator, rounds or memory cost passes it, and the import would store
 * hashes nobody's password matches. Nothing would say so until people tried to
 * sign in after the cutover.
 *
 * A marker vouches only for the parameters it was written for (by
 * fingerprint, see `hashParamsFingerprint`) and the environment it was written
 * in. It holds no secret.
 */

export const HASH_PARAMS_MARKER_FORMAT = 'firebase-hash-params-verified/1';

export interface HashParamsMarker {
  readonly environment: MigrationEnvironment;
  /** `hashParamsFingerprint` of the parameters that reproduced the hash. */
  readonly fingerprint: string;
  /** The Firebase user whose exported hash was reproduced. */
  readonly firebaseUid: string;
  readonly verifiedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeHashParamsMarker(marker: HashParamsMarker): unknown {
  return { format: HASH_PARAMS_MARKER_FORMAT, ...marker };
}

export function parseHashParamsMarker(json: unknown): HashParamsMarker {
  if (!isRecord(json) || json['format'] !== HASH_PARAMS_MARKER_FORMAT) {
    throw new Error('Not a hash-parameter verification marker.');
  }
  const { environment, fingerprint, firebaseUid, verifiedAt } = json;
  if (environment !== 'staging' && environment !== 'production') {
    throw new Error('Verification marker has no valid "environment".');
  }
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error('Verification marker has no valid "fingerprint".');
  }
  if (typeof firebaseUid !== 'string' || firebaseUid === '') {
    throw new Error('Verification marker has no "firebaseUid".');
  }
  if (typeof verifiedAt !== 'string') {
    throw new Error('Verification marker has no "verifiedAt".');
  }
  return { environment, fingerprint, firebaseUid, verifiedAt };
}

/** Why a marker does not cover this run, or null when it does. */
export function markerMismatch(
  marker: HashParamsMarker,
  environment: MigrationEnvironment,
  fingerprint: string,
): 'other-environment' | 'other-parameters' | null {
  if (marker.environment !== environment) return 'other-environment';
  if (marker.fingerprint !== fingerprint) return 'other-parameters';
  return null;
}
