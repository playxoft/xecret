package e2ee

import (
	"encoding/hex"
	"fmt"
)

// Everything that wraps a key in another key.
//
// Two shapes, because they are the same operation seen from the two ends of the
// hierarchy: User Key wraps (blob types 1–5) are symmetric, under a key derived
// from something the user has; grant seals (types 6–7) are asymmetric, to a
// principal's X25519 public key.
//
// Why the UK is wrapped rather than derived: changing a passphrase re-wraps one
// 32-byte key. Nothing else re-encrypts, no secret is touched, and sessions on
// other devices stay valid because the User Key itself never changed.
//
// Spec §2.2, §3.3, §5.

// DerivePassphraseWrapKey turns SK into the key that wraps the User Key in the
// passphrase wrap.
//
// Never wrap with the raw Stretched Key. SK has two sibling branches — this and
// the unlock verifier — and the verifier is handed to the server. If the wrap
// key were SK itself, a server holding verifiers would hold wrap keys.
func DerivePassphraseWrapKey(stretchedKey []byte) ([]byte, error) {
	return deriveKey(stretchedKey, nil, InfoUKWrap)
}

// DeriveUnlockVerifier turns SK into the value the server stores the SHA-256 of.
//
// Possessing it opens no vault. Unlock is a client-side question — can I unwrap
// the User Key? — and the answer never leaves the client. The verifier exists so
// the server can maintain vaultUnlockedAt, apply the unlock backoff, and keep an
// audit trail.
func DeriveUnlockVerifier(stretchedKey []byte) ([]byte, error) {
	return deriveKey(stretchedKey, nil, InfoUnlockVerifier)
}

// DeriveUKUnlockVerifier turns the User Key into the value an unlock that never
// derived SK hands the server.
//
// It concedes nothing: whoever can compute this already holds the UK, and
// therefore every private key and environment key the account can reach — the
// proof is strictly weaker than the capability it attests to.
func DeriveUKUnlockVerifier(userKey []byte) ([]byte, error) {
	if len(userKey) != KeyBytes {
		return nil, fmt.Errorf("the User Key is %d bytes", KeyBytes)
	}
	return deriveKey(userKey, nil, InfoUKUnlockVerifier)
}

// DerivePasskeyWrapKey turns a WebAuthn PRF output into the passkey wrap key.
func DerivePasskeyWrapKey(prfOutput []byte) ([]byte, error) {
	return deriveKey(prfOutput, nil, InfoPRFWrap)
}

// WrapContext says which wrap this is and carries the discriminator that binds
// it to its own row.
//
// Discriminator is the recovery code's lookup hash as lowercase hex, or a
// passkey's base64url credential id, and is empty for the passphrase wrap.
type WrapContext struct {
	UserID        string
	Kind          WrapKind
	Discriminator string
}

// RecoveryWrapContext builds the context for one recovery-code wrap. All five
// hold the same User Key, so without the lookup hash a swapped row would go
// undetected; with it, a swap fails loudly.
func RecoveryWrapContext(userID string, lookupHash []byte) WrapContext {
	return WrapContext{UserID: userID, Kind: WrapRecovery, Discriminator: hex.EncodeToString(lookupHash)}
}

func (c WrapContext) aad() (string, error) {
	return UserKeyWrapAad(c.UserID, c.Kind, c.Discriminator)
}

// WrapUserKey wraps the User Key under one of its wrap keys, returning an
// xk2.gcm. blob.
func WrapUserKey(wrapKey, userKey []byte, context WrapContext) (string, error) {
	if len(userKey) != KeyBytes {
		return "", fmt.Errorf("the User Key is %d bytes", KeyBytes)
	}
	aad, err := context.aad()
	if err != nil {
		return "", err
	}
	iv, ciphertext, err := encryptGCM(wrapKey, userKey, aad)
	if err != nil {
		return "", err
	}
	return formatGCMBlob(iv, ciphertext)
}

// UnwrapUserKey unwraps the User Key.
//
// A wrong passphrase, a wrong recovery code, a wrap row swapped with another
// user's, and a tampered blob are one indistinguishable [ErrDecrypt]. A caller
// that needs to tell "wrong passphrase" from "corrupt record" cannot, and should
// not: the honest message is that the vault did not open.
func UnwrapUserKey(wrapKey []byte, blob string, context WrapContext) ([]byte, error) {
	aad, err := context.aad()
	if err != nil {
		return nil, err
	}
	iv, ciphertext, err := parseGCMBlob(blob)
	if err != nil {
		return nil, err
	}
	return decryptGCM(wrapKey, iv, ciphertext, aad)
}

// PrivateKeyPurpose says which private key a privkey blob holds. Bound into its
// AAD, so the X25519 blob cannot be presented where the Ed25519 blob belongs.
type PrivateKeyPurpose string

const (
	PurposeEncryption PrivateKeyPurpose = "encryption"
	PurposeSigning    PrivateKeyPurpose = "signing"
)

func privateKeyAad(userID string, purpose PrivateKeyPurpose) (string, error) {
	if purpose == PurposeSigning {
		return PrivateKeySignAad(userID)
	}
	return PrivateKeyEncAad(userID)
}

