package e2ee

import (
	"bytes"
	"crypto/rand"
	"errors"
	"strings"
	"testing"
)

// The service token's two halves (spec §13.1).
//
// The sibling assertions live in `packages/core/src/auth/auth.test.ts`. Both
// suites exist because both implementations parse this string, and the
// separator is one `strings.IndexByte` away from splitting half of all tokens in
// the wrong place.

const (
	authHalf = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	keyHalf  = "f39_f39_f39_f39_f39_f39_f39_f39_f39_f39_f38"
)

func TestSplitsAtAFixedOffsetNotAtTheFirstK(t *testing.T) {
	// The regression this format is one `IndexByte` away from. `k` is in the
	// base64url alphabet, so it appears inside both halves about half the time;
	// searching for the separator instead of reading it at offset 43 produces an
	// auth half that will never authenticate and a key half that opens nothing —
	// with no error to explain either.
	sawEarlyK := false

	for i := 0; i < 200; i++ {
		key := make([]byte, KeyBytes)
		if _, err := rand.Read(key); err != nil {
			t.Fatal(err)
		}
		auth := make([]byte, KeyBytes)
		if _, err := rand.Read(auth); err != nil {
			t.Fatal(err)
		}

		authSegment := b64url.EncodeToString(auth)
		if strings.ContainsRune(authSegment, 'k') {
			sawEarlyK = true
		}

		token := "xst_live_" + authSegment + "k" + b64url.EncodeToString(key)
		parsed, err := SplitServiceToken(token)
		if err != nil {
			t.Fatalf("iteration %d: %v", i, err)
		}
		if parsed.AuthToken != "xst_live_"+authSegment {
			t.Fatalf("iteration %d: auth half\n got %q\nwant %q",
				i, parsed.AuthToken, "xst_live_"+authSegment)
		}
		if !bytes.Equal(parsed.PrivateKey, key) {
			t.Fatalf("iteration %d: key half does not round-trip", i)
		}
	}

	if !sawEarlyK {
		t.Error("expected at least one auth half containing a `k`")
	}
}

func TestALegacyTokenParsesWithNoKey(t *testing.T) {
	// Every token minted before this format, and every token for a server-mode
	// environment. Refusing it would revoke all of them.
	token := "xst_live_" + authHalf

	parsed, err := SplitServiceToken(token)
	if err != nil {
		t.Fatalf("a legacy token was refused: %v", err)
	}
	if parsed.AuthToken != token {
		t.Errorf("auth half = %q", parsed.AuthToken)
	}
	if parsed.PrivateKey != nil {
		t.Error("a key half was invented for a token that carries none")
	}
}

func TestOnlyTheAuthHalfIsTransmittable(t *testing.T) {
	// The property the whole split exists for: what the server hashes is the
	// auth half alone, and the full string must never reach a header.
	parsed, err := SplitServiceToken("xst_live_" + authHalf + "k" + keyHalf)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(parsed.AuthToken, keyHalf) {
		t.Error("the key half reached the transmittable half")
	}
	if len(parsed.AuthToken) != len("xst_live_")+43 {
		t.Errorf("the transmittable half is %d characters", len(parsed.AuthToken))
	}
}

func TestMalformedTokensAreRefused(t *testing.T) {
	for description, token := range map[string]string{
		"empty":                            "",
		"no prefix":                        authHalf,
		"a CLI token wearing the shape":    "xct_live_" + authHalf + "k" + keyHalf,
		"a session token":                  "xes_live_" + authHalf,
		"an unknown environment":           "xst_prod_" + authHalf,
		"no environment separator":         "xst_" + authHalf,
		"the wrong separator character":    "xst_live_" + authHalf + "x" + keyHalf,
		"an auth half one character short": "xst_live_" + authHalf[:42] + "k" + keyHalf,
		"a key half one character short":   "xst_live_" + authHalf + "k" + keyHalf[:42],
		"a third half":                     "xst_live_" + authHalf + "k" + keyHalf + "k" + keyHalf,
		"padding":                          "xst_live_" + strings.Repeat("A", 41) + "==",
		"outside the alphabet":             "xst_live_" + strings.Repeat("+", 43),
	} {
		if _, err := SplitServiceToken(token); !errors.Is(err, ErrNotServiceToken) {
			t.Errorf("accepted %s: %q (%v)", description, token, err)
		}
	}
}

