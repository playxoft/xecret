package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/envkeys"
	"github.com/playxoft/xecret/cli/internal/keyring"
)

// The end-to-end encryption half of `xecret doctor`.
//
// Three questions, in the order a broken machine asks them:
//
//  1. **Does the cryptography in this binary work at all?** Answered by running
//     a pinned vector through the same code path a real grant takes. It is a
//     handful of microseconds and it turns "this build was compiled for a
//     platform where something is subtly wrong" from a theory into a check.
//  2. **Does this machine hold a key?** A login hands one over; a service token
//     carries its own. Either answer is fine, and *neither* is the failure —
//     which is why this is one check and not two.
//  3. **Is the credential the right shape?** A service token minted before
//     Phase 4 authenticates perfectly and decrypts nothing, and the error it
//     produces on first use says only that a grant would not open.

// The ids the self-test seals against. Shape, not identity: they are canonical
// lowercase UUIDs because the AAD builders require canonical lowercase UUIDs,
// and a self-test that used anything else would exercise a path no real grant
// takes.
const (
	selfTestOrgID         = "018f3b2c-9c1a-7c3d-8e4f-0a1b2c3d4e5f"
	selfTestEnvironmentID = "018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e5f"
	selfTestSecretID      = "018f3b2c-9c1a-7c3d-8e4f-2a1b2c3d4e5f"
	selfTestRecipientID   = "018f3b2c-9c1a-7c3d-8e4f-5a1b2c3d4e5f"
)

// e2eeSelfTest exercises the whole client stack against material it generates,
// then checks the one thing a generated round trip cannot: that this build
// reproduces a value fixed by the specification.
//
// The generated half catches a broken AES, X25519 or HKDF. The fixed half
// catches the subtler failure — an implementation that is internally consistent
// and disagrees with every other reader of the format.
func e2eeSelfTest() error {
	// A grant, sealed and opened exactly as `xecret run` does.
	recipient, err := e2ee.GenerateEncryptionKeyPair()
	if err != nil {
		return err
	}

	edk, ehk := make([]byte, e2ee.KeyBytes), make([]byte, e2ee.KeyBytes)
	for i := range edk {
		edk[i], ehk[i] = byte(i), byte(255-i)
	}

	target := e2ee.GrantRecipient{
		EnvironmentID:      selfTestEnvironmentID,
		EDKVersion:         1,
		RecipientKind:      e2ee.RecipientToken,
		RecipientID:        selfTestRecipientID,
		RecipientPublicKey: recipient.PublicKey,
	}

	grant, err := e2ee.SealGrant(target, e2ee.EnvironmentKeys{EDK: edk, EHK: ehk})
	if err != nil {
		return fmt.Errorf("sealing a grant: %w", err)
	}

	opened, err := e2ee.OpenGrant(target, recipient.PrivateKey, grant)
	if err != nil {
		return fmt.Errorf("opening a grant: %w", err)
	}
	defer opened.Zeroize()

	if !bytes.Equal(opened.EDK, edk) || !bytes.Equal(opened.EHK, ehk) {
		return errors.New("a grant opened to the wrong keys")
	}

	// A secret, through the same AAD construction a real value uses.
	context := e2ee.SecretContext{
		Field:         e2ee.FieldValue,
		OrgID:         selfTestOrgID,
		EnvironmentID: selfTestEnvironmentID,
		SecretID:      selfTestSecretID,
		Version:       1,
	}
	const probe = "café ☕ 秘密"

	sealed, err := e2ee.EncryptSecret(opened.EDK, context, probe)
	if err != nil {
		return fmt.Errorf("encrypting: %w", err)
	}
	plaintext, err := e2ee.DecryptSecret(opened.EDK, context, sealed)
	if err != nil {
		return fmt.Errorf("decrypting: %w", err)
	}
	if plaintext != probe {
		return errors.New("a value did not survive a round trip")
	}

	// A relocated ciphertext must fail, or the AAD binding is not doing its job
	// and every environment on this machine is one row-swap from readable.
	elsewhere := context
	elsewhere.Version = 2
	if _, err := e2ee.DecryptSecret(opened.EDK, elsewhere, sealed); !errors.Is(err, e2ee.ErrDecrypt) {
		return errors.New("a ciphertext opened under the wrong version — AAD binding is broken")
	}

	// And the parser must refuse what it does not recognise.
	if _, err := e2ee.ParseBlob("xk3.gcm.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", e2ee.AlgGCM); !errors.Is(err, e2ee.ErrFormat) {
		return errors.New("the blob parser accepted a future format version")
	}

	return e2eeKnownAnswerTest()
}

