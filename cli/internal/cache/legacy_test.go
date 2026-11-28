package cache

import (
	"errors"
	"os"
	"testing"
	"time"
)

// Organisation ids replaced slugs as the org in a scope. Everything a
// slug-keyed build filed (offline copies, and above all mode pins) has to
// keep being found, because a pin that an upgrade stops finding is the
// downgrade protection switching itself off with nobody told.

const acmeID = "0192f0a1-0000-7000-8000-00000000a001"

// slugScope is the scope as a slug-keyed build filed it.
func slugScope() Scope { return testScope() }

// idScope is the same scope as this build files it: by id, carrying the slug.
func idScope() Scope {
	scope := testScope()
	scope.Org = acmeID
	scope.LegacyOrgs = []string{"acme"}
	return scope
}

// The case the carry exists for. An `e2ee` pin a slug-keyed build recorded
// makes a later `server` answer under the id a refusal, not first contact.
func TestASlugKeyedE2eePinRefusesAServerAnswerUnderTheId(t *testing.T) {
	isolateHome(t)
	if err := PinMode(slugScope(), "e2ee"); err != nil {
		t.Fatal(err)
	}

	if got := PinnedMode(idScope()); got != "e2ee" {
		t.Fatalf("carried pin = %q, want e2ee", got)
	}
	if err := CheckMode(idScope(), "server"); !errors.Is(err, ErrModeDowngrade) {
		t.Fatalf("err = %v, want a downgrade refusal", err)
	}

	// Without the slug, the id alone has no record; which is exactly the
	// silent loss the carry prevents.
	bare := idScope()
	bare.LegacyOrgs = nil
	if got := PinnedMode(bare); got != "" {
		t.Fatalf("the id had a pin of its own before any was recorded: %q", got)
	}
}

// A carry takes the stricter answer and never the weaker one: a slug-keyed
// `server` pin leaves an `e2ee` pin under the id exactly as it is.
func TestACarryNeverDowngradesAnIdPin(t *testing.T) {
	isolateHome(t)
	bare := idScope()
	bare.LegacyOrgs = nil
	if err := PinMode(bare, "e2ee"); err != nil {
		t.Fatal(err)
	}
	if err := PinMode(slugScope(), "server"); err != nil {
		t.Fatal(err)
	}

	if got := PinnedMode(idScope()); got != "e2ee" {
		t.Fatalf("pinned = %q, want e2ee", got)
	}
	if err := CheckMode(idScope(), "server"); !errors.Is(err, ErrModeDowngrade) {
		t.Fatalf("err = %v, want a downgrade refusal", err)
	}
	// Recording the server answer through the carrying scope moves nothing
	// down, under either key.
	if err := PinMode(idScope(), "server"); err != nil {
		t.Fatal(err)
	}
	if got := PinnedMode(bare); got != "e2ee" {
		t.Fatalf("the id pin moved to %q", got)
	}
}

// Once carried, the pin is recorded under the id, so it no longer depends on
// this machine still knowing the slug; and it is recorded under the slug too,
// so a slug-keyed build run after a downgrade meets the pins this one learned.
func TestACarriedPinIsRecordedUnderTheIdAndTheSlug(t *testing.T) {
	isolateHome(t)
	if err := PinMode(slugScope(), "e2ee"); err != nil {
		t.Fatal(err)
	}
	if err := PinMode(idScope(), "server"); err != nil {
		t.Fatal(err)
	}

	bare := idScope()
	bare.LegacyOrgs = nil
	if got := PinnedMode(bare); got != "e2ee" {
		t.Fatalf("the carried pin was not recorded under the id: %q", got)
	}

	// The other direction: a pin first learned under the id reaches the slug.
	other := idScope()
	other.Environment = "production"
	if err := PinMode(other, "e2ee"); err != nil {
		t.Fatal(err)
	}
	asSlug := slugScope()
	asSlug.Environment = "production"
	if got := PinnedMode(asSlug); got != "e2ee" {
		t.Fatalf("a downgraded build would not see the pin: %q", got)
	}
}

