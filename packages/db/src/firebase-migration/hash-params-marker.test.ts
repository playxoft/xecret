import { describe, expect, it } from 'vitest';
import {
  HASH_PARAMS_MARKER_FORMAT,
  markerMismatch,
  parseHashParamsMarker,
  serializeHashParamsMarker,
} from './hash-params-marker';
import type { HashParamsMarker } from './hash-params-marker';

const marker: HashParamsMarker = {
  environment: 'production',
  fingerprint: 'a'.repeat(64),
  firebaseUid: 'fbOwner',
  verifiedAt: '2026-10-12T00:00:00.000Z',
};

describe('hash-parameter verification marker', () => {
  it('round-trips through its file form', () => {
    const file = JSON.parse(JSON.stringify(serializeHashParamsMarker(marker))) as unknown;
    expect(file).toMatchObject({ format: HASH_PARAMS_MARKER_FORMAT });
    expect(parseHashParamsMarker(file)).toEqual(marker);
  });

  it('vouches only for its own environment and parameters', () => {
    expect(markerMismatch(marker, 'production', 'a'.repeat(64))).toBeNull();
    expect(markerMismatch(marker, 'staging', 'a'.repeat(64))).toBe('other-environment');
    expect(markerMismatch(marker, 'production', 'b'.repeat(64))).toBe('other-parameters');
  });

  it.each([
    [{}, /Not a hash-parameter verification marker/],
    [{ ...marker, format: HASH_PARAMS_MARKER_FORMAT, environment: 'prod' }, /"environment"/],
    [{ ...marker, format: HASH_PARAMS_MARKER_FORMAT, fingerprint: 'abc' }, /"fingerprint"/],
    [{ ...marker, format: HASH_PARAMS_MARKER_FORMAT, firebaseUid: '' }, /"firebaseUid"/],
    [{ ...marker, format: HASH_PARAMS_MARKER_FORMAT, verifiedAt: 1 }, /"verifiedAt"/],
  ])('refuses a damaged marker: %j', (json, message) => {
    expect(() => parseHashParamsMarker(json)).toThrow(message);
  });
});
