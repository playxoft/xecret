package cred

import (
	"errors"
	"strings"
	"testing"

	"github.com/playxoft/xecret/cli/internal/keyring"
)

type memoryStore map[string]string

func (m memoryStore) Set(key, value string) error { m[key] = value; return nil }
func (m memoryStore) Get(key string) (string, error) {
	value, ok := m[key]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return value, nil
}
func (m memoryStore) Delete(key string) error {
	if _, ok := m[key]; !ok {
		return keyring.ErrNotFound
	}
	delete(m, key)
	return nil
}

func TestSaveLoadRoundTrip(t *testing.T) {
	store := memoryStore{}
	saved := Credentials{
		APIURL:  "https://xecret.example",
		Token:   "xct_live_secret",
		OrgSlug: "acme",
		Email:   "dev@example.com",
	}
	if err := Save(store, saved); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(store)
	if err != nil {
		t.Fatal(err)
	}
	if *loaded != saved {
		t.Errorf("round trip changed the credential: %+v", loaded)
	}
}

func TestLoadWithoutLogin(t *testing.T) {
	if _, err := Load(memoryStore{}); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("want ErrNotLoggedIn, got %v", err)
	}
}

func TestLoadRejectsCorruptPayload(t *testing.T) {
	store := memoryStore{"credentials": "{not json"}
	if _, err := Load(store); err == nil {
		t.Fatal("corrupt credentials must be an error, not a zero value")
	}
}

func TestLoadRejectsEmptyToken(t *testing.T) {
	store := memoryStore{"credentials": `{"apiUrl":"https://x","token":"","orgSlug":"a","email":"e"}`}
	if _, err := Load(store); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("an empty token is not a login; got %v", err)
	}
}

const acmeID = "0192f0a1-0000-7000-8000-00000000a001"

// A login stores the organisation's id, its name for output, and the slug as a
// hidden alias, and all three come back.
func TestTheOrganisationRoundTripsByIdNameAndAlias(t *testing.T) {
	store := memoryStore{}
	saved := Credentials{
		APIURL: "https://xecret.example", Token: "xct_live_secret", Email: "dev@example.com",
		OrgID: acmeID, OrgName: "Acme Corp", OrgSlug: "acme", UserID: "u-1",
	}
	if err := Save(store, saved); err != nil {
		t.Fatal(err)
	}
	// The alias is still written under the key an older binary reads, so a
	// downgrade keeps addressing the same organisation.
	if !strings.Contains(store[storeKey], `"orgSlug":"acme"`) ||
		!strings.Contains(store[storeKey], `"orgId":"`+acmeID+`"`) ||
		!strings.Contains(store[storeKey], `"orgName":"Acme Corp"`) {
		t.Fatalf("stored payload = %s", store[storeKey])
	}

	loaded, err := Load(store)
	if err != nil {
		t.Fatal(err)
	}
	if *loaded != saved {
		t.Errorf("round trip changed the credential: %+v", loaded)
	}
	if loaded.OrgRef() != acmeID {
		t.Errorf("OrgRef = %q, want the id", loaded.OrgRef())
	}
	if loaded.OrgLabel() != "Acme Corp" {
		t.Errorf("OrgLabel = %q, want the name", loaded.OrgLabel())
	}
}

// What a build from before organisation ids wrote: a slug and nothing else. It
// still loads, and still addresses the API, by the slug.
func TestASlugOnlyCredentialStillAddressesTheAPI(t *testing.T) {
	store := memoryStore{storeKey: `{"apiUrl":"https://x","token":"xct_live_old","orgSlug":"acme","email":"e"}`}
	loaded, err := Load(store)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.OrgID != "" || loaded.OrgName != "" {
		t.Fatalf("an old credential grew fields it never had: %+v", loaded)
	}
	if loaded.OrgRef() != "acme" {
		t.Errorf("OrgRef = %q, want the slug until the id is known", loaded.OrgRef())
	}
	if loaded.OrgLabel() != "" {
		t.Errorf("OrgLabel = %q; output must never fall back to the slug", loaded.OrgLabel())
	}
}

func TestOrganisationMatching(t *testing.T) {
	full := &Credentials{OrgID: acmeID, OrgSlug: "acme"}
	slugOnly := &Credentials{OrgSlug: "acme"}

	if !full.NamesOrg(acmeID) || !full.NamesOrg("acme") || full.NamesOrg("side") || full.NamesOrg("") {
		t.Error("NamesOrg must accept the id and the alias, and nothing else")
	}
	if slugOnly.NamesOrg("") {
		t.Error("an empty reference names no organisation")
	}

	// The id decides once it is known: a listing that pairs the alias with a
	// different id is a different organisation.
	if !full.IsOrg(acmeID, "acme") || full.IsOrg("0192f0a1-0000-7000-8000-00000000a002", "acme") {
		t.Error("IsOrg must match by id when the credential holds one")
	}
	if !slugOnly.IsOrg(acmeID, "acme") || slugOnly.IsOrg(acmeID, "side") || slugOnly.IsOrg(acmeID, "") {
		t.Error("IsOrg must match by slug for a credential that holds nothing else")
	}

	if (&Credentials{OrgID: acmeID, OrgSlug: "acme"}).OrgLabel() != acmeID {
		t.Error("with no name known, output names the organisation by its id")
	}
}

func TestClearIsIdempotent(t *testing.T) {
	store := memoryStore{}
	if err := Save(store, Credentials{APIURL: "https://x", Token: "t", OrgSlug: "o", Email: "e"}); err != nil {
		t.Fatal(err)
	}
	if err := Clear(store); err != nil {
		t.Fatal(err)
	}
	if err := Clear(store); err != nil {
		t.Fatalf("clearing an empty store must succeed, got %v", err)
	}
}
