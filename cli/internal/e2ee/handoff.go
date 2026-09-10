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
// ── What is cryptographically bound ──
//
// Two components, and they are the two the AAD names. The **code challenge**
// names one authorization attempt: a wrap sealed under it opens only for a
// process that presents the same challenge, so a blob captured from one login
// cannot be replayed into another. The **hand-off public key** names the
// recipient: the wrap opens only with the private half, which exists in one
// process's memory and is never written down, so a page cannot substitute a wrap
// sealed to a key it chose without also knowing a challenge it never saw.
//
// ── What is not ──
//
// Nothing binds the *recipient's identity*. Neither component says which process
// on this machine generated that keypair, and neither could: they are both
// produced before anybody has authenticated. Two consequences follow, and both
// are residual risk rather than defects in the binding.
//
// **An unprivileged local process can be the recipient.** Any program running as
// this user can start its own PKCE flow, put its own hand-off public key in an
// authorize URL, and open a browser at it. If the person sitting there approves
// that consent screen — believing it belongs to the `xecret login` they just
// typed — the User Key is sealed to the impostor's key and posted to the
// impostor's loopback port. The cryptography behaves perfectly throughout; what
// was attacked is the consent, not the seal. That is what the fingerprint
// printed by `xecret login` is for: the eight characters on the terminal and the
// eight on the consent screen come from the same public key, and they differ
// when the page is sealing to somebody else's.
//
// **The sealed blob outlives the login.** It rides the redirect as a query
// parameter, so it lands in the browser's history and in anything that syncs it.
// The blob is useless without the ephemeral private key, which is wiped when the
// login ends — so this is a disclosure of ciphertext to a future attacker who
// must also have had, at the time, memory access to the process that has since
// exited. It is stated here because "the User Key never touches disk" is a claim
// people make about this flow, and the honest version has this footnote on it.
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
	publicKey       []byte
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
	return &HandoffKey{
		PublicKeyB64Url: encoded,
		publicKey:       pair.PublicKey,
		privateKey:      pair.PrivateKey,
	}, nil
}

// Fingerprint is the eight characters `xecret login` prints for the user to
// compare against the consent screen.
//
// It is the only defence against the local-impostor case in [CLIHandoffAad]:
// nothing in the protocol distinguishes this process from another one on the
// same machine asking for the same thing, so the check has to be made by the
// person who knows which of them they started.
func (k *HandoffKey) Fingerprint() (string, error) { return KeyFingerprint(k.publicKey) }

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
