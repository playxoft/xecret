// Package auth implements the CLI half of `xecret login`: PKCE, the loopback
// listener, and opening the browser.
//
// The shape is RFC 8252 (OAuth for native apps) against xecret's own server —
// never Firebase directly. The CLI holds the PKCE verifier in memory, the
// consent screen mints a one-time code, and the exchange requires both. The
// resulting token is the credential; the code and verifier are worthless the
// moment the flow ends.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
)

// GenerateVerifier returns a fresh PKCE code verifier: 32 random bytes as
// base64url, which is 43 characters — the RFC 7636 minimum, carrying 256 bits
// of entropy. Longer adds nothing.
func GenerateVerifier() (string, error) {
	return randomToken()
}

// Challenge derives the S256 code challenge for a verifier (RFC 7636 §4.2).
func Challenge(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

// GenerateState returns the opaque value that ties the browser's callback to
// this process, so a stray request to the loopback port cannot complete
// somebody else's login.
func GenerateState() (string, error) {
	return randomToken()
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
