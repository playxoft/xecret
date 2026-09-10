// The cross-implementation contract.
//
// Every value in e2ee-vectors.json was computed by the TypeScript
// implementation under packages/core/src/crypto/client. Nothing in it was
// written by hand. This file reproduces every one of them from the Go code in
// this package, which was written against docs/security/e2ee-crypto-spec.md
// rather than against that TypeScript — so a disagreement is a bug in one of
// them or an ambiguity in the spec, and all three get fixed before either ships.
//
// The test lives inside package e2ee, not e2ee_test, for one reason: it needs
// the unexported randomness-injecting entry points, encryptGCMWithIV and
// sealToPublicKeyWithRandomness. A vector suite cannot be reproducible unless
// its randomness is pinned, and a suite that forced an IV parameter into the
// exported API would have traded the property it exists to check for the
// ability to check it. In-package access is the whole of the protection.
package e2ee

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// vectorsPath resolves the one file both implementations read. It is inside
// packages/core so the TypeScript suite owns regeneration; the Go side is a
// reader only.
const vectorsPath = "../../../packages/core/src/crypto/client/vectors/e2ee-vectors.json"

type vectorFile struct {
	SpecVersion string   `json:"specVersion"`
	BlobVersion string   `json:"blobVersion"`
	Vectors     []vector `json:"vectors"`
}

