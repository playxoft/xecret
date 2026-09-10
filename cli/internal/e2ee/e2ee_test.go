package e2ee

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// The vectors prove this package agrees with the browser. These prove the
// properties the vectors cannot: that the client-side policy controls refuse
// what they are there to refuse, and that a failure fails closed.

const (
	testOrgID    = "018f3b2c-9c1a-7c3d-8e4f-0a1b2c3d4e5f"
	testEnvID    = "018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e5f"
	testSecretID = "018f3b2c-9c1a-7c3d-8e4f-2a1b2c3d4e5f"
	testUserID   = "018f3b2c-9c1a-7c3d-8e4f-3a1b2c3d4e5f"
	testMemberID = "018f3b2c-9c1a-7c3d-8e4f-4a1b2c3d4e5f"
	testTokenID  = "018f3b2c-9c1a-7c3d-8e4f-5a1b2c3d4e5f"
)

func randomKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, KeyBytes)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("crypto/rand: %v", err)
	}
	return key
}

// TestKdfParamsFloorIsEnforced covers the control the argon2id vectors
// deliberately run beneath.
//
// These parameters arrive from the server. A client that runs a memory-hard KDF
// with unvalidated server-supplied cost parameters can be made to allocate
// arbitrary memory by a hostile or compromised server, so this is a security
// control and not a sanity check.
func TestKdfParamsFloorIsEnforced(t *testing.T) {
	refused := map[string]string{
		"memory below the OWASP floor":    `{"alg":"argon2id","v":19,"m":8192,"t":3,"p":1,"len":32}`,
		"memory past a gigabyte":          `{"alg":"argon2id","v":19,"m":2097152,"t":3,"p":1,"len":32}`,
		"time cost of zero":               `{"alg":"argon2id","v":19,"m":65536,"t":0,"p":1,"len":32}`,
		"time cost past the ceiling":      `{"alg":"argon2id","v":19,"m":65536,"t":99,"p":1,"len":32}`,
		"argon2i rather than argon2id":    `{"alg":"argon2i","v":19,"m":65536,"t":3,"p":1,"len":32}`,
		"a version this client is not":    `{"alg":"argon2id","v":16,"m":65536,"t":3,"p":1,"len":32}`,
		"more lanes than one":             `{"alg":"argon2id","v":19,"m":65536,"t":3,"p":4,"len":32}`,
		"an output length that is not 32": `{"alg":"argon2id","v":19,"m":65536,"t":3,"p":1,"len":64}`,
		"a field this client cannot read": `{"alg":"argon2id","v":19,"m":65536,"t":3,"p":1,"len":32,"pepper":"x"}`,
	}

	for description, params := range refused {
		if _, err := ParseKdfParams(json.RawMessage(params)); err == nil {
			t.Errorf("accepted %s: %s", description, params)
		}
	}

	current, err := json.Marshal(CurrentKDFParams)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseKdfParams(current)
	if err != nil {
		t.Fatalf("the current parameters were refused: %v", err)
	}
	if KdfNeedsUpgrade(parsed) {
		t.Error("the current parameters were reported as needing an upgrade")
	}
}

// TestKdfUpgradeAlsoTriggersOnALowerCost is the reason the comparison is `!=`
// and not `<`. An upgrade must be able to lower a cost, if a parameter was ever
// set to a value some platform cannot reach.
func TestKdfUpgradeAlsoTriggersOnALowerCost(t *testing.T) {
	lower := CurrentKDFParams
	lower.M = 32_768
	higher := CurrentKDFParams
	higher.T = 5

	if !KdfNeedsUpgrade(lower) {
		t.Error("a record below the current cost was not marked for upgrade")
	}
	if !KdfNeedsUpgrade(higher) {
		t.Error("a record above the current cost was not marked for upgrade")
	}
}

