package e2ee

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"

	"golang.org/x/text/unicode/norm"
)

// ErrFormat marks a value that is not the shape this version understands: an
// unknown blob version, an unknown algorithm tag, a payload below its minimum,
// a payload that is not unpadded base64url.
//
// Kept distinct from [ErrDecrypt] on purpose, and the line between them is
// narrow. This one is a fact about a string the caller already holds and is
// derivable by reading spec §2, so it may say which fact. Anything that depends
// on key material must not.
var ErrFormat = errors.New("malformed xk2 blob")

// ErrDecrypt is every failure that depends on key material — the wrong key, the
// wrong AAD, a flipped bit, a forged tag, an ephemeral key yielding an all-zero
// shared secret. One indistinguishable error carrying no detail, because
// distinguishing them tells an attacker probing the API which part of their
// guess was wrong (spec §5.2).
var ErrDecrypt = errors.New("decryption failed")

// formatErr builds an [ErrFormat] with a reason, never with the offending
// value: blobs are key material and error messages reach logs.
func formatErr(reason string) error {
	return fmt.Errorf("%w: %s", ErrFormat, reason)
}

// b64url is RFC 4648 §5 without padding — the one encoding a blob payload
// travels in. Strict decoding rejects padding characters and anything outside
// [A-Za-z0-9_-], which is what spec §1.2 requires of a decoder.
var b64url = base64.RawURLEncoding.Strict()

// u32be renders n as four big-endian bytes: the length prefix of spec §6.1.
func u32be(n uint32) []byte {
	out := make([]byte, 4)
	binary.BigEndian.PutUint32(out, n)
	return out
}

// lengthPrefixed is lp(x) = u32be(len(x)) ‖ x.
//
// Applied to fixed-width fields as well as variable-length ones. Prefixing only
// the variable ones would require both implementations to agree on which fields
// are fixed, and that agreement holds right up until someone changes a UUID
// representation. Four redundant bytes per field remove the question.
func lengthPrefixed(value []byte) []byte {
	out := make([]byte, 0, 4+len(value))
	out = append(out, u32be(uint32(len(value)))...)
	return append(out, value...)
}

// normalizedUTF8 is the only form text enters a KDF or an AEAD in (spec §1.3).
//
// A passphrase containing é is two code points on macOS and one on Windows;
// without this the same passphrase typed on two machines derives two different
// keys, and the second machine reports "wrong passphrase" forever.
func normalizedUTF8(value string) []byte {
	return []byte(norm.NFC.String(value))
}

// zeroize overwrites key material once it is no longer needed. As spec §1.1
// says, this narrows the window in which a heap snapshot yields a usable key; it
// does not close it, and it is not a control to rely on.
func zeroize(buffers ...[]byte) {
	for _, buffer := range buffers {
		for i := range buffer {
			buffer[i] = 0
		}
	}
}

// ZeroizeKey is [zeroize] for callers outside this package: a command holding a
// User Key wants the same wipe on its way out.
func ZeroizeKey(buffers ...[]byte) { zeroize(buffers...) }

// isAllZero reports whether every byte is zero, without an early exit.
func isAllZero(value []byte) bool {
	var difference byte
	for _, b := range value {
		difference |= b
	}
	return difference == 0
}
