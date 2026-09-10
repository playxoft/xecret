package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cache"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/envkeys"
	"github.com/playxoft/xecret/cli/internal/keyring"
	"github.com/playxoft/xecret/cli/internal/output"
)

// What `xecret run --offline` has to be able to do without a network, and what
// it must refuse to do with one.
//
// The fixture below is a whole end-to-end encrypted environment built in
// memory: a member keypair, a User Key, the private-key wrap that hangs off it,
// a grant sealed to that member, and one ciphertext under the environment's data
// key. That is deliberately not a captured response — these tests are about the
// *custody* of the material between commands, so every piece of it has to be
// something the test can withhold one at a time.

// e2eeFixture is one environment, and everything a login would hold for it.
type e2eeFixture struct {
	userID   string
	orgID    string
	envID    string
	userKey  []byte
	material *api.VaultMaterial
	bundle   []byte
	// values is what a successful decrypt must produce.
	values map[string]string
}

func newE2eeFixture(t *testing.T) *e2eeFixture {
	t.Helper()

	const (
		userID   = "018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e50"
		orgID    = "018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e51"
		envID    = "018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e52"
		secretID = "018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e53"
		edkID    = "018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e54"
	)

	pair, err := e2ee.GenerateEncryptionKeyPair()
	if err != nil {
		t.Fatalf("generating a member keypair: %v", err)
	}

	userKey := make([]byte, e2ee.KeyBytes)
	edk := make([]byte, e2ee.KeyBytes)
	ehk := make([]byte, e2ee.KeyBytes)
	for _, buffer := range [][]byte{userKey, edk, ehk} {
		if _, err := rand.Read(buffer); err != nil {
			t.Fatalf("randomness: %v", err)
		}
	}

	encPrivateKeyEnc, err := e2ee.WrapPrivateKey(userKey, pair.PrivateKey, userID, e2ee.PurposeEncryption)
	if err != nil {
		t.Fatalf("wrapping the private key: %v", err)
	}

	grant, err := e2ee.SealGrant(e2ee.GrantRecipient{
		EnvironmentID:      envID,
		EDKVersion:         1,
		RecipientKind:      e2ee.RecipientMember,
		RecipientID:        userID,
		RecipientPublicKey: pair.PublicKey,
	}, e2ee.EnvironmentKeys{EDK: edk, EHK: ehk})
	if err != nil {
		t.Fatalf("sealing the grant: %v", err)
	}

	ciphertext, err := e2ee.EncryptSecret(edk, e2ee.SecretContext{
		Field:         e2ee.FieldValue,
		OrgID:         orgID,
		EnvironmentID: envID,
		SecretID:      secretID,
		Version:       1,
	}, "postgres://cached")
	if err != nil {
		t.Fatalf("encrypting the fixture secret: %v", err)
	}

	bundle, err := json.Marshal(api.EnvironmentBundle{
		Bundle:         true,
		BundleVersion:  1,
		EncryptionMode: "e2ee",
		Keys: api.EnvironmentKeys{
			EncryptionMode: "e2ee",
			EnvironmentID:  envID,
			ActiveEDK:      &api.ActiveKey{ID: edkID, Version: 1},
			MyGrant:        &api.MyGrant{EDKSealed: grant.EDKSealed, EHKSealed: grant.EHKSealed},
		},
		Secrets: []api.ClientSecret{{
			ID:              secretID,
			Name:            "DATABASE_URL",
			Ciphertext:      ciphertext,
			ClientAlgorithm: envkeys.ClientAlgorithm,
			EnvDataKeyID:    edkID,
			Version:         1,
		}},
	})
	if err != nil {
		t.Fatalf("marshalling the fixture bundle: %v", err)
	}

	return &e2eeFixture{
		userID:   userID,
		orgID:    orgID,
		envID:    envID,
		userKey:  userKey,
		material: &api.VaultMaterial{EncPrivateKeyEnc: encPrivateKeyEnc},
		bundle:   bundle,
		values:   map[string]string{"DATABASE_URL": "postgres://cached"},
	}
}

