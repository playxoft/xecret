package e2ee

import (
	"crypto/hkdf"
	"crypto/sha256"
	"errors"
	"fmt"
)

// The complete info-string registry (spec §3.3).
//
// An implementation MUST NOT introduce a string that does not appear here. The
// one derivation not named is the sealed box, which passes the blob's full v2
// AAD as its info — see [isRegisteredInfo].
const (
	// InfoUKWrap derives, from SK, the AES-256-GCM key wrapping the User Key in
	// the passphrase wrap.
	InfoUKWrap = "xecret.v2.uk-wrap"
	// InfoUnlockVerifier derives, from SK, the value an unlock that derived SK
	// hands the server.
	InfoUnlockVerifier = "xecret.v2.unlock-verifier"
	// InfoUKUnlockVerifier derives, from the User Key, the value an unlock that
	// never derived SK hands the server. The one branch whose input keying
	// material is the UK, and it exists because a passkey unlock opens blob type
	// 3 — which holds the UK — and there is no way back from the UK to SK.
	InfoUKUnlockVerifier = "xecret.v2.uk-unlock-verifier"
	// InfoRecoveryWrap derives a recovery code's wrap key (RCK) from its bytes.
	InfoRecoveryWrap = "xecret.v2.recovery-wrap"
	// InfoPRFWrap derives the passkey wrap key from a WebAuthn PRF output.
	InfoPRFWrap = "xecret.v2.prf-wrap"
	// InfoValueHmac derives, from the EHK, the HMAC-SHA256 key behind valueHmac.
	InfoValueHmac = "xecret.v2.value-hmac"
	// InfoInviteKey derives an invitation keypair's X25519 scalar from its
	// fragment seed.
	InfoInviteKey = "xecret.v2.invite-key"
)

// registeredInfo is the registry, closed by assertion rather than by
// convention. A typo in an info string does not fail loudly on its own: it
// derives a different, perfectly valid-looking key, and the failure surfaces
// much later as an undecryptable blob. So an unregistered string is rejected
// here, at the one place every derivation passes through.
var registeredInfo = map[string]bool{
	InfoUKWrap:           true,
	InfoUnlockVerifier:   true,
	InfoUKUnlockVerifier: true,
	InfoRecoveryWrap:     true,
	InfoPRFWrap:          true,
	InfoValueHmac:        true,
	InfoInviteKey:        true,
}

// HKDFOutputBytes — every derivation in this specification produces 32 bytes.
const HKDFOutputBytes = KeyBytes

// isRegisteredInfo reports whether a string may be used as an HKDF info value:
// a registered constant, or a well-formed v2 AAD, which is what admits the one
// branch that is not a fixed string.
func isRegisteredInfo(info string) bool {
	return registeredInfo[info] || IsAADv2(info)
}

// deriveKey is HKDF-SHA256 → 32 bytes.
//
// The salt is empty for every branch except the sealed box, which puts
// ephemeralPub ‖ recipientPub there. Empty is correct for the rest: every input
// keying material in this hierarchy is already a uniformly random 32-byte value
// or a KDF output — none is a password (spec §3.2).
func deriveKey(ikm, salt []byte, info string) ([]byte, error) {
	if len(ikm) == 0 {
		return nil, errors.New("HKDF input keying material must not be empty")
	}
	if !isRegisteredInfo(info) {
		// Not merely unusual — unregistered. Deriving under an unknown domain
		// string produces a key nothing else will ever reproduce.
		return nil, errors.New("HKDF info string is not in the registry")
	}

	okm, err := hkdf.Key(sha256.New, ikm, salt, info, HKDFOutputBytes)
	if err != nil {
		return nil, fmt.Errorf("deriving a key: %w", err)
	}
	return okm, nil
}
