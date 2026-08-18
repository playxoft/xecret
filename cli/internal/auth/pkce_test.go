package auth

import (
	"regexp"
	"testing"
)

var base64url43 = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func TestGenerateVerifierShape(t *testing.T) {
	verifier, err := GenerateVerifier()
	if err != nil {
		t.Fatal(err)
	}
	if !base64url43.MatchString(verifier) {
		t.Errorf("verifier %q is not 43 base64url characters", verifier)
	}
}

func TestGenerateVerifierIsUnique(t *testing.T) {
	a, _ := GenerateVerifier()
	b, _ := GenerateVerifier()
	if a == b {
		t.Fatal("two verifiers were identical — the randomness source is broken")
	}
}

// TestChallengeMatchesRFCVector pins the S256 derivation to the worked
// example in RFC 7636 appendix B. If this fails, the server (which computes
// the same digest) would reject every login.
func TestChallengeMatchesRFCVector(t *testing.T) {
	const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	const want = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

	if got := Challenge(verifier); got != want {
		t.Errorf("Challenge(%q) = %q, want %q", verifier, got, want)
	}
}

func TestChallengeHasNoPadding(t *testing.T) {
	verifier, _ := GenerateVerifier()
	if !base64url43.MatchString(Challenge(verifier)) {
		t.Error("challenge must be exactly 43 unpadded base64url characters")
	}
}
