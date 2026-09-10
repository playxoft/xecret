package e2ee

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
)

// The two per-principal keypairs: X25519 for sealing, Ed25519 for signing.
//
// One curve, one code path, no feature detection and no P-256 fallback — ADR
// 0009 settles that. Both private keys are 32 bytes: the X25519 scalar, and the
// Ed25519 *seed*, not its 64-byte expanded form. Both public keys are 32 bytes
// and are stored in plaintext; the private halves live only as xk2.gcm. blobs
// under the User Key (spec §1.1, §2.2 types 4–5).
const (
	PublicKeyBytes  = 32
	PrivateKeyBytes = 32
	SignatureBytes  = 64
)

// KeyPair is a 32-byte private scalar or seed with its 32-byte public half.
type KeyPair struct {
	PublicKey  []byte
	PrivateKey []byte
}

// EncryptionPublicKey derives the X25519 public key for a private scalar.
func EncryptionPublicKey(privateKey []byte) ([]byte, error) {
	key, err := x25519PrivateKey(privateKey)
	if err != nil {
		return nil, err
	}
	return key.PublicKey().Bytes(), nil
}

// x25519PrivateKey imports a 32-byte scalar. X25519 clamps internally, so any 32
// bytes are a valid scalar.
func x25519PrivateKey(privateKey []byte) (*ecdh.PrivateKey, error) {
	if len(privateKey) != PrivateKeyBytes {
		return nil, fmt.Errorf("an X25519 private key is %d bytes", PrivateKeyBytes)
	}
	key, err := ecdh.X25519().NewPrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("reading an X25519 private key: %w", err)
	}
	return key, nil
}

// SigningPublicKey derives the Ed25519 public key for a 32-byte seed.
func SigningPublicKey(privateSeed []byte) ([]byte, error) {
	if len(privateSeed) != PrivateKeyBytes {
		return nil, fmt.Errorf("an Ed25519 private seed is %d bytes", PrivateKeyBytes)
	}
	return []byte(ed25519.NewKeyFromSeed(privateSeed).Public().(ed25519.PublicKey)), nil
}

// GenerateEncryptionKeyPair mints a fresh X25519 keypair for receiving sealed
// EDK and EHK grants.
func GenerateEncryptionKeyPair() (KeyPair, error) {
	privateKey := make([]byte, PrivateKeyBytes)
	if _, err := rand.Read(privateKey); err != nil {
		return KeyPair{}, fmt.Errorf("generating an X25519 key: %w", err)
	}
	publicKey, err := EncryptionPublicKey(privateKey)
	if err != nil {
		return KeyPair{}, err
	}
	return KeyPair{PublicKey: publicKey, PrivateKey: privateKey}, nil
}

// EncodePublicKey renders a 32-byte public key for transport.
//
// Public keys carry no xk2 prefix — there is no blob type for them, because
// there is nothing to misread: a key is 32 bytes of a named curve, and the
// algorithm lives in its own column.
func EncodePublicKey(publicKey []byte) (string, error) {
	if len(publicKey) != PublicKeyBytes {
		return "", fmt.Errorf("a public key is %d bytes", PublicKeyBytes)
	}
	return b64url.EncodeToString(publicKey), nil
}

// EncodeKey renders a 32-byte key for a store that holds strings — the OS
// keyring, in practice. Unpadded base64url, like every other binary value that
// travels as text in this system.
//
// This is not a blob type and deliberately has no xk2. prefix: there is nothing
// to misread, because a key is 32 bytes and the entry it lives under says what
// it is.
func EncodeKey(key []byte) string { return b64url.EncodeToString(key) }

// DecodeKey reads one back, refusing anything that is not exactly 32 bytes.
func DecodeKey(value string) ([]byte, error) {
	key, err := b64url.DecodeString(value)
	if err != nil {
		return nil, errors.New("stored key is not valid unpadded base64url")
	}
	if len(key) != KeyBytes {
		return nil, fmt.Errorf("a stored key is %d bytes", KeyBytes)
	}
	return key, nil
}

// DecodePublicKey parses a transported public key, rejecting anything that is
// not exactly 32 bytes.
func DecodePublicKey(value string) ([]byte, error) {
	bytes, err := b64url.DecodeString(value)
	if err != nil {
		return nil, errors.New("public key is not valid unpadded base64url")
	}
	if len(bytes) != PublicKeyBytes {
		return nil, fmt.Errorf("a public key is %d bytes", PublicKeyBytes)
	}
	return bytes, nil
}

// The invite key fragment (spec §10) is deliberately absent. An invitation is
// accepted in a browser — the fragment travels by a second channel and is typed
// into the accept page — and the CLI has no flow that touches one. Its HKDF
// branch, [InfoInviteKey], stays in the registry so a grant sealed to an
// invitation still round-trips through this package's sealed box.
