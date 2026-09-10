package e2ee

import "testing"

// The fingerprint is a *comparison aid* between two screens — a terminal and a
// consent page — so the only property that matters is that both sides render
// the same eight characters for the same key. That makes this a cross-
// implementation test with one implementation missing, which is what the vector
// file is for everywhere else; here the vector is a single value, so it is
// written out.
//
// The input is the 32 bytes 0x00…0x1f, and `apps/web`'s `fingerprint()` in
// `components/envkeys/pins.ts` must produce the same string for it. If this test
// is ever changed, that one changes with it or the two products start disagreeing
// in front of a user who is trying to decide whether to trust a page.
const fingerprintVector = "CC6W-TAB6"

func countingKey() []byte {
	key := make([]byte, KeyBytes)
	for i := range key {
		key[i] = byte(i)
	}
	return key
}

func TestKeyFingerprintMatchesTheBrowsersFormat(t *testing.T) {
	got, err := KeyFingerprint(countingKey())
	if err != nil {
		t.Fatalf("KeyFingerprint: %v", err)
	}
	if got != fingerprintVector {
		t.Fatalf("fingerprint = %q, want %q — the CLI and the dashboard must render one key identically",
			got, fingerprintVector)
	}
}

func TestKeyFingerprintIsGroupedAndInTheProductsAlphabet(t *testing.T) {
	got, err := KeyFingerprint(countingKey())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 9 || got[4] != '-' {
		t.Fatalf("fingerprint = %q, want XXXX-XXXX", got)
	}
	for i, character := range got {
		if i == 4 {
			continue
		}
		if symbolValue(byte(character)) < 0 {
			t.Fatalf("%q is outside the Crockford alphabet, in %q", character, got)
		}
	}
}

func TestKeyFingerprintSeparatesKeys(t *testing.T) {
	first, err := KeyFingerprint(countingKey())
	if err != nil {
		t.Fatal(err)
	}

	other := countingKey()
	other[31] ^= 0x01
	second, err := KeyFingerprint(other)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("two different keys produced the same fingerprint")
	}
}

func TestKeyFingerprintRefusesSomethingThatIsNotAKey(t *testing.T) {
	if _, err := KeyFingerprint([]byte{1, 2, 3}); err == nil {
		t.Fatal("a short input must be refused rather than fingerprinted")
	}
}

// The hand-off pair renders through the same function, which is what makes the
// string `xecret login` prints comparable with the one the consent screen shows.
func TestHandoffKeyFingerprintsItsOwnPublicHalf(t *testing.T) {
	key, err := GenerateHandoffKey()
	if err != nil {
		t.Fatal(err)
	}
	defer key.Close()

	fromPair, err := key.Fingerprint()
	if err != nil {
		t.Fatalf("Fingerprint: %v", err)
	}

	decoded, err := DecodePublicKey(key.PublicKeyB64Url)
	if err != nil {
		t.Fatal(err)
	}
	fromWire, err := KeyFingerprint(decoded)
	if err != nil {
		t.Fatal(err)
	}

	// The public key in the authorize URL is the one being fingerprinted. A
	// fingerprint of anything else would compare against nothing.
	if fromPair != fromWire {
		t.Fatalf("pair = %q, URL parameter = %q", fromPair, fromWire)
	}
}
