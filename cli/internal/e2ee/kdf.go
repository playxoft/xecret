package e2ee

import (
	"encoding/json"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
)

// Argon2id: master passphrase → Stretched Key (SK).
//
// SK never leaves the client and is not itself a key. It is HKDF input keying
// material for exactly two branches — the User Key wrap key and the unlock
// verifier — and MUST NOT encrypt anything directly (spec §3.1).

// Argon2Version is the version byte, 0x13. Nothing else is accepted.
const Argon2Version = 19

// KDFSaltBytes is 16 bytes, random per user, stored in plaintext beside the wrap.
const KDFSaltBytes = 16

// Argon2idParams is the object stored in user_keys.kdfParams, with exactly
// these keys.
//
// M is in KiB, matching the RFC 9106 reference convention — the single most
// common place two Argon2 implementations disagree by a factor of 1024.
type Argon2idParams struct {
	Alg string `json:"alg"`
	V   int    `json:"v"`
	M   int    `json:"m"`
	T   int    `json:"t"`
	P   int    `json:"p"`
	Len int    `json:"len"`
}

// CurrentKDFParams is what new records are written with (spec §3.1).
var CurrentKDFParams = Argon2idParams{Alg: "argon2id", V: Argon2Version, M: 65_536, T: 3, P: 1, Len: 32}

// Accepted ranges. The lower bound on M is the OWASP 2025 floor; a record below
// it is either corrupt or hostile, and refusing is correct either way.
const (
	minMemoryKiB = 19_456
	maxMemoryKiB = 1_048_576
	minTime      = 1
	maxTime      = 10
)

// ParseKdfParams validates stored parameters and returns them narrowed.
//
// This is a security control, not a sanity check. kdfParams arrives from the
// server, and a client that runs a memory-hard KDF with unvalidated
// server-supplied cost parameters can be made to allocate arbitrary memory by a
// hostile or compromised server. It is mandatory before [DeriveStretchedKey] and
// is not optional anywhere.
//
// Unknown keys are rejected along with out-of-range values: the stored object is
// specified as having exactly six fields, and a seventh is a record this client
// does not understand well enough to run a KDF from.
func ParseKdfParams(raw json.RawMessage) (Argon2idParams, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return Argon2idParams{}, fmt.Errorf("kdfParams must be an object: %w", err)
	}
	for key := range fields {
		switch key {
		case "alg", "v", "m", "t", "p", "len":
		default:
			return Argon2idParams{}, fmt.Errorf("kdfParams carries a field this client does not understand")
		}
	}

	var params Argon2idParams
	if err := json.Unmarshal(raw, &params); err != nil {
		return Argon2idParams{}, fmt.Errorf("kdfParams is not the shape this client understands: %w", err)
	}

	if params.Alg != "argon2id" {
		// Argon2i and Argon2d are different functions; accepting either would
		// derive a different key from the same passphrase.
		return Argon2idParams{}, fmt.Errorf(`kdfParams.alg must be "argon2id"`)
	}
	if params.V != Argon2Version {
		return Argon2idParams{}, fmt.Errorf("kdfParams.v must be %d", Argon2Version)
	}
	if params.M < minMemoryKiB || params.M > maxMemoryKiB {
		return Argon2idParams{}, fmt.Errorf("kdfParams.m is outside the accepted range")
	}
	if params.T < minTime || params.T > maxTime {
		return Argon2idParams{}, fmt.Errorf("kdfParams.t is outside the accepted range")
	}
	if params.P != 1 {
		// Browsers run this single-threaded, and the two implementations must
		// agree. A record asking for more lanes was not written by a client of
		// this system.
		return Argon2idParams{}, fmt.Errorf("kdfParams.p must be 1")
	}
	if params.Len != 32 {
		return Argon2idParams{}, fmt.Errorf("kdfParams.len must be 32")
	}
	return params, nil
}

// DecodeSalt reads the 16-byte KDF salt as it travels: unpadded base64url,
// stored in plaintext beside the wrap because it is not a secret and never was.
func DecodeSalt(value string) ([]byte, error) {
	salt, err := b64url.DecodeString(value)
	if err != nil {
		return nil, errors.New("kdfSalt is not valid unpadded base64url")
	}
	if len(salt) != KDFSaltBytes {
		return nil, fmt.Errorf("kdfSalt must be %d bytes", KDFSaltBytes)
	}
	return salt, nil
}

// KdfNeedsUpgrade reports whether a stored record should be re-derived at the
// current parameters.
//
// A difference in *any* field, not merely a lower cost: an upgrade must also be
// able to lower a parameter that was set to a value some platform cannot reach.
func KdfNeedsUpgrade(params Argon2idParams) bool { return params != CurrentKDFParams }

// argon2id is the primitive with no policy attached — the seam the vector
// generator reaches, at parameters deliberately below the production floor.
// [DeriveStretchedKey] is where the bounds are enforced.
func argon2id(password, salt []byte, params Argon2idParams) []byte {
	return argon2.IDKey(password, salt, uint32(params.T), uint32(params.M), uint8(params.P), uint32(params.Len))
}

// DeriveStretchedKey derives SK from a master passphrase.
//
// The passphrase is NFC-normalised before encoding, without exception: the same
// passphrase typed on macOS and on Windows must derive the same key, and it does
// not unless both sides normalise. params arrives as stored, so the record
// straight off the wire is the natural thing to pass; it is validated here even
// if the caller validated it too.
func DeriveStretchedKey(passphrase string, salt []byte, params json.RawMessage) ([]byte, error) {
	kdfParams, err := ParseKdfParams(params)
	if err != nil {
		return nil, err
	}
	if len(salt) != KDFSaltBytes {
		return nil, fmt.Errorf("kdfSalt must be %d bytes", KDFSaltBytes)
	}

	// The passphrase bytes are the most valuable material in the system; they do
	// not need to outlive this call. The original string is still in the
	// caller's hands, and Go strings cannot be wiped.
	password := normalizedUTF8(passphrase)
	defer zeroize(password)

	return argon2id(password, salt, kdfParams), nil
}
