package e2ee

import (
	"fmt"
)

// The User Key hand-off: how `xecret login` comes to hold a key at all.
//
// A CLI token acts as its user, and that user's environment grants are sealed to
// an X25519 public key whose private half exists only as a wrap under the User
// Key. So a process finishing the PKCE flow with nothing but a bearer token
// authenticates perfectly and decrypts nothing. The User Key has to cross from
// the browser that just unlocked it.
//
// It crosses as a sealed box to a keypair this process generates and never
// writes down, on the loopback redirect that already carries the authorization
// code. The server produced neither half and sees neither half.
//
// Spec §13.2.

// CLIHandoffAad binds the wrap to the login it belongs to.
//
// The code challenge names the authorization attempt — only the process holding
// the verifier can complete it — so a wrap captured from one login cannot be
// replayed into another. The public key names the recipient, so a page cannot
// substitute a wrap sealed to a key of its own choosing without also knowing a
// challenge it never saw.
func CLIHandoffAad(codeChallenge, handoffPublicKey string) (string, error) {
	if err := assertComponent(codeChallenge, "codeChallenge"); err != nil {
		return "", err
	}
	if err := assertComponent(handoffPublicKey, "handoffPublicKey"); err != nil {
		return "", err
	}
	return AADPrefixV2 + ".cli-handoff|" + codeChallenge + "|" + handoffPublicKey, nil
}

// HandoffKey is the ephemeral keypair one login uses and then discards.
type HandoffKey struct {
	// PublicKeyB64Url goes in the authorize URL, for the consent screen to seal to.
	PublicKeyB64Url string
	privateKey      []byte
}

// GenerateHandoffKey mints the pair. Single-use: a new one per `xecret login`,
// never cached, never written to disk.
func GenerateHandoffKey() (*HandoffKey, error) {
	pair, err := GenerateEncryptionKeyPair()
	if err != nil {
		return nil, fmt.Errorf("generating a hand-off key: %w", err)
	}
	encoded, err := EncodePublicKey(pair.PublicKey)
	if err != nil {
		return nil, err
	}
	return &HandoffKey{PublicKeyB64Url: encoded, privateKey: pair.PrivateKey}, nil
}

// Open unwraps the User Key from the blob the consent screen produced.
//
// A failure here is [ErrDecrypt] and says nothing more: the blob arrived on a
// loopback port that anything on this machine could have posted to, and telling
// a caller *which* part of a forged wrap was wrong would be a probing oracle for
// no benefit — a genuine hand-off never fails.
func (k *HandoffKey) Open(blob, codeChallenge string) ([]byte, error) {
	aad, err := CLIHandoffAad(codeChallenge, k.PublicKeyB64Url)
	if err != nil {
		return nil, err
	}

	userKey, err := OpenSealedBox(k.privateKey, blob, aad)
	if err != nil {
		return nil, err
	}
	if len(userKey) != KeyBytes {
		zeroize(userKey)
		return nil, ErrDecrypt
	}
	return userKey, nil
}

// Close wipes the ephemeral private key. Called once the hand-off is opened or
// abandoned; the pair is worthless afterwards either way.
func (k *HandoffKey) Close() { zeroize(k.privateKey) }
