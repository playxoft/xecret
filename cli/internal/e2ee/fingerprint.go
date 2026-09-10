package e2ee

import (
	"crypto/sha256"
	"errors"
)

// KeyFingerprint is the short, human-comparable form of a public key.
//
// ── The format, and why it is this one and not another ──
//
//	SHA-256(publicKey) → Crockford base32 → first 8 characters → "XXXX-XXXX"
//
// This is not a Go invention. It is the format `components/envkeys/pins.ts`
// already renders beside every member and service-token key in the dashboard,
// reproduced here byte for byte so that the two sides can be *compared* — which
// is the only thing a fingerprint is for. A CLI that printed a different eight
// characters from the ones on the screen next to it would be worse than one that
// printed nothing: it would teach people that a mismatch is normal.
//
// Crockford because this product already reads codes aloud in that alphabet
// (spec §7.1, §10), so there is one set of confusable characters excluded and
// one normalisation to explain. Forty bits is far too short to be a
// cryptographic commitment and is never used as one — nothing in this codebase
// makes a decision from a fingerprint. It is a string two people read to each
// other, or one person reads off two screens.
//
// The first 40 bits of the digest are exactly five bytes, which is why the
// truncation has no padding question to get wrong in either implementation.
func KeyFingerprint(publicKey []byte) (string, error) {
	if len(publicKey) != KeyBytes {
		return "", errors.New("a public key is 32 bytes")
	}

	digest := sha256.Sum256(publicKey)
	encoded, err := encodeCrockford(digest[:5], 8)
	if err != nil {
		return "", err
	}
	// The hyphen is display only. Nothing parses this.
	return encoded[:4] + "-" + encoded[4:], nil
}
