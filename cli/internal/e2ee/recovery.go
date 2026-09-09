package e2ee

import (
	"crypto/sha256"
	"errors"
	"math/big"
	"strings"
)

// Recovery codes: the Crockford base32 codec, the Luhn mod-32 check character,
// the server's lookup hash, and the Recovery Code Key.
//
// The CLI has no flow that redeems a recovery code — redemption is single-use,
// invalidates the whole set of five, and belongs on the screen that can print
// the replacements. This is here because it is part of the specification the
// vectors enforce, and a Go implementation that skipped it would leave one of
// the nine vector kinds unchecked on this side. A construction that only one
// implementation has ever computed is a construction nobody has cross-checked.
//
// Spec §7.

// CrockfordAlphabet is 32 symbols, without I, L, O, or U.
const CrockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// RecoveryCodeBytes is 16 bytes with the top three bits cleared — a 125-bit
// value. Twenty-five base32 characters carry exactly 125 bits, and 25 is what
// the five-group display holds; padding to 26 would introduce two meaningless
// bits that two implementations could encode differently.
const RecoveryCodeBytes = 16

// RecoveryCodeDataChars is the number of data characters before the check.
const RecoveryCodeDataChars = 25

const domainRecoveryLookup = "xecret.v2.recovery-lookup"

// ErrRecoveryFormat means the string is not one of our codes at all.
var ErrRecoveryFormat = errors.New("that is not a valid code")

// ErrRecoveryChecksum means the code was mistyped.
//
// Distinguishing the two is safe precisely because the check character is a
// usability control and not a security one: knowing a guess had a valid check
// digit tells an attacker nothing about the 125 bits behind it. What it buys is
// "that code has a typo" instead of "invalid recovery code", which is the
// difference between a user retyping one character and a user concluding their
// Emergency Kit is worthless.
var ErrRecoveryChecksum = errors.New("that code has a typo — check it against your Emergency Kit")

// symbolValue is the zero-based index into the alphabet, or -1.
func symbolValue(character byte) int {
	return strings.IndexByte(CrockfordAlphabet, character)
}

// NormalizeCrockford forgives exactly what Crockford specifies and nothing else.
//
// In order: strip hyphens and whitespace, upper-case, then map I → 1, L → 1,
// O → 0. Anything left outside the alphabet — including U, which is excluded
// because it is confusable with V and which Crockford reserves for a mod-37
// check-symbol set this specification does not use — is a parse error. U is
// rejected rather than aliased: it has no meaning here at all.
func NormalizeCrockford(input string) string {
	var out strings.Builder
	out.Grow(len(input))
	for _, r := range strings.ToUpper(input) {
		switch {
		case r == '-' || r == ' ' || r == '\t' || r == '\n' || r == '\r' ||
			r == '\v' || r == '\f' || r == 0x85 || r == 0xa0:
			continue
		case r == 'I' || r == 'L':
			out.WriteByte('1')
		case r == 'O':
			out.WriteByte('0')
		default:
			out.WriteRune(r)
		}
	}
	return out.String()
}

// LuhnMod32 computes the check character over a run of data characters.
//
// Standard Luhn mod N at N = 32: it detects every single-character substitution
// and the large majority of adjacent transpositions.
func LuhnMod32(dataChars string) (string, error) {
	factor, sum := 2, 0
	for i := len(dataChars) - 1; i >= 0; i-- {
		value := symbolValue(dataChars[i])
		if value < 0 {
			return "", ErrRecoveryFormat
		}
		addend := factor * value
		if factor == 2 {
			factor = 1
		} else {
			factor = 2
		}
		sum += addend/32 + addend%32
	}
	return string(CrockfordAlphabet[(32-sum%32)%32]), nil
}

// encodeCrockford renders a big-endian byte string as exactly `characters`
// base32 symbols, left-padded with '0'.
func encodeCrockford(bytes []byte, characters int) (string, error) {
	value := new(big.Int).SetBytes(bytes)
	out := make([]byte, characters)
	mask := big.NewInt(31)
	digit := new(big.Int)
	for i := characters - 1; i >= 0; i-- {
		out[i] = CrockfordAlphabet[digit.And(value, mask).Int64()]
		value.Rsh(value, 5)
	}
	if value.Sign() != 0 {
		return "", errors.New("value does not fit in the requested number of characters")
	}
	return string(out), nil
}

// decodeCrockford reads base32 symbols back into exactly byteLength bytes.
func decodeCrockford(dataChars string, byteLength int) ([]byte, error) {
	value := new(big.Int)
	for i := 0; i < len(dataChars); i++ {
		symbol := symbolValue(dataChars[i])
		if symbol < 0 {
			return nil, ErrRecoveryFormat
		}
		value.Lsh(value, 5).Or(value, big.NewInt(int64(symbol)))
	}

	out := value.FillBytes(make([]byte, byteLength))
	// FillBytes panics rather than truncating when the value is too large, so
	// the width is checked first: accepting a truncation would read two
	// different strings as one code.
	if value.BitLen() > byteLength*8 {
		return nil, ErrRecoveryFormat
	}
	return out, nil
}