type vector struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	Description string          `json:"description"`
	Input       json.RawMessage `json:"input"`
	Expected    json.RawMessage `json:"expected"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()

	data, err := os.ReadFile(filepath.FromSlash(vectorsPath))
	if err != nil {
		t.Fatalf("reading the vector file: %v", err)
	}

	var file vectorFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parsing the vector file: %v", err)
	}
	if file.BlobVersion != BlobVersion {
		t.Fatalf("vector file is for blob version %q, this package implements %q",
			file.BlobVersion, BlobVersion)
	}
	if len(file.Vectors) == 0 {
		t.Fatal("the vector file carries no vectors")
	}
	return file
}

// byKind groups the file so each kind's test states how many it ran — a kind
// that silently drops to zero vectors is a passing test that checks nothing.
func byKind(t *testing.T, kind string) []vector {
	t.Helper()

	var matching []vector
	for _, v := range loadVectors(t).Vectors {
		if v.Kind == kind {
			matching = append(matching, v)
		}
	}
	if len(matching) == 0 {
		t.Fatalf("the vector file carries no %q vectors", kind)
	}
	return matching
}

func decodeHex(t *testing.T, value, label string) []byte {
	t.Helper()
	raw, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("%s is not valid hex: %v", label, err)
	}
	return raw
}

func unmarshal(t *testing.T, raw json.RawMessage, out any, id string) {
	t.Helper()
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("%s: reading the vector: %v", id, err)
	}
}

func equalHex(t *testing.T, got []byte, wantHex, id, label string) {
	t.Helper()
	if actual := hex.EncodeToString(got); actual != wantHex {
		t.Errorf("%s: %s\n got %s\nwant %s", id, label, actual, wantHex)
	}
}

// ── §3.1 Argon2id ──────────────────────────────────────────────────────────

// TestArgon2idVectors runs the primitive beneath the parameter validator, at the
// deliberately cheap parameters the vector file uses. That carve-out is spec
// §12: the floor is a client-side policy control over server-supplied values,
// tested separately in TestKdfParamsFloorIsEnforced, and the same function, the
// same encoding, and the same NFC normalisation are exercised either way.
func TestArgon2idVectors(t *testing.T) {
	for _, v := range byKind(t, "argon2id") {
		var input struct {
			Passphrase       string         `json:"passphrase"`
			PassphraseRawHex string         `json:"passphraseRawHex"`
			SaltHex          string         `json:"saltHex"`
			Params           Argon2idParams `json:"params"`
		}
		var expected struct {
			SkHex string `json:"skHex"`
		}
		unmarshal(t, v.Input, &input, v.ID)
		unmarshal(t, v.Expected, &expected, v.ID)

		salt := decodeHex(t, input.SaltHex, "saltHex")

		got := argon2id(normalizedUTF8(input.Passphrase), salt, input.Params)
		equalHex(t, got, expected.SkHex, v.ID, "stretched key")

		// The whole point of the NFC vectors: `passphraseRawHex` is the
		// pre-normalisation spelling — the decomposed é a macOS keyboard
		// produces — and it must derive the same key as the composed form the
		// JSON string carries. Without normalisation, the same passphrase typed
		// on two machines derives two different keys and the second machine
		// reports "wrong passphrase" forever.
		if input.PassphraseRawHex != "" {
			raw := string(decodeHex(t, input.PassphraseRawHex, "passphraseRawHex"))
			if raw == input.Passphrase {
				t.Errorf("%s: the raw form is already NFC, so this vector tests nothing", v.ID)
			}
			equalHex(t, normalizedUTF8(raw), hex.EncodeToString([]byte(input.Passphrase)),
				v.ID, "NFC of the raw passphrase")
			equalHex(t, argon2id(normalizedUTF8(raw), salt, input.Params), expected.SkHex,
				v.ID, "stretched key from the decomposed spelling")
		}
	}
}

// ── §3.3 HKDF ──────────────────────────────────────────────────────────────

func TestHkdfVectors(t *testing.T) {
	for _, v := range byKind(t, "hkdf") {
		var input struct {
			IkmHex  string `json:"ikmHex"`
			SaltHex string `json:"saltHex"`
			Info    string `json:"info"`
			Length  int    `json:"length"`
		}
		var expected struct {
			OkmHex string `json:"okmHex"`
		}
		unmarshal(t, v.Input, &input, v.ID)
		unmarshal(t, v.Expected, &expected, v.ID)

		if input.Length != HKDFOutputBytes {
			t.Fatalf("%s: every derivation in this spec produces %d bytes, not %d",
				v.ID, HKDFOutputBytes, input.Length)
		}

		got, err := deriveKey(
			decodeHex(t, input.IkmHex, "ikmHex"),
			decodeHex(t, input.SaltHex, "saltHex"),
			input.Info,
		)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		equalHex(t, got, expected.OkmHex, v.ID, "derived key")
	}
}

// ── §2.2 types 1–3, User Key wraps ─────────────────────────────────────────

func TestUserKeyWrapVectors(t *testing.T) {
	for _, v := range byKind(t, "uk-wrap") {
		var input struct {
			UserID             string `json:"userId"`
			WrapKeyHex         string `json:"wrapKeyHex"`
			UkHex              string `json:"ukHex"`
			IvHex              string `json:"ivHex"`
			WrapKind           string `json:"wrapKind"`
			LookupHashHex      string `json:"lookupHashHex"`
			CredentialIDB64Url string `json:"credentialIdB64Url"`
		}
		var expected struct {
			Aad  string `json:"aad"`
			Blob string `json:"blob"`
		}
		unmarshal(t, v.Input, &input, v.ID)
		unmarshal(t, v.Expected, &expected, v.ID)

		context := WrapContext{UserID: input.UserID, Kind: WrapKind(input.WrapKind)}
		switch context.Kind {
		case WrapRecovery:
			context.Discriminator = input.LookupHashHex
		case WrapPRF:
			context.Discriminator = input.CredentialIDB64Url
		}

		aad, err := context.aad()
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		if aad != expected.Aad {
			t.Errorf("%s: aad\n got %s\nwant %s", v.ID, aad, expected.Aad)
		}

		wrapKey := decodeHex(t, input.WrapKeyHex, "wrapKeyHex")
		userKey := decodeHex(t, input.UkHex, "ukHex")

		ciphertext, err := encryptGCMWithIV(wrapKey, decodeHex(t, input.IvHex, "ivHex"), userKey, aad)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		blob, err := formatGCMBlob(decodeHex(t, input.IvHex, "ivHex"), ciphertext)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		if blob != expected.Blob {
			t.Errorf("%s: wrap blob\n got %s\nwant %s", v.ID, blob, expected.Blob)
		}

		// And back: the exported unwrap must open the vector's own blob, which
		// is what proves the Go side reads what the browser wrote rather than
		// merely writing the same bytes.
		opened, err := UnwrapUserKey(wrapKey, expected.Blob, context)
		if err != nil {
			t.Fatalf("%s: unwrapping the vector blob: %v", v.ID, err)
		}
		if !bytes.Equal(opened, userKey) {
			t.Errorf("%s: unwrapped User Key does not match", v.ID)
		}
	}
}

// ── §5 sealed box ──────────────────────────────────────────────────────────

func TestSealedBoxVectors(t *testing.T) {
	for _, v := range byKind(t, "sealed-box") {
		var input struct {
			Purpose             string `json:"purpose"`
			EnvironmentID       string `json:"environmentId"`
			EDKVersion          int    `json:"edkVersion"`
			RecipientKind       string `json:"recipientKind"`
			RecipientID         string `json:"recipientId"`
			RecipientPrivateKey string `json:"recipientPrivateKeyHex"`
			RecipientPublicKey  string `json:"recipientPublicKeyHex"`
			EphemeralPrivateKey string `json:"ephemeralPrivateKeyHex"`
			IvHex               string `json:"ivHex"`
			PlaintextHex        string `json:"plaintextHex"`
		}
		var expected struct {
			Aad                string `json:"aad"`
			EphemeralPublicKey string `json:"ephemeralPublicKeyHex"`
			SharedSecret       string `json:"sharedSecretHex"`
			DerivedKey         string `json:"derivedKeyHex"`
			Blob               string `json:"blob"`
		}
		unmarshal(t, v.Input, &input, v.ID)
		unmarshal(t, v.Expected, &expected, v.ID)

		kind := RecipientKind(input.RecipientKind)

		var aad string
		var err error
		if input.Purpose == "ehk-grant" {
			aad, err = EHKGrantAad(input.EnvironmentID, kind, input.RecipientID)
		} else {
			aad, err = EDKGrantAad(input.EnvironmentID, input.EDKVersion, kind, input.RecipientID)
		}
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		if aad != expected.Aad {
			t.Errorf("%s: aad\n got %s\nwant %s", v.ID, aad, expected.Aad)
		}

		recipientPublicKey := decodeHex(t, input.RecipientPublicKey, "recipientPublicKeyHex")
		ephemeralPrivateKey := decodeHex(t, input.EphemeralPrivateKey, "ephemeralPrivateKeyHex")
		plaintext := decodeHex(t, input.PlaintextHex, "plaintextHex")

		// The three intermediates are checked as well as the blob. Ed25519 aside,
		// a blob mismatch says only that something upstream differs; naming the
		// step that differs is what a cross-implementation bug hunt needs.
		ephemeralPublicKey, err := EncryptionPublicKey(ephemeralPrivateKey)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		equalHex(t, ephemeralPublicKey, expected.EphemeralPublicKey, v.ID, "ephemeral public key")

		shared := decodeHex(t, expected.SharedSecret, "sharedSecretHex")
		derived, err := sealedBoxKey(shared, ephemeralPublicKey, recipientPublicKey, aad)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		equalHex(t, derived, expected.DerivedKey, v.ID, "sealed box key")

		blob, err := sealToPublicKeyWithRandomness(
			recipientPublicKey, plaintext, aad,
			ephemeralPrivateKey, decodeHex(t, input.IvHex, "ivHex"),
		)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		if blob != expected.Blob {
			t.Errorf("%s: sealed blob\n got %s\nwant %s", v.ID, blob, expected.Blob)
		}

		opened, err := OpenSealedBox(decodeHex(t, input.RecipientPrivateKey, "recipientPrivateKeyHex"),
			expected.Blob, aad)
		if err != nil {
			t.Fatalf("%s: opening the vector blob: %v", v.ID, err)
		}
		if !bytes.Equal(opened, plaintext) {
			t.Errorf("%s: opened plaintext does not match", v.ID)
		}
	}
}

// ── §6 grant signatures ────────────────────────────────────────────────────

func TestGrantSignatureVectors(t *testing.T) {
	for _, v := range byKind(t, "grant-signature") {
		var input struct {
			SignerPrivateSeed  string `json:"signerPrivateSeedHex"`
			EnvironmentID      string `json:"environmentId"`
			EDKVersion         int    `json:"edkVersion"`
			RecipientKind      string `json:"recipientKind"`
			RecipientID        string `json:"recipientId"`
			RecipientPublicKey string `json:"recipientPublicKeyHex"`
			EDKSealedBlob      string `json:"edkSealedBlob"`
			EHKSealedBlob      string `json:"ehkSealedBlob"`
		}
		var expected struct {
			SignerPublicKey   string `json:"signerPublicKeyHex"`
			SigningPayloadHex string `json:"signingPayloadHex"`
			SignatureBlob     string `json:"signatureBlob"`
		}
		unmarshal(t, v.Input, &input, v.ID)
		unmarshal(t, v.Expected, &expected, v.ID)

		fields := GrantSignatureFields{
			EnvironmentID:      input.EnvironmentID,
			EDKVersion:         input.EDKVersion,
			RecipientKind:      RecipientKind(input.RecipientKind),
			RecipientID:        input.RecipientID,
			RecipientPublicKey: decodeHex(t, input.RecipientPublicKey, "recipientPublicKeyHex"),
			EDKSealed:          input.EDKSealedBlob,
			EHKSealed:          input.EHKSealedBlob,
		}

		// The canonical payload is checked before the signature, and that is the
		// point of carrying it in the file: Ed25519 is deterministic, so a
		// signature mismatch says only that something upstream differs, while
		// the payload bytes say which field the two implementations disagreed
		// about.
		payload, err := GrantSigningPayload(fields)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		equalHex(t, payload, expected.SigningPayloadHex, v.ID, "signing payload")

		seed := decodeHex(t, input.SignerPrivateSeed, "signerPrivateSeedHex")
		publicKey, err := SigningPublicKey(seed)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		equalHex(t, publicKey, expected.SignerPublicKey, v.ID, "signer public key")

		signature, err := SignGrant(seed, fields)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		if signature != expected.SignatureBlob {
			t.Errorf("%s: signature\n got %s\nwant %s", v.ID, signature, expected.SignatureBlob)
		}

		if !VerifyGrantSignature(publicKey, fields, expected.SignatureBlob) {
			t.Errorf("%s: the vector's own signature does not verify", v.ID)
		}

		// A verifier that accepts everything would pass every line above.
		tampered := fields
		tampered.EDKVersion++
		if VerifyGrantSignature(publicKey, tampered, expected.SignatureBlob) {
			t.Errorf("%s: a signature verified against a different edkVersion", v.ID)
		}
	}
}

// ── §2.2 types 9–10, §4 secret values and notes ────────────────────────────

func TestSecretValueVectors(t *testing.T) {
	for _, v := range byKind(t, "secret-value") {
		var input struct {
			Field         string `json:"field"`
			EdkHex        string `json:"edkHex"`
			OrgID         string `json:"orgId"`
			EnvironmentID string `json:"environmentId"`
			SecretID      string `json:"secretId"`
			Version       int    `json:"version"`
			Plaintext     string `json:"plaintext"`
			IvHex         string `json:"ivHex"`
		}
		var expected struct {
			Aad  string `json:"aad"`
			Blob string `json:"blob"`
		}
		unmarshal(t, v.Input, &input, v.ID)
		unmarshal(t, v.Expected, &expected, v.ID)

		context := SecretContext{
			Field:         SecretField(input.Field),
			OrgID:         input.OrgID,
			EnvironmentID: input.EnvironmentID,
			SecretID:      input.SecretID,
			Version:       input.Version,
		}

		aad, err := context.aad()
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		if aad != expected.Aad {
			t.Errorf("%s: aad\n got %s\nwant %s", v.ID, aad, expected.Aad)
		}

		edk := decodeHex(t, input.EdkHex, "edkHex")
		iv := decodeHex(t, input.IvHex, "ivHex")

		ciphertext, err := encryptGCMWithIV(edk, iv, normalizedUTF8(input.Plaintext), aad)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		blob, err := formatGCMBlob(iv, ciphertext)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		if blob != expected.Blob {
			t.Errorf("%s: ciphertext blob differs (%d chars vs %d)", v.ID, len(blob), len(expected.Blob))
		}

		plaintext, err := DecryptSecret(edk, context, expected.Blob)
		if err != nil {
			t.Fatalf("%s: decrypting the vector blob: %v", v.ID, err)
		}
		if plaintext != string(normalizedUTF8(input.Plaintext)) {
			t.Errorf("%s: decrypted plaintext does not match", v.ID)
		}
	}
}

// ── §9 valueHmac ───────────────────────────────────────────────────────────

func TestValueHmacVectors(t *testing.T) {
	for _, v := range byKind(t, "value-hmac") {
		var input struct {
			EhkHex    string `json:"ehkHex"`
			Plaintext string `json:"plaintext"`
		}
		var expected struct {
			HmacKeyHex   string `json:"hmacKeyHex"`
			ValueHmacHex string `json:"valueHmacHex"`
		}
		unmarshal(t, v.Input, &input, v.ID)
		unmarshal(t, v.Expected, &expected, v.ID)

		ehk := decodeHex(t, input.EhkHex, "ehkHex")

		hmacKey, err := deriveKey(ehk, nil, InfoValueHmac)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		equalHex(t, hmacKey, expected.HmacKeyHex, v.ID, "HMAC key")

		tag, err := ComputeValueHmac(ehk, input.Plaintext)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		equalHex(t, tag, expected.ValueHmacHex, v.ID, "valueHmac")
	}
}

// ── §7 recovery codes ──────────────────────────────────────────────────────

func TestRecoveryCodeVectors(t *testing.T) {
	for _, v := range byKind(t, "recovery-code") {
		var input struct {
			CodeBytesHex string `json:"codeBytesHex"`
			TypedInput   string `json:"typedInput"`
		}
		var expected struct {
			DataChars       string   `json:"dataChars"`
			CheckChar       string   `json:"checkChar"`
			DisplayForm     string   `json:"displayForm"`
			LookupHashHex   string   `json:"lookupHashHex"`
			RckHex          string   `json:"rckHex"`
			InvalidVariants []string `json:"invalidVariants"`
		}
		unmarshal(t, v.Input, &input, v.ID)
		unmarshal(t, v.Expected, &expected, v.ID)

		codeBytes := decodeHex(t, input.CodeBytesHex, "codeBytesHex")

		code, err := EncodeRecoveryCode(codeBytes)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		if code.DataChars != expected.DataChars {
			t.Errorf("%s: dataChars\n got %s\nwant %s", v.ID, code.DataChars, expected.DataChars)
		}
		if code.CheckChar != expected.CheckChar {
			t.Errorf("%s: checkChar got %s want %s", v.ID, code.CheckChar, expected.CheckChar)
		}
		if code.DisplayForm != expected.DisplayForm {
			t.Errorf("%s: displayForm\n got %s\nwant %s", v.ID, code.DisplayForm, expected.DisplayForm)
		}

		lookupHash, err := RecoveryLookupHash(codeBytes)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		equalHex(t, lookupHash, expected.LookupHashHex, v.ID, "lookup hash")

		rck, err := DeriveRecoveryKey(codeBytes)
		if err != nil {
			t.Fatalf("%s: %v", v.ID, err)
		}
		equalHex(t, rck, expected.RckHex, v.ID, "recovery code key")

		// Parsing the display form must recover the same bytes, and so must the
		// form a human actually types — lower case, no hyphens, with I/L/O
		// standing in for 1/1/0.
		for _, form := range []string{expected.DisplayForm, input.TypedInput} {
			if form == "" {
				continue
			}
			parsed, err := ParseRecoveryCode(form)
			if err != nil {
				t.Fatalf("%s: parsing %q: %v", v.ID, form, err)
			}
			if !bytes.Equal(parsed.CodeBytes, codeBytes) {
				t.Errorf("%s: parsing %q recovered different bytes", v.ID, form)
			}
		}

		// The check character is only worth having if it rejects. Each variant
		// is one substitution or transposition away from a valid code.
		for _, invalid := range expected.InvalidVariants {
			if _, err := ParseRecoveryCode(invalid); err == nil {
				t.Errorf("%s: %q was accepted; it is a typo of a real code", v.ID, invalid)
			}
		}
	}
}

// ── §2 negative parses ─────────────────────────────────────────────────────

// TestBlobParseVectors is the half of the contract that asserts a *refusal*.
//
// ADR 0009's definition of done requires that every parser refuses every version
// it does not know, and that requirement is only tested if the negative case is
// a first-class vector rather than an ad-hoc unit test on one side.
func TestBlobParseVectors(t *testing.T) {
	for _, v := range byKind(t, "blob-parse") {
		var input struct {
			Blob   string `json:"blob"`
			Reason string `json:"reason"`
			KeyHex string `json:"keyHex"`
			Aad    string `json:"aad"`
		}
		var expected struct {
			Rejected   bool   `json:"rejected"`
			ErrorClass string `json:"errorClass"`
		}
		unmarshal(t, v.Input, &input, v.ID)
		unmarshal(t, v.Expected, &expected, v.ID)

		if !expected.Rejected {
			t.Fatalf("%s: a blob-parse vector must expect a rejection", v.ID)
		}

		switch expected.ErrorClass {
		case "format":
			// The algorithm the caller would have asked for. A vector whose tag
			// is not one this package knows is asked for as gcm, which is what a
			// caller reading a wrap column would have done.
			expectedAlg := AlgGCM
			if _, rest, ok := cutTwice(input.Blob); ok && Algorithm(rest) == AlgX25519 {
				expectedAlg = AlgX25519
			}

			_, err := ParseBlob(input.Blob, expectedAlg)
			if !errors.Is(err, ErrFormat) {
				t.Errorf("%s (%s): want ErrFormat, got %v", v.ID, input.Reason, err)
			}
			if errors.Is(err, ErrDecrypt) {
				t.Errorf("%s: a format failure must not surface as a decryption failure", v.ID)
			}

		case "decryption":
			iv, ciphertext, err := parseGCMBlob(input.Blob)
			if err != nil {
				t.Fatalf("%s: the vector's blob should parse and fail to open: %v", v.ID, err)
			}
			_, err = decryptGCM(decodeHex(t, input.KeyHex, "keyHex"), iv, ciphertext, input.Aad)
			if !errors.Is(err, ErrDecrypt) {
				t.Errorf("%s (%s): want ErrDecrypt, got %v", v.ID, input.Reason, err)
			}
			// Uniform means uniform: the message must not name the reason.
			if err != nil && err.Error() != ErrDecrypt.Error() {
				t.Errorf("%s: decryption failure carried detail: %q", v.ID, err)
			}

		default:
			t.Fatalf("%s: unknown errorClass %q", v.ID, expected.ErrorClass)
		}
	}
}

// cutTwice returns the algorithm field of a three-part blob.
func cutTwice(blob string) (version, algorithm string, ok bool) {
	first := -1
	for i := 0; i < len(blob); i++ {
		if blob[i] != '.' {
			continue
		}
		if first < 0 {
			first = i
			continue
		}
		return blob[:first], blob[first+1 : i], true
	}
	return "", "", false
}

// TestEveryVectorKindIsCovered fails when the file grows a kind this package
// does not check.
//
// The vectors are the mechanism by which the specification is enforced rather
// than merely written. A new kind landing in the file and being silently ignored
// here would leave a construction cross-checked by nobody, which is the one
// failure mode this whole file exists to prevent.
func TestEveryVectorKindIsCovered(t *testing.T) {
	covered := map[string]bool{
		"argon2id": true, "hkdf": true, "uk-wrap": true, "sealed-box": true,
		"grant-signature": true, "secret-value": true, "value-hmac": true,
		"recovery-code": true, "blob-parse": true,
	}

	counts := map[string]int{}
	for _, v := range loadVectors(t).Vectors {
		counts[v.Kind]++
		if !covered[v.Kind] {
			t.Errorf("vector kind %q (%s) has no Go test", v.Kind, v.ID)
		}
	}
	for kind := range covered {
		if counts[kind] == 0 {
			t.Errorf("no %q vectors in the file; this package's coverage claim is stale", kind)
		}
	}
	t.Logf("validated %d vectors across %d kinds", len(loadVectors(t).Vectors), len(counts))
}
