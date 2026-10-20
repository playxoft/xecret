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

// SealOverrideValue seals a value to its owner's own X25519 public key (spec
// §2.2 type 13).
//
// The plaintext is NFC-normalised, exactly as a secret value is, so the same
// override typed on two machines is the same bytes.
func SealOverrideValue(ownerPublicKey []byte, context OverrideContext, value string) (string, error) {
	aad, err := context.aad()
	if err != nil {
		return "", err
	}
	plaintext := normalizedUTF8(value)
	defer zeroize(plaintext)

	if len(plaintext) > MaxSecretValueBytes {
		return "", fmt.Errorf("an override is at most %d bytes; this one is %d", MaxSecretValueBytes, len(plaintext))
	}
	return SealToPublicKey(ownerPublicKey, plaintext, aad)
}

// OpenOverrideValue opens an override with its owner's private key.
//
// [ErrDecrypt] for a box that is not this person's, not this row's, or was sealed
// to a keypair a vault reset has since replaced — indistinguishable on purpose.
// A format error for a plaintext that authenticated and is not UTF-8.
func OpenOverrideValue(ownerPrivateKey []byte, context OverrideContext, blob string) (string, error) {
	aad, err := context.aad()
	if err != nil {
		return "", err
	}
	plaintext, err := OpenSealedBox(ownerPrivateKey, blob, aad)
	if err != nil {
		return "", err
	}
	defer zeroize(plaintext)

	if !utf8.Valid(plaintext) {
		return "", formatErr("override plaintext is not valid UTF-8")
	}
	return string(plaintext), nil
}