// offlineHarness is a machine with an isolated home, a file keyring, and an API
// client pointed at an address nothing is listening on.
type offlineHarness struct {
	app         *app
	client      *api.Client
	credentials *cred.Credentials
	resolved    scope
	scopeKey    cache.Scope
	warnings    *bytes.Buffer
}

func newOfflineHarness(t *testing.T, fixture *e2eeFixture) *offlineHarness {
	t.Helper()

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XECRET_KEYRING", "file")
	t.Setenv("XECRET_TOKEN", "")
	t.Setenv(cache.MaxAgeEnv, "")

	// A server that is closed before a single request is made. Any call the code
	// under test attempts fails at the socket, which is the whole point: an
	// `--offline` run that reaches the network cannot pass this test by accident.
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the offline path made a request to %s", r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	deadURL := dead.URL
	dead.Close()

	warnings := &bytes.Buffer{}
	printer := &output.Printer{Out: io.Discard, Err: warnings}
	a := &app{printer: printer, store: keyring.Open(printer.Warnf)}

	credentials := cred.Credentials{
		APIURL:  deadURL,
		Token:   "xct_live_stored",
		Email:   "ada@example.com",
		OrgSlug: "acme",
		UserID:  fixture.userID,
		OrgID:   fixture.orgID,
	}
	if err := cred.Save(a.store, credentials); err != nil {
		t.Skipf("this platform's file keyring is not writable under a temporary HOME: %v", err)
	}
	if err := envkeys.StoreUserKey(a.store, fixture.userKey); err != nil {
		t.Fatalf("storing the vault key: %v", err)
	}

	return &offlineHarness{
		app:         a,
		client:      api.New(deadURL, credentials.Token, userAgent()),
		credentials: &credentials,
		resolved:    scope{Org: "acme", Project: "web", Environment: "dev"},
		scopeKey: cache.Scope{
			Host: deadURL, Org: "acme", Project: "web", Environment: "dev",
		},
		warnings: warnings,
	}
}

func (h *offlineHarness) encryptedScope() cache.Scope {
	key := h.scopeKey
	key.Encrypted = true
	return key
}

func (h *offlineHarness) fetch(policy cachePolicy) (map[string]string, error) {
	return fetchSecrets(h.app, h.client, h.credentials, h.resolved, h.scopeKey, policy)
}

// C4. `--offline` used to make a live `GET /api/auth/vault` for the wrapped
// private key, so the one flag whose entire promise is "do not call the API"
// could not open a single secret on a train. The wrap is stored beside the User
// Key at login now, and this proves the flag keeps its promise.
func TestOfflineRunOpensACachedBundleWithNoNetwork(t *testing.T) {
	fixture := newE2eeFixture(t)
	h := newOfflineHarness(t, fixture)

	if err := envkeys.StoreVaultWraps(h.app.store, fixture.material); err != nil {
		t.Fatalf("storing the vault wraps: %v", err)
	}
	if err := cache.WriteBundle(h.app.store, h.encryptedScope(), fixture.bundle, time.Now()); err != nil {
		t.Fatalf("seeding the offline bundle: %v", err)
	}

	secrets, err := h.fetch(cachePolicy{offline: true, maxAge: cache.DefaultMaxAge})
	if err != nil {
		t.Fatalf("--offline: %v", err)
	}
	if secrets["DATABASE_URL"] != fixture.values["DATABASE_URL"] {
		t.Fatalf("DATABASE_URL = %q, want %q", secrets["DATABASE_URL"], fixture.values["DATABASE_URL"])
	}
}

// The other half of the same claim: it is the stored wrap that makes it work,
// not something the cache happened to contain. Without one there is no path
// from the User Key to the private key, and the message says so.
func TestOfflineRunWithoutStoredWrapsExplainsItself(t *testing.T) {
	fixture := newE2eeFixture(t)
	h := newOfflineHarness(t, fixture)

	if err := cache.WriteBundle(h.app.store, h.encryptedScope(), fixture.bundle, time.Now()); err != nil {
		t.Fatalf("seeding the offline bundle: %v", err)
	}

	_, err := h.fetch(cachePolicy{offline: true, maxAge: cache.DefaultMaxAge})
	if err == nil {
		t.Fatal("expected the offline read to fail without the private-key wrap")
	}
	if !errors.Is(err, envkeys.ErrNoVaultWraps) {
		t.Fatalf("err = %v, want ErrNoVaultWraps", err)
	}
}

