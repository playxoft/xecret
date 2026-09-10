package e2ee

import (
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"fmt"
)

// The sealed box: anonymous public-key encryption of a 32-byte key.
//
//	ephemeral X25519 → ECDH → HKDF-SHA256 → AES-256-GCM
//	payload = ephemeralPub(32) ‖ iv(12) ‖ ciphertext‖tag
//
// Used to seal the EDK and the EHK to a member, a service token, or an
// invitation. It is anonymous: the recipient learns nothing about who sealed it
// from the box itself, which is what the grant signature (sign.go) is for.
//
// Three requirements that are easy to skip:
//
//   - The public keys go in the HKDF salt, ephemeral first and recipient
//     second. HKDF(shared, "", info, 32) would derive the same key for any pair
//     producing the same shared secret and would leave the transmitted ephemeral
//     key outside the KDF's view. Reversing the order produces a different,
//     non-interoperable key.
//   - The AAD is used twice: as the HKDF info and as the GCM additional data.
//     The first binds the key to the context, the second binds the ciphertext.
//     Either alone would do; both mean an implementation that drops one still
//     fails closed.
//   - An all-zero shared secret is rejected. X25519 returns all zeros for
//     low-order input points, and continuing past that would derive a key an
//     attacker chose. crypto/ecdh returns an error for this case, and this file
//     checks the result itself as well, so the requirement does not depend on a
//     library's error behaviour staying what it is today.
//
// Ephemeral keys are single-use: a fresh keypair per seal, never cached, never
// reused across recipients or across the EDK and EHK of one grant.
//
// Spec §5.

const (
	ephemeralPublicKeyOffset = PublicKeyBytes
	sealedBoxIVOffset        = ephemeralPublicKeyOffset + ivLength
)

// sealedBoxKey derives the one-shot AES key for a box.
func sealedBoxKey(shared, ephemeralPublicKey, recipientPublicKey []byte, aad string) ([]byte, error) {
	if isAllZero(shared) {
		return nil, errors.New("X25519 produced an all-zero shared secret")
	}

	salt := make([]byte, 0, PublicKeyBytes*2)
	salt = append(salt, ephemeralPublicKey...)
	salt = append(salt, recipientPublicKey...)

	return deriveKey(shared, salt, aad)
}

// sealToPublicKeyWithRandomness seals under a caller-supplied ephemeral key and
// IV.
//
// Unexported for the reason gcm.go explains at length: the test vectors cannot
// be reproducible unless their randomness is pinned, and the exported
// [SealToPublicKey] must not be the thing that accepts it.
func sealToPublicKeyWithRandomness(recipientPublicKey, plaintext []byte, aad string, ephemeralPrivateKey, iv []byte) (string, error) {
	if len(recipientPublicKey) != PublicKeyBytes {
		return "", fmt.Errorf("a recipient public key is %d bytes", PublicKeyBytes)
	}

	ephemeral, err := x25519PrivateKey(ephemeralPrivateKey)
	if err != nil {
		return "", err
	}
	recipient, err := ecdh.X25519().NewPublicKey(recipientPublicKey)
	if err != nil {
		return "", fmt.Errorf("reading a recipient public key: %w", err)
	}

	shared, err := ephemeral.ECDH(recipient)
	if err != nil {
		return "", fmt.Errorf("X25519 agreement: %w", err)
	}
	defer zeroize(shared)

	ephemeralPublicKey := ephemeral.PublicKey().Bytes()
	key, err := sealedBoxKey(shared, ephemeralPublicKey, recipientPublicKey, aad)
	if err != nil {
		return "", err
	}
	defer zeroize(key)

	ciphertext, err := encryptGCMWithIV(key, iv, plaintext, aad)
	if err != nil {
		return "", err
	}

	payload := make([]byte, 0, PublicKeyBytes+len(iv)+len(ciphertext))
	payload = append(payload, ephemeralPublicKey...)
	payload = append(payload, iv...)
	payload = append(payload, ciphertext...)

	return FormatBlob(AlgX25519, payload)
}

// SealToPublicKey seals a plaintext — in practice a 32-byte EDK or EHK — to an
// X25519 public key, returning an xk2.x25519. blob.
//
// Takes no IV and no ephemeral key: both are generated here, per call, and
// discarded.
func SealToPublicKey(recipientPublicKey, plaintext []byte, aad string) (string, error) {
	ephemeralPrivateKey := make([]byte, PrivateKeyBytes)
	if _, err := rand.Read(ephemeralPrivateKey); err != nil {
		return "", fmt.Errorf("generating an ephemeral key: %w", err)
	}
	defer zeroize(ephemeralPrivateKey)

	iv := make([]byte, ivLength)
	if _, err := rand.Read(iv); err != nil {
		return "", fmt.Errorf("generating an IV: %w", err)
	}

	return sealToPublicKeyWithRandomness(recipientPublicKey, plaintext, aad, ephemeralPrivateKey, iv)
}

// OpenSealedBox opens a sealed box with the recipient's private key.
//
// Every failure that depends on key material — wrong recipient, wrong AAD,
// flipped bit, forged tag, a degenerate ephemeral key — surfaces as one
// indistinguishable [ErrDecrypt] carrying no detail. A malformed *blob*, by
// contrast, is an [ErrFormat]: that is a fact about a string the attacker
// already holds.
func OpenSealedBox(recipientPrivateKey []byte, blob, aad string) ([]byte, error) {
	// Checked before the uniform-failure block below, so a caller passing a
	// string that is not an AAD at all is told so, rather than handed a
	// decryption error it would spend an afternoon on.
	if !isRegisteredInfo(aad) {
		return nil, errors.New("sealed box AAD is not a registered HKDF info string")
	}

	recipient, err := x25519PrivateKey(recipientPrivateKey)
	if err != nil {
		return nil, err
	}

	payload, err := ParseBlob(blob, AlgX25519)
	if err != nil {
		return nil, err
	}
	ephemeralPublicKey := payload[:ephemeralPublicKeyOffset]
	iv := payload[ephemeralPublicKeyOffset:sealedBoxIVOffset]
	ciphertext := payload[sealedBoxIVOffset:]

	ephemeral, err := ecdh.X25519().NewPublicKey(ephemeralPublicKey)
	if err != nil {
		// A degenerate ephemeral key in the blob. Reported as a decryption
		// failure like every other unopenable box: the caller's situation is
		// identical and the detail is only useful to an attacker.
		return nil, ErrDecrypt
	}

	shared, err := recipient.ECDH(ephemeral)
	if err != nil {
		return nil, ErrDecrypt
	}
	defer zeroize(shared)

	key, err := sealedBoxKey(shared, ephemeralPublicKey, recipient.PublicKey().Bytes(), aad)
	if err != nil {
		return nil, ErrDecrypt
	}
	defer zeroize(key)

	return decryptGCM(key, iv, ciphertext, aad)
}
