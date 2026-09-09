package e2ee

import (
	"errors"
	"strings"
)

// The service token's two halves (spec §13.1).
//
//	xst_<live|test>_<43 chars>k<43 chars>
//
// A service token is the only principal that holds an environment's keys with no
// person behind it, so it carries its own X25519 private scalar. There is
// nowhere else to put it: a CI runner has no vault and no passphrase, and a key
// it would have to fetch is a key the server could withhold or substitute.

const (
	serviceTokenPrefix = "xst_"
	// tokenSecretChars is unpadded base64url of 32 bytes.
	tokenSecretChars = 43
	// serviceKeySeparator sits at a fixed offset. See SplitServiceToken.
	serviceKeySeparator = 'k'
)

// ErrNotServiceToken means the string is not a service token of either shape.
var ErrNotServiceToken = errors.New("not a service token")

// ServiceToken is a token taken apart into the half that travels and the half
// that must not.
type ServiceToken struct {
	// AuthToken is the complete transmittable credential, prefix included. It is
	// what goes in an Authorization header and what the server hashes — and it
	// is the *only* half any request may ever carry.
	AuthToken string
	// PrivateKey is the token's 32-byte X25519 scalar, or nil for a legacy
	// single-half token. It never leaves this process.
	PrivateKey []byte
}

// SplitServiceToken parses a service token.
//
// The separator is read at a **fixed offset**, never searched for. `k` is a
// member of the base64url alphabet, so both halves routinely contain one and
// strings.IndexByte would split about half of all tokens in the wrong place —
// producing an auth half that never authenticates and a key half that opens
// nothing, with no error to explain either.
//
// A legacy token — no separator, one half — parses successfully with a nil
// PrivateKey. That is not a degraded read: it is every token minted before this
// format and every token for a server-mode environment, and it authenticates
// exactly as it always did.
func SplitServiceToken(token string) (ServiceToken, error) {
	if !strings.HasPrefix(token, serviceTokenPrefix) {
		return ServiceToken{}, ErrNotServiceToken
	}

	// Past the prefix, split on the environment's underscore only. The base64url
	// alphabet includes `_`, so splitting the whole string would break roughly
	// half of all valid tokens.
	rest := token[len(serviceTokenPrefix):]
	separator := strings.IndexByte(rest, '_')
	if separator < 0 {
		return ServiceToken{}, ErrNotServiceToken
	}

	environment := rest[:separator]
	if environment != "live" && environment != "test" {
		return ServiceToken{}, ErrNotServiceToken
	}
	secret := rest[separator+1:]

	switch len(secret) {
	case tokenSecretChars:
		if !isTokenHalf(secret) {
			return ServiceToken{}, ErrNotServiceToken
		}
		return ServiceToken{AuthToken: token}, nil

	case tokenSecretChars + 1 + tokenSecretChars:
		if secret[tokenSecretChars] != serviceKeySeparator {
			return ServiceToken{}, ErrNotServiceToken
		}
		authHalf, keyHalf := secret[:tokenSecretChars], secret[tokenSecretChars+1:]
		if !isTokenHalf(authHalf) || !isTokenHalf(keyHalf) {
			return ServiceToken{}, ErrNotServiceToken
		}

		privateKey, err := b64url.DecodeString(keyHalf)
		if err != nil {
			return ServiceToken{}, ErrNotServiceToken
		}
		head := token[:len(token)-len(secret)]
		return ServiceToken{AuthToken: head + authHalf, PrivateKey: privateKey}, nil
	}

	return ServiceToken{}, ErrNotServiceToken
}

// isTokenHalf reports whether a segment is 32 bytes of unpadded base64url.
func isTokenHalf(segment string) bool {
	if len(segment) != tokenSecretChars {
		return false
	}
	decoded, err := b64url.DecodeString(segment)
	return err == nil && len(decoded) == KeyBytes
}

// Zeroize wipes the key half once a command is done with it.
func (t ServiceToken) Zeroize() { zeroize(t.PrivateKey) }