func TestTheKeyHalfIsAUsableScalar(t *testing.T) {
	// X25519 clamps internally, so any 32 bytes are a valid scalar — which is
	// why the key half is the scalar directly and no HKDF branch was added to
	// the registry for it.
	parsed, err := SplitServiceToken("xst_live_" + authHalf + "k" + keyHalf)
	if err != nil {
		t.Fatal(err)
	}

	publicKey, err := EncryptionPublicKey(parsed.PrivateKey)
	if err != nil {
		t.Fatalf("the key half is not a usable X25519 scalar: %v", err)
	}

	aad, err := EDKGrantAad(testEnvID, 1, RecipientToken, testTokenID)
	if err != nil {
		t.Fatal(err)
	}

	edk := make([]byte, KeyBytes)
	if _, err := rand.Read(edk); err != nil {
		t.Fatal(err)
	}

	blob, err := SealToPublicKey(publicKey, edk, aad)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := OpenSealedBox(parsed.PrivateKey, blob, aad)
	if err != nil {
		t.Fatalf("a grant sealed to the token's own key did not open: %v", err)
	}
	if !bytes.Equal(opened, edk) {
		t.Error("the grant opened to the wrong key")
	}

	parsed.Zeroize()
	if !isAllZero(parsed.PrivateKey) {
		t.Error("Zeroize left the key half in memory")
	}
}

// TestTheHandoffWrapIsBoundToItsLogin (spec §13.2).
func TestTheHandoffWrapIsBoundToItsLogin(t *testing.T) {
	const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

	key, err := GenerateHandoffKey()
	if err != nil {
		t.Fatal(err)
	}
	defer key.Close()

	if len(key.PublicKeyB64Url) != 43 {
		t.Fatalf("a hand-off public key is 43 characters, got %d", len(key.PublicKeyB64Url))
	}

	userKey := make([]byte, KeyBytes)
	if _, err := rand.Read(userKey); err != nil {
		t.Fatal(err)
	}

	// The consent screen's half, done here with the same primitives.
	aad, err := CLIHandoffAad(challenge, key.PublicKeyB64Url)
	if err != nil {
		t.Fatal(err)
	}
	recipient, err := DecodePublicKey(key.PublicKeyB64Url)
	if err != nil {
		t.Fatal(err)
	}
	blob, err := SealToPublicKey(recipient, userKey, aad)
	if err != nil {
		t.Fatal(err)
	}

	opened, err := key.Open(blob, challenge)
	if err != nil {
		t.Fatalf("the hand-off did not open: %v", err)
	}
	if !bytes.Equal(opened, userKey) {
		t.Error("the hand-off opened to the wrong key")
	}

	// A wrap captured from one login must not replay into another. Both
	// components are load-bearing: the challenge names the authorization attempt,
	// the public key names the recipient.
	if _, err := key.Open(blob, "3Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cMX"); !errors.Is(err, ErrDecrypt) {
		t.Error("a hand-off opened under a different code challenge")
	}

	other, err := GenerateHandoffKey()
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err := other.Open(blob, challenge); !errors.Is(err, ErrDecrypt) {
		t.Error("a hand-off opened with another login's key")
	}

	// A plaintext that is not a User Key is refused rather than stored: a
	// keyring entry of the wrong length would fail much later, at a grant.
	short, err := SealToPublicKey(recipient, []byte("too short"), aad)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := key.Open(short, challenge); !errors.Is(err, ErrDecrypt) {
		t.Error("a hand-off carrying something other than a User Key was accepted")
	}
}

func TestHandoffAadRefusesComponentsItCannotEncode(t *testing.T) {
	// `|` is the delimiter, which is the whole reason the encoding needs no
	// length prefixes.
	if _, err := CLIHandoffAad("chal|lenge", "key"); err == nil {
		t.Error("a challenge containing the delimiter was accepted")
	}
	if _, err := CLIHandoffAad("challenge", ""); err == nil {
		t.Error("an empty hand-off key was accepted")
	}

	aad, err := CLIHandoffAad("challenge", "key")
	if err != nil {
		t.Fatal(err)
	}
	if aad != "xecret.aad.v2.cli-handoff|challenge|key" {
		t.Errorf("aad = %q", aad)
	}
	// It has to be admissible as an HKDF info string, or the sealed box refuses
	// it before any key is touched.
	if !isRegisteredInfo(aad) {
		t.Error("the hand-off AAD is not a registered info string")
	}
}
