package e2ee

import (
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"unicode/utf8"
)

// Secret values and notes, encrypted under the Environment Data Key — and the
// keyed tag that lets the server detect a no-op write without seeing either.
//
// This is the module that makes the claim true. The server receives an xk2.gcm.
// string and a 32-byte tag, validates their shape, size, and the caller's
// authorization, and stores them. It never holds a key that opens them.
//
// Spec §2.2 types 9–10, §4, §9.

// MaxSecretValueBytes is the plaintext bound a client MUST refuse before
// encrypting. 64 KiB, matching crypto/secrets.ts.
const MaxSecretValueBytes = 64 * 1024

// MaxSecretBlobLength is the ciphertext bound the server enforces: prefix, IV,
// tag, and base64url expansion. Derived rather than chosen, so the two limits
// cannot drift apart.
const MaxSecretBlobLength = len("xk2.gcm.") + ((ivLength+MaxSecretValueBytes+gcmTagLength)+2)/3*4

// SecretField is which field of a secret a ciphertext holds. Each has its own
// AAD purpose.
type SecretField string

const (
	FieldValue SecretField = "value"
	FieldNote  SecretField = "note"
)

// SecretContext is the row a ciphertext belongs to.
//
// A note carries no Version: notes live on the secrets row, not on the
// append-only secret_versions row, so binding one would fabricate a component
// the two implementations would eventually disagree about.
type SecretContext struct {
	Field         SecretField
	OrgID         string
	EnvironmentID string
	SecretID      string
	Version       int
}

func (c SecretContext) aad() (string, error) {
	if c.Field == FieldNote {
		return SecretNoteAad(c.OrgID, c.EnvironmentID, c.SecretID)
	}
	return SecretValueAad(c.OrgID, c.EnvironmentID, c.SecretID, c.Version)
}

// EncryptSecret encrypts a secret value or note under the EDK.
//
// The plaintext is NFC-normalised, as every text input to this system is: the
// same value typed on two platforms must produce the same valueHmac, or a no-op
// write is recorded as a change on every save from the other machine.
func EncryptSecret(edk []byte, context SecretContext, plaintext string) (string, error) {
	aad, err := context.aad()
	if err != nil {
		return "", err
	}

	plaintextBytes := normalizedUTF8(plaintext)
	defer zeroize(plaintextBytes)

	if len(plaintextBytes) > MaxSecretValueBytes {
		return "", fmt.Errorf("a secret value is at most %d bytes; this one is %d", MaxSecretValueBytes, len(plaintextBytes))
	}

	iv, ciphertext, err := encryptGCM(edk, plaintextBytes, aad)
	if err != nil {
		return "", err
	}
	return formatGCMBlob(iv, ciphertext)
}

// DecryptSecret decrypts a secret value or note.
//
// Returns [ErrDecrypt] if the ciphertext was tampered with, if the EDK is the
// wrong one — including the right environment's *previous* EDK, after a
// rotation — or if the context does not match the one used at encryption time.
// That last case is what stops a ciphertext row being relocated into an
// environment the caller is allowed to read.
func DecryptSecret(edk []byte, context SecretContext, blob string) (string, error) {
	aad, err := context.aad()
	if err != nil {
		return "", err
	}
	iv, ciphertext, err := parseGCMBlob(blob)
	if err != nil {
		return "", err
	}
	plaintext, err := decryptGCM(edk, iv, ciphertext, aad)
	if err != nil {
		return "", err
	}
	defer zeroize(plaintext)

	if !utf8.Valid(plaintext) {
		// A blob that authenticated but does not hold text is not something this
		// client can hand to a shell. Reported as a format problem, not a
		// decryption one: the key was right.
		return "", formatErr("secret plaintext is not valid UTF-8")
	}
	return string(plaintext), nil
}

// ComputeValueHmac is the change-detection tag, keyed from the Environment HMAC
// Key.
//
// Keyed, not a bare digest: a plain SHA-256(plaintext) would be an offline
// brute-force oracle, since most secrets are structured or low-entropy enough
// that an attacker holding a database dump could confirm guesses at high speed.
//
// Keyed from the EHK, not the EDK, and that is the entire reason the EHK exists.
// The EDK rotates whenever a principal is revoked; if the HMAC key rotated with
// it, the first write to every secret after a rotation would be recorded as a
// change when nothing changed.
//
// No environmentId in the info string: the EHK is already a per-environment
// random key, so two environments derive unrelated HMAC keys, and binding the id
// as well would add a component two implementations could disagree about.
func ComputeValueHmac(ehk []byte, plaintext string) ([]byte, error) {
	keyBytes, err := deriveKey(ehk, nil, InfoValueHmac)
	if err != nil {
		return nil, err
	}
	defer zeroize(keyBytes)

	plaintextBytes := normalizedUTF8(plaintext)
	defer zeroize(plaintextBytes)

	mac := hmac.New(sha256.New, keyBytes)
	mac.Write(plaintextBytes)
	return mac.Sum(nil), nil
}

// DeriveValueHmacKey exposes the EHK → HMAC-key branch on its own.
//
// Exported for one caller: `xecret doctor`, whose known-answer test needs a
// value the specification fixes rather than one a round trip would agree with
// itself about. A build that derives a different key from a fixed input is
// internally consistent and interoperable with nobody, and a round trip cannot
// see that.
func DeriveValueHmacKey(ehk []byte) ([]byte, error) {
	return deriveKey(ehk, nil, InfoValueHmac)
}

// EncodeValueHmac renders a valueHmac for transport: unpadded base64url, which
// is the 43-character form the server's schema expects.
func EncodeValueHmac(valueHmac []byte) string { return b64url.EncodeToString(valueHmac) }
