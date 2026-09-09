package e2ee

import "strings"

// BlobVersion is the one version this package reads and writes.
const BlobVersion = "xk2"

// Algorithm is an xk2 algorithm tag. It names the *construction*, not the
// purpose — purpose is carried by the AAD and by the column the blob lives in,
// so a blob moved to the wrong column fails to decrypt because its AAD no longer
// matches (spec §2.1).
type Algorithm string

const (
	// AlgGCM is AES-256-GCM under a key the reader already holds:
	// iv(12) ‖ ciphertext‖tag.
	AlgGCM Algorithm = "gcm"
	// AlgX25519 is a sealed box: ephemeralPub(32) ‖ iv(12) ‖ ciphertext‖tag.
	AlgX25519 Algorithm = "x25519"
	// AlgEd25519 is a detached signature: signature(64).
	AlgEd25519 Algorithm = "ed25519"
)

// ivLength is 12 bytes, for every AES-256-GCM construction in the spec.
const ivLength = 12

// gcmTagLength is the 128-bit tag, appended to the ciphertext as Web Crypto does.
const gcmTagLength = 16

// minPayload is the smallest conforming payload per algorithm: an empty
// plaintext for the two AEAD forms, and the exact signature length for ed25519.
var minPayload = map[Algorithm]int{
	AlgGCM:     ivLength + gcmTagLength,
	AlgX25519:  PublicKeyBytes + ivLength + gcmTagLength,
	AlgEd25519: SignatureBytes,
}

// exactPayload pins the algorithms whose payload has one legal length.
var exactPayload = map[Algorithm]int{AlgEd25519: SignatureBytes}

// FormatBlob renders xk2.<algo>.<b64url payload>.
func FormatBlob(algorithm Algorithm, payload []byte) (string, error) {
	minimum, known := minPayload[algorithm]
	if !known {
		return "", formatErr("unknown algorithm tag")
	}
	if len(payload) < minimum {
		return "", formatErr("payload is shorter than its algorithm allows")
	}
	return BlobVersion + "." + string(algorithm) + "." + b64url.EncodeToString(payload), nil
}

// ParseBlob splits a blob and returns its payload, requiring a specific
// algorithm.
//
// The caller always knows which construction it expects — the column it read
// from says so — and passing it in means a gcm blob presented where a sealed box
// belongs is rejected at the format layer rather than producing a confusing
// decryption failure.
//
// Everything unrecognised is refused, loudly: an unknown version, an unknown
// tag, a short payload, invalid base64url. A blob written by a future version
// must fail to parse rather than be misread as this one, because the
// alternative is a silent misinterpretation of key material (spec §2).
func ParseBlob(blob string, expected Algorithm) ([]byte, error) {
	// Neither the version nor the algorithm tag can contain a dot and the
	// base64url alphabet excludes it, so three fields split unambiguously
	// without escaping or length prefixes.
	parts := strings.Split(blob, ".")
	if len(parts) != 3 {
		return nil, formatErr("must have the form xk2.<algorithm>.<payload>")
	}
	if parts[0] != BlobVersion {
		return nil, formatErr("unsupported version")
	}

	tag := Algorithm(parts[1])
	minimum, known := minPayload[tag]
	if !known {
		return nil, formatErr("unsupported algorithm tag")
	}
	if tag != expected {
		return nil, formatErr("algorithm is not the one expected here")
	}

	payload, err := b64url.DecodeString(parts[2])
	if err != nil {
		return nil, formatErr("payload is not valid unpadded base64url")
	}
	if exact, pinned := exactPayload[tag]; pinned && len(payload) != exact {
		return nil, formatErr("payload is not the required length")
	}
	if len(payload) < minimum {
		return nil, formatErr("payload is shorter than its algorithm allows")
	}
	return payload, nil
}

// formatGCMBlob renders xk2.gcm.<b64url(iv ‖ ciphertext‖tag)>.
func formatGCMBlob(iv, ciphertext []byte) (string, error) {
	if len(iv) != ivLength {
		return "", formatErr("an AES-GCM blob carries a 12-byte IV")
	}
	payload := make([]byte, 0, len(iv)+len(ciphertext))
	payload = append(payload, iv...)
	payload = append(payload, ciphertext...)
	return FormatBlob(AlgGCM, payload)
}

// parseGCMBlob splits an xk2.gcm. blob back into its IV and ciphertext.
func parseGCMBlob(blob string) (iv, ciphertext []byte, err error) {
	payload, err := ParseBlob(blob, AlgGCM)
	if err != nil {
		return nil, nil, err
	}
	return payload[:ivLength], payload[ivLength:], nil
}