// C5. A machine that read this environment before the migration still holds a
// plaintext cache file, and nothing deleted it. Falling through to it once the
// mode pin says `e2ee` serves pre-migration values out of a file the migration
// was supposed to have made unreadable.
func TestPinnedE2eeRefusesTheStalePlaintextCache(t *testing.T) {
	fixture := newE2eeFixture(t)
	h := newOfflineHarness(t, fixture)

	if err := cache.Write(h.app.store, h.scopeKey, map[string]string{"DATABASE_URL": "postgres://pre-migration"}, time.Now()); err != nil {
		t.Fatalf("seeding the plaintext cache: %v", err)
	}
	if err := cache.PinMode(h.scopeKey, "e2ee"); err != nil {
		t.Fatalf("pinning the mode: %v", err)
	}

	secrets, err := h.fetch(cachePolicy{offline: true, maxAge: cache.DefaultMaxAge})
	if err == nil {
		t.Fatalf("the stale plaintext copy was served: %v", secrets)
	}
	if !errors.Is(err, cache.ErrPlaintextRefused) {
		t.Fatalf("err = %v, want ErrPlaintextRefused", err)
	}
}

// And the file itself goes, on the next successful online read — because a
// refusal that leaves the file behind leaves it for the next binary, the next
// `--no-cache=false` code path, and anybody who can read the directory.
func TestSuccessfulE2eeReadDeletesTheStalePlaintextCache(t *testing.T) {
	fixture := newE2eeFixture(t)
	h := newOfflineHarness(t, fixture)

	if err := envkeys.StoreVaultWraps(h.app.store, fixture.material); err != nil {
		t.Fatalf("storing the vault wraps: %v", err)
	}
	if err := cache.Write(h.app.store, h.scopeKey, map[string]string{"DATABASE_URL": "postgres://pre-migration"}, time.Now()); err != nil {
		t.Fatalf("seeding the plaintext cache: %v", err)
	}
	if _, err := cache.Read(h.app.store, h.scopeKey); err != nil {
		t.Fatalf("the seeded plaintext copy did not round-trip: %v", err)
	}

	if _, err := openBundle(context.Background(), h.app, h.client, h.credentials, h.scopeKey, &api.Pulled{
		Bundle: mustBundle(t, fixture.bundle),
		Raw:    fixture.bundle,
	}, cachePolicy{maxAge: cache.DefaultMaxAge}); err != nil {
		t.Fatalf("opening the bundle: %v", err)
	}

	if _, err := cache.Read(h.app.store, h.scopeKey); !errors.Is(err, cache.ErrMiss) {
		t.Fatalf("the plaintext cache survived an e2ee read: %v", err)
	}
}

// C12(2). The bundle is cached as received, before anything tries to open it, so
// a mid-rotation environment — where some row names a key this principal no
// longer holds — still refreshes the copy the next outage will be served from.
func TestAFailedDecryptStillRefreshesTheCache(t *testing.T) {
	fixture := newE2eeFixture(t)
	h := newOfflineHarness(t, fixture)

	if err := envkeys.StoreVaultWraps(h.app.store, fixture.material); err != nil {
		t.Fatalf("storing the vault wraps: %v", err)
	}

	// One extra row naming a key that has been rotated away. The environment is
	// otherwise the one the fixture built, and the run fails.
	bundle := mustBundle(t, fixture.bundle)
	bundle.Secrets = append(bundle.Secrets, api.ClientSecret{
		ID:   "018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e55",
		Name: "LEGACY_TOKEN",
		// Never reached: a row naming a retired key is refused on the key id
		// before any attempt is made to open it.
		Ciphertext:   "xk2.gcm.AAAAAAAAAAAAAAAA",
		EnvDataKeyID: "018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e99",
		Version:      1,
	})
	raw, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := openBundle(context.Background(), h.app, h.client, h.credentials, h.scopeKey,
		&api.Pulled{Bundle: bundle, Raw: raw}, cachePolicy{maxAge: cache.DefaultMaxAge}); err == nil {
		t.Fatal("expected the rotated-away row to fail the pull")
	}

	entry, readErr := cache.Read(h.app.store, h.encryptedScope())
	if readErr != nil {
		t.Fatalf("the cache was not refreshed by a pull that failed to decrypt: %v", readErr)
	}
	if !bytes.Equal(entry.Bundle, raw) {
		t.Fatal("the cached bytes are not the bytes the server sent")
	}
}