// WrapPrivateKey wraps a 32-byte private key under the User Key.
//
// The Ed25519 key is stored as its seed, not its 64-byte expanded form: the seed
// is what the signature API takes, and storing the expansion would be storing a
// derived value a future library version might expand differently.
func WrapPrivateKey(userKey, privateKey []byte, userID string, purpose PrivateKeyPurpose) (string, error) {
	if len(privateKey) != KeyBytes {
		return "", fmt.Errorf("a private key is %d bytes", KeyBytes)
	}
	aad, err := privateKeyAad(userID, purpose)
	if err != nil {
		return "", err
	}
	iv, ciphertext, err := encryptGCM(userKey, privateKey, aad)
	if err != nil {
		return "", err
	}
	return formatGCMBlob(iv, ciphertext)
}

// UnwrapPrivateKey unwraps a private key. Any failure is [ErrDecrypt].
func UnwrapPrivateKey(userKey []byte, blob, userID string, purpose PrivateKeyPurpose) ([]byte, error) {
	aad, err := privateKeyAad(userID, purpose)
	if err != nil {
		return nil, err
	}
	iv, ciphertext, err := parseGCMBlob(blob)
	if err != nil {
		return nil, err
	}
	return decryptGCM(userKey, iv, ciphertext, aad)
}

// GrantRecipient is the principal a grant is for.
//
// One shape for all three kinds, because it *is* one operation: a member, a
// service token, and an invitation each own an X25519 keypair, and the only
// difference between them is two AAD components. Rotation re-seals to every
// remaining principal without caring which is which — which is why a service
// token survives an EDK rotation.
type GrantRecipient struct {
	EnvironmentID      string
	EDKVersion         int
	RecipientKind      RecipientKind
	RecipientID        string
	RecipientPublicKey []byte
}

// SealedGrant is the two sealed blobs one env_key_grants row holds.
type SealedGrant struct {
	EDKSealed string
	EHKSealed string
}

// EnvironmentKeys is the pair a grant carries once opened.
type EnvironmentKeys struct {
	// EDK encrypts secret values and notes. Replaced on every rotation.
	EDK []byte
	// EHK keys valueHmac. Long-lived; survives EDK rotation by design.
	EHK []byte
}

func (r GrantRecipient) aads() (edk, ehk string, err error) {
	edk, err = EDKGrantAad(r.EnvironmentID, r.EDKVersion, r.RecipientKind, r.RecipientID)
	if err != nil {
		return "", "", err
	}
	ehk, err = EHKGrantAad(r.EnvironmentID, r.RecipientKind, r.RecipientID)
	if err != nil {
		return "", "", err
	}
	return edk, ehk, nil
}

// SealGrant seals an EDK and an EHK to one principal.
//
// Two calls, not one: each gets its own ephemeral keypair, its own IV, and its
// own AAD. They are stored in separate columns because the EHK is re-sealed
// unchanged across an EDK rotation while the EDK is replaced.
func SealGrant(recipient GrantRecipient, keys EnvironmentKeys) (SealedGrant, error) {
	if len(keys.EDK) != KeyBytes || len(keys.EHK) != KeyBytes {
		return SealedGrant{}, fmt.Errorf("an environment key is %d bytes", KeyBytes)
	}
	edkAad, ehkAad, err := recipient.aads()
	if err != nil {
		return SealedGrant{}, err
	}

	edkSealed, err := SealToPublicKey(recipient.RecipientPublicKey, keys.EDK, edkAad)
	if err != nil {
		return SealedGrant{}, fmt.Errorf("sealing the environment data key: %w", err)
	}
	ehkSealed, err := SealToPublicKey(recipient.RecipientPublicKey, keys.EHK, ehkAad)
	if err != nil {
		return SealedGrant{}, fmt.Errorf("sealing the environment HMAC key: %w", err)
	}
	return SealedGrant{EDKSealed: edkSealed, EHKSealed: ehkSealed}, nil
}

// OpenGrant opens a grant with the recipient's private key.
//
// RecipientPublicKey on the recipient is ignored here — it is derived from the
// private key, so a caller cannot open a grant by claiming a public key it does
// not hold the other half of.
func OpenGrant(recipient GrantRecipient, recipientPrivateKey []byte, grant SealedGrant) (EnvironmentKeys, error) {
	edkAad, ehkAad, err := recipient.aads()
	if err != nil {
		return EnvironmentKeys{}, err
	}

	edk, err := OpenSealedBox(recipientPrivateKey, grant.EDKSealed, edkAad)
	if err != nil {
		return EnvironmentKeys{}, fmt.Errorf("opening the environment data key: %w", err)
	}
	ehk, err := OpenSealedBox(recipientPrivateKey, grant.EHKSealed, ehkAad)
	if err != nil {
		zeroize(edk)
		return EnvironmentKeys{}, fmt.Errorf("opening the environment HMAC key: %w", err)
	}
	return EnvironmentKeys{EDK: edk, EHK: ehk}, nil
}

// Zeroize overwrites both environment keys once a command is done with them.
func (k EnvironmentKeys) Zeroize() { zeroize(k.EDK, k.EHK) }