// The migration direction still pins forward through a carry.
func TestASlugKeyedServerPinPermitsTheUpgrade(t *testing.T) {
	isolateHome(t)
	if err := PinMode(slugScope(), "server"); err != nil {
		t.Fatal(err)
	}
	if err := CheckMode(idScope(), "e2ee"); err != nil {
		t.Fatalf("upgrade refused: %v", err)
	}
	if err := PinMode(idScope(), "e2ee"); err != nil {
		t.Fatal(err)
	}
	if got := PinnedMode(idScope()); got != "e2ee" {
		t.Fatalf("pinned = %q", got)
	}
}

// A slug-keyed pin for another organisation, or another host, is not carried:
// only the slugs the scope names are consulted.
func TestOnlyTheScopesOwnSlugsAreCarried(t *testing.T) {
	isolateHome(t)
	elsewhere := slugScope()
	elsewhere.Org = "side"
	if err := PinMode(elsewhere, "e2ee"); err != nil {
		t.Fatal(err)
	}
	otherHost := slugScope()
	otherHost.Host = "https://other.example"
	if err := PinMode(otherHost, "e2ee"); err != nil {
		t.Fatal(err)
	}

	if err := CheckMode(idScope(), "server"); err != nil {
		t.Fatalf("a pin from another scope was carried: %v", err)
	}
}

// An offline copy filed under the slug is still read, under the AAD it was
// sealed with, in both of its forms.
func TestASlugKeyedOfflineCopyIsStillRead(t *testing.T) {
	isolateHome(t)
	store := memoryStore{}
	now := time.Now()

	if err := Write(store, slugScope(), map[string]string{"K": "from-the-slug"}, now); err != nil {
		t.Fatal(err)
	}
	entry, err := Read(store, idScope())
	if err != nil {
		t.Fatalf("the slug-keyed copy was not found: %v", err)
	}
	if entry.Secrets["K"] != "from-the-slug" {
		t.Fatalf("read %v", entry.Secrets)
	}

	encryptedSlug := slugScope()
	encryptedSlug.Encrypted = true
	if err := WriteBundle(store, encryptedSlug, []byte(`{"bundle":true}`), now); err != nil {
		t.Fatal(err)
	}
	encryptedID := idScope()
	encryptedID.Encrypted = true
	bundle, err := Read(store, encryptedID)
	if err != nil {
		t.Fatalf("the slug-keyed bundle was not found: %v", err)
	}
	if string(bundle.Bundle) != `{"bundle":true}` {
		t.Fatalf("read %s", bundle.Bundle)
	}
}

// The id's own copy wins, and writing it retires the slug-keyed one.
func TestTheIdsOwnCopyWinsAndReplacesTheSlugs(t *testing.T) {
	isolateHome(t)
	store := memoryStore{}
	now := time.Now()

	if err := Write(store, slugScope(), map[string]string{"K": "old"}, now); err != nil {
		t.Fatal(err)
	}
	if err := Write(store, idScope(), map[string]string{"K": "new"}, now); err != nil {
		t.Fatal(err)
	}

	entry, err := Read(store, idScope())
	if err != nil || entry.Secrets["K"] != "new" {
		t.Fatalf("read %v, %v; want the id's copy", entry, err)
	}
	if _, err := os.Stat(path(slugScope())); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the slug-keyed copy survived a write that replaced it: %v", err)
	}
}

// Forget removes a pre-migration plaintext copy wherever it was filed.
func TestForgetReachesTheSlugKeyedCopy(t *testing.T) {
	isolateHome(t)
	store := memoryStore{}
	if err := Write(store, slugScope(), map[string]string{"K": "pre-migration"}, time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := Forget(idScope()); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(store, idScope()); !errors.Is(err, ErrMiss) {
		t.Fatalf("the slug-keyed plaintext copy survived Forget: %v", err)
	}
}

// The fallback finds a file, it does not loosen what the file may be: a copy
// relocated into the slug's slot from another scope still fails verification.
func TestASlugKeyedCopyStillOpensOnlyUnderItsOwnAAD(t *testing.T) {
	isolateHome(t)
	store := memoryStore{}
	other := slugScope()
	other.Environment = "production"
	if err := Write(store, other, map[string]string{"K": "production-value"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path(other), path(slugScope())); err != nil {
		t.Fatal(err)
	}

	if _, err := Read(store, idScope()); err == nil || errors.Is(err, ErrMiss) {
		t.Fatalf("a relocated slug-keyed copy must fail verification, got %v", err)
	}
}