// C10. An offline copy is served with no upper bound on its age, so a rotation
// that revokes somebody keeps being deferred by whatever file is on their disk.
func TestOfflineCacheRefusesAnEntryPastTheAgeBound(t *testing.T) {
	fixture := newE2eeFixture(t)
	h := newOfflineHarness(t, fixture)

	if err := envkeys.StoreVaultWraps(h.app.store, fixture.material); err != nil {
		t.Fatalf("storing the vault wraps: %v", err)
	}
	stale := time.Now().Add(-8 * 24 * time.Hour)
	if err := cache.WriteBundle(h.app.store, h.encryptedScope(), fixture.bundle, stale); err != nil {
		t.Fatalf("seeding the offline bundle: %v", err)
	}

	if _, err := h.fetch(cachePolicy{offline: true, maxAge: cache.DefaultMaxAge}); !errors.Is(err, cache.ErrTooOld) {
		t.Fatalf("err = %v, want ErrTooOld", err)
	}

	// Overridden, it serves — and says what that costs.
	secrets, err := h.fetch(cachePolicy{offline: true, maxAge: 30 * 24 * time.Hour, ageOverridden: true})
	if err != nil {
		t.Fatalf("overridden bound: %v", err)
	}
	if secrets["DATABASE_URL"] != fixture.values["DATABASE_URL"] {
		t.Fatalf("DATABASE_URL = %q", secrets["DATABASE_URL"])
	}
	if !strings.Contains(h.warnings.String(), "revocation") {
		t.Fatalf("the override warning does not name the trade-off: %q", h.warnings.String())
	}
}

func TestResolveMaxCacheAge(t *testing.T) {
	t.Setenv(cache.MaxAgeEnv, "")

	age, overridden, err := cache.ResolveMaxAge("")
	if err != nil || overridden || age != cache.DefaultMaxAge {
		t.Fatalf("default = %v, %v, %v", age, overridden, err)
	}

	if age, overridden, err = cache.ResolveMaxAge("30d"); err != nil || !overridden || age != 30*24*time.Hour {
		t.Fatalf("--max-cache-age 30d = %v, %v, %v", age, overridden, err)
	}

	t.Setenv(cache.MaxAgeEnv, "12h")
	if age, overridden, err = cache.ResolveMaxAge(""); err != nil || !overridden || age != 12*time.Hour {
		t.Fatalf("%s=12h = %v, %v, %v", cache.MaxAgeEnv, age, overridden, err)
	}

	// The flag wins over the environment, as every other flag in this binary does.
	if age, _, err = cache.ResolveMaxAge("1h"); err != nil || age != time.Hour {
		t.Fatalf("flag over environment = %v, %v", age, err)
	}

	t.Setenv(cache.MaxAgeEnv, "")
	if _, _, err := cache.ResolveMaxAge("last tuesday"); err == nil {
		t.Fatal("an unparseable bound must be refused rather than silently ignored")
	}
	if _, _, err := cache.ResolveMaxAge("-1h"); err == nil {
		t.Fatal("a negative bound must be refused")
	}
}

func mustBundle(t *testing.T, raw []byte) *api.EnvironmentBundle {
	t.Helper()
	var bundle api.EnvironmentBundle
	if err := json.Unmarshal(raw, &bundle); err != nil {
		t.Fatalf("parsing the fixture bundle: %v", err)
	}
	return &bundle
}