// RecoveryCode is a code in every form the rest of the system needs it.
type RecoveryCode struct {
	// CodeBytes is the canonical 16 bytes: the top three bits of byte 0 are zero.
	CodeBytes []byte
	// DataChars is the 25 data characters, no hyphens.
	DataChars string
	// CheckChar is the Luhn mod-32 check character.
	CheckChar string
	// DisplayForm is XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-C, the only form a UI renders.
	DisplayForm string
}

// groupRecoveryCode renders five groups of five, then the check character in a
// group of its own — on purpose: it is not part of the secret, and a user
// comparing two codes should be able to see where the entropy stops.
func groupRecoveryCode(dataChars, checkChar string) string {
	groups := make([]string, 0, 6)
	for i := 0; i < len(dataChars); i += 5 {
		groups = append(groups, dataChars[i:i+5])
	}
	return strings.Join(append(groups, checkChar), "-")
}

// EncodeRecoveryCode renders a recovery code from its canonical bytes.
func EncodeRecoveryCode(codeBytes []byte) (RecoveryCode, error) {
	if len(codeBytes) != RecoveryCodeBytes {
		return RecoveryCode{}, errors.New("a recovery code is 16 bytes")
	}
	if codeBytes[0]&0xe0 != 0 {
		return RecoveryCode{}, errors.New("the top three bits of a recovery code must be zero")
	}

	dataChars, err := encodeCrockford(codeBytes, RecoveryCodeDataChars)
	if err != nil {
		return RecoveryCode{}, err
	}
	checkChar, err := LuhnMod32(dataChars)
	if err != nil {
		return RecoveryCode{}, err
	}
	return RecoveryCode{
		CodeBytes:   codeBytes,
		DataChars:   dataChars,
		CheckChar:   checkChar,
		DisplayForm: groupRecoveryCode(dataChars, checkChar),
	}, nil
}

// ParseRecoveryCode reads a code a user typed.
//
// Accepts lower case, missing or extra hyphens, and the I/L/O confusables,
// because those are what a human copying 26 characters off paper actually
// produces. Rejects everything else, U included.
func ParseRecoveryCode(input string) (RecoveryCode, error) {
	normalized := NormalizeCrockford(input)
	if len(normalized) != RecoveryCodeDataChars+1 {
		return RecoveryCode{}, ErrRecoveryFormat
	}

	dataChars := normalized[:RecoveryCodeDataChars]
	checkChar := normalized[RecoveryCodeDataChars:]

	expected, err := LuhnMod32(dataChars)
	if err != nil {
		return RecoveryCode{}, err
	}
	if symbolValue(checkChar[0]) < 0 {
		return RecoveryCode{}, ErrRecoveryFormat
	}
	if expected != checkChar {
		return RecoveryCode{}, ErrRecoveryChecksum
	}

	codeBytes, err := decodeCrockford(dataChars, RecoveryCodeBytes)
	if err != nil {
		return RecoveryCode{}, err
	}
	return RecoveryCode{
		CodeBytes:   codeBytes,
		DataChars:   dataChars,
		CheckChar:   checkChar,
		DisplayForm: groupRecoveryCode(dataChars, checkChar),
	}, nil
}

// RecoveryLookupHash is the server's lookup value for one code.
//
// A fast hash is correct here, for the same reason token hashes are plain
// SHA-256: the input is a 125-bit uniformly random value with no structure to
// attack, so a slow KDF buys nothing and the lookup stays a single indexed
// query. The domain-separation prefix ensures this digest can never collide with
// another SHA-256 use over the same bytes.
func RecoveryLookupHash(codeBytes []byte) ([]byte, error) {
	if len(codeBytes) != RecoveryCodeBytes {
		return nil, errors.New("a recovery code is 16 bytes")
	}
	digest := sha256.Sum256(append([]byte(domainRecoveryLookup), codeBytes...))
	return digest[:], nil
}

// DeriveRecoveryKey derives the Recovery Code Key that unwraps this code's User
// Key wrap.
//
// Argon2 is deliberately not used: the input is 125 bits of uniform randomness,
// not a passphrase, and a memory-hard KDF over it would cost the user a second
// and an attacker nothing.
func DeriveRecoveryKey(codeBytes []byte) ([]byte, error) {
	if len(codeBytes) != RecoveryCodeBytes {
		return nil, errors.New("a recovery code is 16 bytes")
	}
	return deriveKey(codeBytes, nil, InfoRecoveryWrap)
}
