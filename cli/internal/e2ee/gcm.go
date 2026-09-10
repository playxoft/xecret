package e2ee

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"fmt"
)

// KeyBytes is the length of every symmetric key in the hierarchy: the User Key,
// an EDK, an EHK, and every HKDF output.
const KeyBytes = 32

// encryptGCMWithIV encrypts under a caller-supplied IV.
//
// Unexported, and it stays that way. Every IV in this specification is 12 fresh
// CSPRNG bytes generated at the moment of encryption: reuse under one key breaks
// GCM completely — it leaks the XOR of the two plaintexts and enables forgery —
// so no exported function in this package accepts one. This exists for
// vectors_test.go, which cannot be reproducible unless its randomness is pinned,
// and which lives inside this package precisely so that containment is the whole
// of the protection (spec §1.1, vectors README).
func encryptGCMWithIV(key, iv, plaintext []byte, aad string) ([]byte, error) {
	if len(key) != KeyBytes {
		return nil, fmt.Errorf("AES-256-GCM requires a %d-byte key", KeyBytes)
	}
	if len(iv) != ivLength {
		return nil, fmt.Errorf("AES-256-GCM requires a %d-byte IV", ivLength)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Seal(nil, iv, plaintext, []byte(aad)), nil
}

// encryptGCM encrypts under a fresh random IV, returning it alongside the
// ciphertext. The only form production code calls.
func encryptGCM(key, plaintext []byte, aad string) (iv, ciphertext []byte, err error) {
	iv = make([]byte, ivLength)
	if _, err := rand.Read(iv); err != nil {
		return nil, nil, fmt.Errorf("generating an IV: %w", err)
	}
	ciphertext, err = encryptGCMWithIV(key, iv, plaintext, aad)
	if err != nil {
		return nil, nil, err
	}
	return iv, ciphertext, nil
}

// decryptGCM decrypts and verifies.
//
// Wrong key, wrong AAD, truncated ciphertext, flipped bit and forged tag are one
// indistinguishable [ErrDecrypt] to the caller. Nothing here adds a detail that
// could separate them.
func decryptGCM(key, iv, ciphertext []byte, aad string) ([]byte, error) {
	if len(key) != KeyBytes {
		return nil, ErrDecrypt
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrDecrypt
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrDecrypt
	}
	plaintext, err := gcm.Open(nil, iv, ciphertext, []byte(aad))
	if err != nil {
		return nil, ErrDecrypt
	}
	return plaintext, nil
}
