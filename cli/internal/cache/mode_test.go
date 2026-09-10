package cache

import (
	"errors"
	"strings"
	"testing"
)

// Mode continuity. The transition that matters is exactly one — a pinned `e2ee`
// answering `server` — because that is the one where a client that believes the
// answer starts sending values in plaintext.

func TestFirstContactPinsAndPermits(t *testing.T) {
	isolateHome(t)

	if err := CheckMode(testScope(), "e2ee"); err != nil {
		t.Fatalf("first contact refused: %v", err)
	}
	if err := PinMode(testScope(), "e2ee"); err != nil {
		t.Fatal(err)
	}
	if got := PinnedMode(testScope()); got != "e2ee" {
		t.Fatalf("pinned = %q", got)
	}
}

func TestDowngradeIsRefusedAndSaysWhatToDo(t *testing.T) {
	isolateHome(t)
	if err := PinMode(testScope(), "e2ee"); err != nil {
		t.Fatal(err)
	}

	err := CheckMode(testScope(), "server")
	if !errors.Is(err, ErrModeDowngrade) {
		t.Fatalf("err = %v, want a downgrade refusal", err)
	}
	// The remedy is named, and so is the reason not to reach for it — the whole
	// point is that a person, not this program, decides which case this is.
	if !strings.Contains(err.Error(), "xecret cache clear") {
		t.Fatalf("error does not name the remedy: %v", err)
	}
	if !strings.Contains(err.Error(), "dev") {
		t.Fatalf("error does not name the environment: %v", err)
	}
}

// The migration direction. It takes capability away from the server, so it pins
// forward rather than being refused.
func TestUpgradeIsPermittedAndReplacesThePin(t *testing.T) {
	isolateHome(t)
	if err := PinMode(testScope(), "server"); err != nil {
		t.Fatal(err)
	}

	if err := CheckMode(testScope(), "e2ee"); err != nil {
		t.Fatalf("upgrade refused: %v", err)
	}
	if err := PinMode(testScope(), "e2ee"); err != nil {
		t.Fatal(err)
	}
	if got := PinnedMode(testScope()); got != "e2ee" {
		t.Fatalf("pinned = %q, want the upgrade to have replaced it", got)
	}
}

// An `e2ee` pin is never walked back by a write, only by `cache clear`. A
// PinMode that could do it would be the same hole this closes, reached from the
// other side.
func TestPinNeverMovesDownward(t *testing.T) {
	isolateHome(t)
	if err := PinMode(testScope(), "e2ee"); err != nil {
		t.Fatal(err)
	}
	if err := PinMode(testScope(), "server"); err != nil {
		t.Fatal(err)
	}
	if got := PinnedMode(testScope()); got != "e2ee" {
		t.Fatalf("pinned = %q, want e2ee", got)
	}
}

// Two environments in one project are two pins. A shared one would refuse a
// legitimately server-mode environment because a sibling is encrypted.
func TestPinsAreScopedPerEnvironment(t *testing.T) {
	isolateHome(t)

	other := testScope()
	other.Environment = "production"

	if err := PinMode(testScope(), "e2ee"); err != nil {
		t.Fatal(err)
	}
	if err := CheckMode(other, "server"); err != nil {
		t.Fatalf("a sibling environment was refused: %v", err)
	}
}

// The plaintext and encrypted forms of one environment are one environment. The
// cache files are deliberately filed apart — see `aad` — and a pin that
// inherited that split would be recorded under one key and read under the other,
// which is a pin that never matches anything.
func TestPinIgnoresTheEncryptedFlag(t *testing.T) {
	isolateHome(t)

	encrypted := testScope()
	encrypted.Encrypted = true

	if err := PinMode(encrypted, "e2ee"); err != nil {
		t.Fatal(err)
	}
	if err := CheckMode(testScope(), "server"); !errors.Is(err, ErrModeDowngrade) {
		t.Fatalf("err = %v, want a downgrade refusal", err)
	}
}

func TestClearForgetsThePins(t *testing.T) {
	isolateHome(t)
	if err := PinMode(testScope(), "e2ee"); err != nil {
		t.Fatal(err)
	}
	if err := Clear(memoryStore{keyStoreEntry: "x"}); err != nil {
		t.Fatal(err)
	}
	if got := PinnedMode(testScope()); got != "" {
		t.Fatalf("pinned = %q after a clear", got)
	}
}