// TestUnregisteredHkdfInfoIsRefused: a typo in an info string does not fail
// loudly on its own. It derives a different, perfectly valid-looking key, and
// the failure surfaces much later as an undecryptable blob.
func TestUnregisteredHkdfInfoIsRefused(t *testing.T) {
	for _, info := range []string{
		"",
		"xecret.v2.uk-wrap ",           // trailing space
		"xecret.v2.ukwrap",             // the typo this check exists for
		"xecret.v1.uk-wrap",            // the retired version
		"xecret.aad.v1.secret|a|b|c|1", // a v1 AAD, not a v2 one
		"anything at all",
	} {
		if _, err := deriveKey(randomKey(t), nil, info); err == nil {
			t.Errorf("derived a key under the unregistered info string %q", info)
		}
	}

	// The one branch that is not a fixed constant: a sealed box passes the
	// blob's full v2 AAD as its info.
	aad, err := EDKGrantAad(testEnvID, 1, RecipientMember, testMemberID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deriveKey(randomKey(t), nil, aad); err != nil {
		t.Errorf("a v2 AAD was refused as an info string: %v", err)
	}
}

// TestBlobParserRejectsWhatItDoesNotRecognise. A blob written by a future
// version must fail to parse rather than be misread as this one, because the
// alternative is a silent misinterpretation of key material.
func TestBlobParserRejectsWhatItDoesNotRecognise(t *testing.T) {
	valid, err := formatGCMBlob(make([]byte, ivLength), make([]byte, gcmTagLength))
	if err != nil {
		t.Fatal(err)
	}

	for description, blob := range map[string]string{
		"a future version":            strings.Replace(valid, "xk2.", "xk9.", 1),
		"no version at all":           strings.TrimPrefix(valid, "xk2."),
		"a fourth field":              valid + ".extra",
		"an unknown algorithm":        strings.Replace(valid, ".gcm.", ".xsalsa20.", 1),
		"standard base64 padding":     "xk2.gcm.AAAA====",
		"standard base64 alphabet":    "xk2.gcm.++++////AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"an empty payload":            "xk2.gcm.",
		"a payload below the minimum": "xk2.gcm.AAAAAAAA",
	} {
		if _, err := ParseBlob(blob, AlgGCM); !errors.Is(err, ErrFormat) {
			t.Errorf("%s was not rejected as a format error: %v", description, err)
		}
	}

	// The expected algorithm is passed in because the caller always knows which
	// construction it wants — the column it read from says so.
	if _, err := ParseBlob(valid, AlgX25519); !errors.Is(err, ErrFormat) {
		t.Error("a gcm blob was accepted where a sealed box belongs")
	}
}

// TestSealedBoxFailsClosed. Every failure that depends on key material is one
// indistinguishable error carrying no detail: distinguishing them tells an
// attacker probing the API which part of their guess was wrong.
func TestSealedBoxFailsClosed(t *testing.T) {
	recipient, err := GenerateEncryptionKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	stranger, err := GenerateEncryptionKeyPair()
	if err != nil {
		t.Fatal(err)
	}

	aad, err := EDKGrantAad(testEnvID, 1, RecipientMember, testMemberID)
	if err != nil {
		t.Fatal(err)
	}
	edk := randomKey(t)

	blob, err := SealToPublicKey(recipient.PublicKey, edk, aad)
	if err != nil {
		t.Fatal(err)
	}

	opened, err := OpenSealedBox(recipient.PrivateKey, blob, aad)
	if err != nil {
		t.Fatalf("the right key and the right AAD did not open the box: %v", err)
	}
	if !bytes.Equal(opened, edk) {
		t.Error("the box opened to the wrong plaintext")
	}

	if _, err := OpenSealedBox(stranger.PrivateKey, blob, aad); !errors.Is(err, ErrDecrypt) {
		t.Errorf("a stranger's key produced %v, want ErrDecrypt", err)
	}

	// The relocation attack the AAD exists to defeat: the same blob, presented
	// as a grant for a different EDK version.
	otherVersion, err := EDKGrantAad(testEnvID, 2, RecipientMember, testMemberID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenSealedBox(recipient.PrivateKey, blob, otherVersion); !errors.Is(err, ErrDecrypt) {
		t.Errorf("a grant opened under a different edkVersion: %v", err)
	}

	// And as a grant for a service token rather than a member — the field most
	// likely to be hard-coded to `member` by accident.
	otherKind, err := EDKGrantAad(testEnvID, 1, RecipientToken, testMemberID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenSealedBox(recipient.PrivateKey, blob, otherKind); !errors.Is(err, ErrDecrypt) {
		t.Errorf("a member grant opened as a token grant: %v", err)
	}
}

// TestAllZeroSharedSecretIsRejected. X25519 returns all zeros for low-order
// input points, and continuing past that would derive a key an attacker chose.
func TestAllZeroSharedSecretIsRejected(t *testing.T) {
	if _, err := sealedBoxKey(make([]byte, KeyBytes), make([]byte, PublicKeyBytes),
		make([]byte, PublicKeyBytes), "xecret.aad.v2.edk-grant|a|1|member|b"); err == nil {
		t.Error("an all-zero shared secret was used to derive a key")
	}

	// The same requirement through the exported path: a low-order public key.
	recipient, err := GenerateEncryptionKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	aad, err := EDKGrantAad(testEnvID, 1, RecipientMember, testMemberID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := SealToPublicKey(make([]byte, PublicKeyBytes), randomKey(t), aad); err == nil {
		t.Error("sealed to an all-zero public key")
	}
	_ = recipient
}

// TestAadComponentsCannotCarryTheDelimiter. `|` cannot appear inside a
// component, which is the whole reason the encoding needs no length prefixes.
// Without the assertion, an identifier containing `|` could produce the same AAD
// as a different tuple.
func TestAadComponentsCannotCarryTheDelimiter(t *testing.T) {
	if _, err := SecretValueAad("018f3b2c-9c1a-7c3d-8e4f-0a1b2c3d|4e5f", testEnvID, testSecretID, 1); err == nil {
		t.Error("an orgId containing the delimiter was accepted")
	}
	if _, err := UserKeyWrapAad(testUserID, WrapPRF, "credential|id"); err == nil {
		t.Error("a credential id containing the delimiter was accepted")
	}
	if _, err := UserKeyWrapAad(testUserID, WrapPRF, ""); err == nil {
		t.Error("an empty discriminator was accepted for a prf wrap")
	}
	if _, err := SecretValueAad(testOrgID, testEnvID, testSecretID, -1); err == nil {
		t.Error("a negative version was accepted")
	}
	if _, err := EDKGrantAad(testEnvID, 1, RecipientKind("admin"), testMemberID); err == nil {
		t.Error("an unregistered recipient kind was accepted")
	}

	// Uppercase UUIDs are two spellings of the same bytes, and accepting both is
	// how inconsistent-comparison bugs start.
	if _, err := PrivateKeyEncAad(strings.ToUpper(testUserID)); err == nil {
		t.Error("an uppercase UUID was accepted")
	}
}

// TestAadNeverEchoesTheOffendingValue: these paths carry secret identifiers and
// credential ids, and error messages reach logs.
func TestAadNeverEchoesTheOffendingValue(t *testing.T) {
	const offending = "s3cr3t-identifier-nobody-should-log"

	_, err := SecretValueAad(offending, testEnvID, testSecretID, 1)
	if err == nil {
		t.Fatal("expected a rejection")
	}
	if strings.Contains(err.Error(), offending) {
		t.Errorf("the rejected value reached the error message: %q", err)
	}

	_, err = ParseBlob("xk2.gcm."+offending, AlgGCM)
	if err == nil {
		t.Fatal("expected a rejection")
	}
	if strings.Contains(err.Error(), offending) {
		t.Errorf("the rejected blob reached the error message: %q", err)
	}
}

// TestGrantRoundTripAcrossPrincipalKinds. A member, a service token, and an
// invitation are one operation with two AAD components' difference — which is
// why a service token survives an EDK rotation.
func TestGrantRoundTripAcrossPrincipalKinds(t *testing.T) {
	keys := EnvironmentKeys{EDK: randomKey(t), EHK: randomKey(t)}

	for _, kind := range []RecipientKind{RecipientMember, RecipientToken, RecipientInvite} {
		principal, err := GenerateEncryptionKeyPair()
		if err != nil {
			t.Fatal(err)
		}

		recipient := GrantRecipient{
			EnvironmentID:      testEnvID,
			EDKVersion:         3,
			RecipientKind:      kind,
			RecipientID:        testTokenID,
			RecipientPublicKey: principal.PublicKey,
		}

		grant, err := SealGrant(recipient, keys)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if grant.EDKSealed == grant.EHKSealed {
			t.Errorf("%s: the two blobs are identical; one ephemeral key was reused", kind)
		}

		opened, err := OpenGrant(recipient, principal.PrivateKey, grant)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if !bytes.Equal(opened.EDK, keys.EDK) || !bytes.Equal(opened.EHK, keys.EHK) {
			t.Errorf("%s: the grant opened to the wrong keys", kind)
		}

		// A grant for version 3 must not open as a grant for version 4.
		rotated := recipient
		rotated.EDKVersion = 4
		if _, err := OpenGrant(rotated, principal.PrivateKey, grant); err == nil {
			t.Errorf("%s: a grant opened at the wrong EDK version", kind)
		}
	}
}

// TestValueHmacSurvivesAnEdkRotation is the entire reason the EHK exists. If the
// HMAC key rotated with the EDK, the first write to every secret after a
// rotation would be recorded as a change when nothing changed.
func TestValueHmacSurvivesAnEdkRotation(t *testing.T) {
	ehk := randomKey(t)
	const value = "postgres://app:hunter2@db.example.com:5432/app"

	before, err := ComputeValueHmac(ehk, value)
	if err != nil {
		t.Fatal(err)
	}

	// A rotation replaces the EDK and leaves the EHK alone, so the same value
	// must produce the same tag.
	after, err := ComputeValueHmac(ehk, value)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Error("valueHmac is not stable for one EHK")
	}

	// Two environments hold unrelated EHKs, which is what binds the tag to the
	// environment without an environmentId in the info string.
	elsewhere, err := ComputeValueHmac(randomKey(t), value)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(before, elsewhere) {
		t.Error("two environments produced the same valueHmac for one value")
	}

	if len(EncodeValueHmac(before)) != 43 {
		t.Errorf("a transported valueHmac is 43 base64url characters, got %d", len(EncodeValueHmac(before)))
	}
}

// TestSecretRoundTripAndItsBounds.
func TestSecretRoundTripAndItsBounds(t *testing.T) {
	edk := randomKey(t)
	context := SecretContext{
		Field: FieldValue, OrgID: testOrgID, EnvironmentID: testEnvID,
		SecretID: testSecretID, Version: 4,
	}

	for _, plaintext := range []string{"", "hunter2", "café ☕ 秘密", strings.Repeat("x", MaxSecretValueBytes)} {
		blob, err := EncryptSecret(edk, context, plaintext)
		if err != nil {
			t.Fatalf("encrypting %d bytes: %v", len(plaintext), err)
		}
		if len(blob) > MaxSecretBlobLength {
			t.Errorf("a conforming blob exceeded MaxSecretBlobLength: %d > %d", len(blob), MaxSecretBlobLength)
		}

		decrypted, err := DecryptSecret(edk, context, blob)
		if err != nil {
			t.Fatalf("decrypting %d bytes: %v", len(plaintext), err)
		}
		if decrypted != plaintext {
			t.Errorf("round trip changed a %d-byte value", len(plaintext))
		}
	}

	// A client refuses an oversized plaintext long before the server sees it.
	if _, err := EncryptSecret(edk, context, strings.Repeat("x", MaxSecretValueBytes+1)); err == nil {
		t.Error("a plaintext past MAX_SECRET_VALUE_BYTES was encrypted")
	}

	// The derived server bound, from the spec's own arithmetic.
	if MaxSecretBlobLength != 87_428 {
		t.Errorf("MaxSecretBlobLength = %d, spec §2.2 derives 87428", MaxSecretBlobLength)
	}

	// A value ciphertext must not open as a note: the version component is the
	// difference, and a note carries none.
	blob, err := EncryptSecret(edk, context, "hunter2")
	if err != nil {
		t.Fatal(err)
	}
	note := context
	note.Field = FieldNote
	if _, err := DecryptSecret(edk, note, blob); !errors.Is(err, ErrDecrypt) {
		t.Errorf("a value ciphertext opened as a note: %v", err)
	}
}

// TestUserKeyWrapsAreBoundToTheirOwnRow. All five recovery wraps hold the same
// User Key, so without a discriminator in the AAD a row swap would go undetected.
func TestUserKeyWrapsAreBoundToTheirOwnRow(t *testing.T) {
	userKey := randomKey(t)
	wrapKey := randomKey(t)

	firstHash, secondHash := randomKey(t), randomKey(t)
	first := RecoveryWrapContext(testUserID, firstHash)
	second := RecoveryWrapContext(testUserID, secondHash)

	blob, err := WrapUserKey(wrapKey, userKey, first)
	if err != nil {
		t.Fatal(err)
	}

	opened, err := UnwrapUserKey(wrapKey, blob, first)
	if err != nil {
		t.Fatalf("the wrap did not open under its own context: %v", err)
	}
	if !bytes.Equal(opened, userKey) {
		t.Error("the wrap opened to the wrong User Key")
	}

	if _, err := UnwrapUserKey(wrapKey, blob, second); !errors.Is(err, ErrDecrypt) {
		t.Error("a recovery wrap opened under another code's lookup hash")
	}

	passphrase := WrapContext{UserID: testUserID, Kind: WrapPassphrase}
	if _, err := UnwrapUserKey(wrapKey, blob, passphrase); !errors.Is(err, ErrDecrypt) {
		t.Error("a recovery wrap opened as the passphrase wrap")
	}
}

// TestPrivateKeysAreBoundToTheirPurpose, so the X25519 blob cannot be presented
// where the Ed25519 blob belongs.
func TestPrivateKeysAreBoundToTheirPurpose(t *testing.T) {
	userKey := randomKey(t)
	scalar := randomKey(t)

	blob, err := WrapPrivateKey(userKey, scalar, testUserID, PurposeEncryption)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := UnwrapPrivateKey(userKey, blob, testUserID, PurposeSigning); !errors.Is(err, ErrDecrypt) {
		t.Error("an encryption key opened as a signing key")
	}
	if _, err := UnwrapPrivateKey(userKey, blob, testMemberID, PurposeEncryption); !errors.Is(err, ErrDecrypt) {
		t.Error("one user's private key opened under another user's id")
	}

	opened, err := UnwrapPrivateKey(userKey, blob, testUserID, PurposeEncryption)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(opened, scalar) {
		t.Error("the private key round trip changed the scalar")
	}
}

// TestVerifierBranchesAreNotInterchangeable. The two verifiers hash to distinct
// stored columns, so a value captured from one path can never be replayed down
// the other.
func TestVerifierBranchesAreNotInterchangeable(t *testing.T) {
	stretchedKey := randomKey(t)
	userKey := randomKey(t)

	unlock, err := DeriveUnlockVerifier(stretchedKey)
	if err != nil {
		t.Fatal(err)
	}
	wrapKey, err := DerivePassphraseWrapKey(stretchedKey)
	if err != nil {
		t.Fatal(err)
	}
	ukUnlock, err := DeriveUKUnlockVerifier(userKey)
	if err != nil {
		t.Fatal(err)
	}

	// The verifier is handed to the server. If it were the wrap key, or derived
	// from it by anything invertible, a server holding verifiers would hold wrap
	// keys.
	if bytes.Equal(unlock, wrapKey) {
		t.Fatal("the unlock verifier and the passphrase wrap key are the same value")
	}
	if bytes.Equal(unlock, ukUnlock) {
		t.Error("the two unlock verifiers collide")
	}

	// And the UK branch is the only one taking the User Key as input keying
	// material; a 31-byte value is not a User Key.
	if _, err := DeriveUKUnlockVerifier(make([]byte, KeyBytes-1)); err == nil {
		t.Error("a short User Key was accepted")
	}
}

// TestNormalizationReachesEveryTextInput. The same value typed on two platforms
// must produce the same ciphertext context and the same valueHmac.
func TestNormalizationReachesEveryTextInput(t *testing.T) {
	// Written as escapes rather than literal characters so an editor that
	// normalises this file cannot silently turn the test into a tautology.
	const composed = "café"    // e-acute as one code point
	const decomposed = "café" // e followed by a combining acute

	if composed == decomposed {
		t.Fatal("the two spellings are identical; this test proves nothing")
	}

	ehk := randomKey(t)
	first, err := ComputeValueHmac(ehk, composed)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ComputeValueHmac(ehk, decomposed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Error("two spellings of one value produced different valueHmacs")
	}

	edk := randomKey(t)
	context := SecretContext{
		Field: FieldValue, OrgID: testOrgID, EnvironmentID: testEnvID,
		SecretID: testSecretID, Version: 1,
	}
	blob, err := EncryptSecret(edk, context, decomposed)
	if err != nil {
		t.Fatal(err)
	}
	decrypted, err := DecryptSecret(edk, context, blob)
	if err != nil {
		t.Fatal(err)
	}
	if decrypted != composed {
		t.Errorf("a decomposed value did not decrypt to its NFC form: %q", decrypted)
	}
}

// TestGrantSignatureCoversEveryField. Each field is length-prefixed so the
// payload is unambiguously constructible; changing any one must invalidate.
func TestGrantSignatureCoversEveryField(t *testing.T) {
	seed := randomKey(t)
	publicKey, err := SigningPublicKey(seed)
	if err != nil {
		t.Fatal(err)
	}

	recipient, err := GenerateEncryptionKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	keys := EnvironmentKeys{EDK: randomKey(t), EHK: randomKey(t)}
	base := GrantRecipient{
		EnvironmentID: testEnvID, EDKVersion: 1, RecipientKind: RecipientToken,
		RecipientID: testTokenID, RecipientPublicKey: recipient.PublicKey,
	}
	grant, err := SealGrant(base, keys)
	if err != nil {
		t.Fatal(err)
	}

	fields := GrantSignatureFields{
		EnvironmentID: base.EnvironmentID, EDKVersion: base.EDKVersion,
		RecipientKind: base.RecipientKind, RecipientID: base.RecipientID,
		RecipientPublicKey: base.RecipientPublicKey,
		EDKSealed:          grant.EDKSealed, EHKSealed: grant.EHKSealed,
	}

	signature, err := SignGrant(seed, fields)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyGrantSignature(publicKey, fields, signature) {
		t.Fatal("a freshly signed grant did not verify")
	}

	mutations := map[string]func(*GrantSignatureFields){
		"environmentId": func(f *GrantSignatureFields) { f.EnvironmentID = testOrgID },
		"edkVersion":    func(f *GrantSignatureFields) { f.EDKVersion = 2 },
		// A server must not be able to relabel a service-token grant as a member
		// grant, or move a valid grant between two principals.
		"recipientKind":      func(f *GrantSignatureFields) { f.RecipientKind = RecipientMember },
		"recipientId":        func(f *GrantSignatureFields) { f.RecipientID = testMemberID },
		"recipientPublicKey": func(f *GrantSignatureFields) { f.RecipientPublicKey = randomKey(t) },
		// Signing only the EDK would leave the EHK unauthenticated in a row that
		// claims to be authenticated.
		"ehkSealed": func(f *GrantSignatureFields) { f.EHKSealed = f.EDKSealed },
	}

	for name, mutate := range mutations {
		altered := fields
		mutate(&altered)
		if VerifyGrantSignature(publicKey, altered, signature) {
			t.Errorf("the signature still verified after changing %s", name)
		}
	}

	// A malformed signature blob is "unverified", not an error: a verifier that
	// throws on some rejections and returns false on others invites a caller to
	// handle one path and not the other.
	if VerifyGrantSignature(publicKey, fields, "not-a-blob") {
		t.Error("a malformed signature verified")
	}
	if VerifyGrantSignature(publicKey, fields, grant.EDKSealed) {
		t.Error("a sealed box verified as a signature")
	}
}

// TestSigningPayloadRefusesAnUnopenableBlob: a signature over a string that is
// not a sealed box would authenticate something no reader can open.
func TestSigningPayloadRefusesAnUnopenableBlob(t *testing.T) {
	fields := GrantSignatureFields{
		EnvironmentID: testEnvID, EDKVersion: 1, RecipientKind: RecipientMember,
		RecipientID: testMemberID, RecipientPublicKey: randomKey(t),
		EDKSealed: "xk2.gcm.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		EHKSealed: "xk2.x25519.AAAA",
	}
	if _, err := GrantSigningPayload(fields); err == nil {
		t.Error("a payload was built over a blob that is not a sealed box")
	}
}

// TestPublicKeyTransportRejectsWrongLengths.
func TestPublicKeyTransportRejectsWrongLengths(t *testing.T) {
	pair, err := GenerateEncryptionKeyPair()
	if err != nil {
		t.Fatal(err)
	}

	encoded, err := EncodePublicKey(pair.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) != 43 {
		t.Errorf("a transported public key is 43 base64url characters, got %d", len(encoded))
	}

	decoded, err := DecodePublicKey(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded, pair.PublicKey) {
		t.Error("the public key round trip changed the key")
	}

	for _, bad := range []string{"", "AAAA", encoded + "AA", encoded + "==", strings.Repeat("A", 43) + "!"} {
		if _, err := DecodePublicKey(bad); err == nil {
			t.Errorf("accepted %q as a public key", bad)
		}
	}
}

// TestZeroizeOverwrites. It narrows the window in which a heap snapshot yields a
// usable key; it does not close it, and it is not a control to rely on.
func TestZeroizeOverwrites(t *testing.T) {
	keys := EnvironmentKeys{EDK: randomKey(t), EHK: randomKey(t)}
	keys.Zeroize()

	if !isAllZero(keys.EDK) || !isAllZero(keys.EHK) {
		t.Error("Zeroize left key material in the buffer")
	}
}