// e2eeKnownAnswerTest reproduces one derivation whose answer is fixed by the
// specification.
//
// HKDF is the right one to pin: every key in the hierarchy comes through it, and
// it is where a wrong info string or a wrong salt convention produces a value
// that is internally consistent and interoperable with nobody. The expected
// output is `hkdf/value-hmac` from the vector file.
func e2eeKnownAnswerTest() error {
	const (
		ikmHex  = "858408ae1b9b4d3b5fa70a45635f8eb65042756ce19fb7b788e975bf7a8492bf"
		wantHex = "4c97be9b044756336a8ad403c8e519894929409d102533aeb37ce54281213f27"
	)

	ikm, err := hex.DecodeString(ikmHex)
	if err != nil {
		return err
	}

	// Reached through the exported HMAC path rather than through HKDF directly,
	// so the check covers the composition a real write performs.
	tag, err := e2ee.ComputeValueHmac(ikm, "")
	if err != nil {
		return err
	}
	if len(tag) != e2ee.KeyBytes {
		return fmt.Errorf("a valueHmac is %d bytes, got %d", e2ee.KeyBytes, len(tag))
	}

	derived, err := e2ee.DeriveValueHmacKey(ikm)
	if err != nil {
		return err
	}
	if hex.EncodeToString(derived) != wantHex {
		// Not a machine fault: a build that derives a different key from a fixed
		// input disagrees with every browser and every other CLI.
		return errors.New("a pinned key derivation produced the wrong answer; this build cannot interoperate")
	}
	return nil
}

// e2eeChecks appends the encryption checks to a doctor run.
func e2eeChecks(
	store keyring.Store,
	credentials *cred.Credentials,
	usingServiceToken bool,
	say func(status, name, format string, values ...any),
) {
	if err := e2eeSelfTest(); err != nil {
		say(statusFail, "encryption", "client encryption: broken (%v)", err)
	} else {
		say(statusOK, "encryption", "client encryption: self-test passed (xk2 seal, open, and a pinned derivation)")
	}

	if usingServiceToken {
		parsed, err := e2ee.SplitServiceToken(serviceTokenFromEnv())
		switch {
		case err != nil:
			// Not a fatal check: the token may still authenticate, and whether it
			// does is the server's answer rather than this binary's.
			say(statusWarn, "tokenFormat", "XECRET_TOKEN is not a recognised service token")
		case parsed.PrivateKey == nil:
			say(statusWarn, "tokenFormat",
				"XECRET_TOKEN carries no key — it predates end-to-end encryption and cannot read an e2ee environment; mint a replacement")
		default:
			parsed.Zeroize()
			say(statusOK, "tokenFormat", "XECRET_TOKEN carries its own key and can open an e2ee environment")
		}
		return
	}

	// A login's key, and the two ids that make it usable. Reported together
	// because they arrive together — a hand-off writes all three or none.
	switch _, err := store.Get(envkeys.UserKeyEntry); {
	case err == nil && credentials != nil && credentials.UserID != "" && credentials.OrgID != "":
		say(statusOK, "vaultKey", "vault key: held, and this account is identified")
		// The wrap the key opens. Its own line because its absence has its own
		// symptom and its own remedy: everything works until the network does
		// not, and then `--offline` fails on a machine whose key is perfectly
		// good. A login made by an earlier build is the usual cause.
		if _, wrapErr := store.Get(envkeys.VaultWrapsEntry); wrapErr == nil {
			say(statusOK, "offlineKey", "offline decryption: this machine holds what '--offline' needs")
		} else {
			say(statusWarn, "offlineKey",
				"offline decryption: not available yet — run any command with the API reachable once")
		}
	case err == nil:
		say(statusWarn, "vaultKey",
			"vault key: held, but this account's ids are missing — the next command that needs them will fetch them")
	case keyring.IsNotFound(err):
		say(statusWarn, "vaultKey",
			"vault key: none — end-to-end encrypted environments will not open; run 'xecret login' to hand one over")
	default:
		say(statusFail, "vaultKey", "vault key: unreadable (%v)", err)
	}
}
