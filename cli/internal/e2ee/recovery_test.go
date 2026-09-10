package e2ee

import (
	"errors"
	"strings"
	"testing"
)

// unicodeSpaces is every character both implementations must strip from a typed
// code.
//
// The spec says "all hyphens and Unicode whitespace", and the two sides have to
// mean the same thing by it or a kit that parses in the browser fails in the
// CLI. The set is Unicode's White_Space property plus U+FEFF, and neither
// platform's own primitive covers it on its own: unicode.IsSpace matches U+0085
// but not U+FEFF, JavaScript's \s matches U+FEFF but not U+0085. Each side adds
// the one its primitive misses, which is why this list is mirrored character for
// character in packages/core/src/crypto/client/recovery.test.ts.
//
// U+2007 earns its place by being the one a printed kit is likeliest to carry —
// a figure space is what a typesetter puts between digit groups — and by being
// invisible to whoever pastes it.
var unicodeSpaces = []rune{
	'\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020',
	'\u0085', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002',
	'\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008',
	'\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f',
	'\u3000', '\ufeff',
}

// TestNormalizeCrockfordStripsEveryUnicodeSpace is the parity half of §7.1, and
// the reason it is worth a test of its own: a recovery code is printed by one
// implementation and typed into whichever the user reaches for on the day they
// need it. A character one side strips and the other keeps is a code that looks
// right on the sheet and is refused by the client in front of them.
func TestNormalizeCrockfordStripsEveryUnicodeSpace(t *testing.T) {
	for _, space := range unicodeSpaces {
		if got := NormalizeCrockford("ab" + string(space) + "cd"); got != "ABCD" {
			t.Errorf("U+%04X survived normalisation: %q", space, got)
		}

		padded := string(space) + "ab" + string(space) + string(space) +
			"-" + string(space) + "cd" + string(space)
		if got := NormalizeCrockford(padded); got != "ABCD" {
			t.Errorf("U+%04X survived normalisation in bulk: %q", space, got)
		}
	}
}

// TestParseRecoveryCodeAcceptsPastedSpaces covers the three the review named,
// two of which used to fail on exactly one of the two implementations.
func TestParseRecoveryCodeAcceptsPastedSpaces(t *testing.T) {
	code, err := EncodeRecoveryCode([]byte{
		0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
	})
	if err != nil {
		t.Fatalf("EncodeRecoveryCode: %v", err)
	}

	for _, space := range []rune{'\u2007', '\u0085', '\ufeff'} {
		spaced := strings.ReplaceAll(code.DisplayForm, "-", string(space))

		parsed, err := ParseRecoveryCode(spaced)
		if err != nil {
			t.Errorf("U+%04X between groups: %v", space, err)
			continue
		}
		if parsed.DisplayForm != code.DisplayForm {
			t.Errorf("U+%04X between groups: got %q, want %q",
				space, parsed.DisplayForm, code.DisplayForm)
		}
	}
}

// TestNormalizeCrockfordKeepsU is the other half of §7.1. U is excluded because
// it is confusable with V, and Crockford reserves it for a mod-37 check-symbol
// set this specification does not use, so it is left alone to fail as a symbol
// later rather than aliased to something that has a meaning.
func TestNormalizeCrockfordKeepsU(t *testing.T) {
	if got := NormalizeCrockford("u"); got != "U" {
		t.Errorf("NormalizeCrockford(%q) = %q, want %q", "u", got, "U")
	}
	if got := NormalizeCrockford("iIlLoO"); got != "111100" {
		t.Errorf("confusable aliasing: got %q, want %q", got, "111100")
	}
}

// TestDecodeCrockfordRefusesAnOversizedValue is the width check, which used to
// sit behind a panic.
//
// big.Int.FillBytes panics rather than truncating when the value does not fit,
// so calling it before the check meant the clean error was unreachable — the
// comment above it described an ordering the code did not have. No recovery code
// can reach it today, since 25 symbols carry 125 bits into 16 bytes, but the
// helper is the shared decoder and the next caller to hand it a wider string
// deserves an error rather than a crashed process.
func TestDecodeCrockfordRefusesAnOversizedValue(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("decodeCrockford panicked instead of erroring: %v", recovered)
		}
	}()

	// 26 'Z's is 130 one-bits, which does not fit 16 bytes.
	if _, err := decodeCrockford(strings.Repeat("Z", 26), RecoveryCodeBytes); !errors.Is(err, ErrRecoveryFormat) {
		t.Errorf("decodeCrockford(26 symbols): want ErrRecoveryFormat, got %v", err)
	}

	// One byte narrower, so even a 25-symbol value overflows: the check rejects
	// what does not fit and not merely what is long.
	if _, err := decodeCrockford(strings.Repeat("Z", 25), 15); !errors.Is(err, ErrRecoveryFormat) {
		t.Errorf("decodeCrockford(125 bits into 15 bytes): want ErrRecoveryFormat, got %v", err)
	}

	// The boundary still decodes.
	out, err := decodeCrockford(strings.Repeat("Z", 25), RecoveryCodeBytes)
	if err != nil {
		t.Fatalf("decodeCrockford(25 symbols): %v", err)
	}
	if len(out) != RecoveryCodeBytes || out[0] != 0x1f {
		t.Errorf("decodeCrockford(25 symbols) = %x", out)
	}
}
