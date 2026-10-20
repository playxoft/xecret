package e2ee

import (
	"fmt"
	"unicode/utf8"
)

// OverrideContext names the row a personal override belongs to — its unique key.
type OverrideContext struct {
	OrgID         string
	EnvironmentID string
	UserID        string
	Name          string
}

func (c OverrideContext) aad() (string, error) {
	return OverrideValueAad(c.OrgID, c.EnvironmentID, c.UserID, c.Name)
}

// DeriveOverrideKey is the owner's override key: HKDF-SHA256 of their own X25519
// private key under [InfoOverrideKey] (spec §2.2 type 13).
//
// Symmetric, and derived from a secret only the owner holds, so that GCM's tag
// proves the owner made the override as well as hiding it. The construction it
// replaced sealed the value to the owner's public key, and a sealed box can be
// made by anybody who holds that key — the server included — which would let a
// server choose what `xecret run` injects into a process.
func DeriveOverrideKey(ownerPrivateKey []byte) ([]byte, error) {
	return deriveKey(ownerPrivateKey, nil, InfoOverrideKey)
}

// SealOverrideValue encrypts a value under its owner's override key.
//
// The plaintext is NFC-normalised, exactly as a secret value is, so the same
// override typed on two machines is the same bytes.
func SealOverrideValue(ownerPrivateKey []byte, context OverrideContext, value string) (string, error) {
	aad, err := context.aad()
	if err != nil {
		return "", err
	}
	plaintext := normalizedUTF8(value)
	defer zeroize(plaintext)

	if len(plaintext) > MaxSecretValueBytes {
		return "", fmt.Errorf("an override is at most %d bytes; this one is %d", MaxSecretValueBytes, len(plaintext))
	}

	key, err := DeriveOverrideKey(ownerPrivateKey)
	if err != nil {
		return "", err
	}
	defer zeroize(key)

	iv, ciphertext, err := encryptGCM(key, plaintext, aad)
	if err != nil {
		return "", err
	}
	return formatGCMBlob(iv, ciphertext)
}

// OpenOverrideValue opens an override with its owner's private key.
//
// [ErrDecrypt] for a blob that is not this person's, not this row's, was made
// under a keypair a vault reset has since replaced, or was made by anybody else
// at all — indistinguishable on purpose. A format error for a plaintext that
// authenticated and is not UTF-8.
func OpenOverrideValue(ownerPrivateKey []byte, context OverrideContext, blob string) (string, error) {
	aad, err := context.aad()
	if err != nil {
		return "", err
	}
	iv, ciphertext, err := parseGCMBlob(blob)
	if err != nil {
		return "", err
	}

	key, err := DeriveOverrideKey(ownerPrivateKey)
	if err != nil {
		return "", err
	}
	defer zeroize(key)

	plaintext, err := decryptGCM(key, iv, ciphertext, aad)
	if err != nil {
		return "", err
	}
	defer zeroize(plaintext)

	if !utf8.Valid(plaintext) {
		return "", formatErr("override plaintext is not valid UTF-8")
	}
	return string(plaintext), nil
}
