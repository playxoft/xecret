package envkeys

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/keyring"
)

// The full decrypt path, from a captured web response.
//
// `e2ee/vectors_test.go` proves the cryptography agrees with the browser byte
// for byte. This proves the layer above it: that a `GET …/pull` body, in the
// exact shape `apps/web` serves, becomes the map `xecret run` injects — with the
// right AAD components pulled from the right fields.
//
// That seam is where a cross-implementation bug would actually live now. Every
// AAD component is a *field of the response* — `keys.environmentId`,
// `activeEdk.version`, each secret's `id` and `version` — and reading any one of
// them from the wrong place produces a decryption failure that says nothing
// about which field was wrong.

const bundlePath = "testdata/pull-bundle.json"

// The service token whose key half opens the fixture. It is
// `sealed-box/token-edk`'s recipient private key from the vector file, rendered
// as the key half of a token string (spec §13.1) — which is what a real CI
// runner would hold.
const (
	fixtureTokenID  = "018f3b2c-9c1a-7c3d-8e4f-5a1b2c3d4e5f"
	fixtureOrgID    = "018f3b2c-9c1a-7c3d-8e4f-0a1b2c3d4e5f"
	fixtureKeyHalf  = "OK4uO5py9fJ5OMytnPhlo2onW4R8r77y6s6sEtGXuyA"
	fixtureAuthHalf = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
)

func fixtureToken() string {
	return "xst_live_" + fixtureAuthHalf + "k" + fixtureKeyHalf
}

func loadBundle(t *testing.T) *api.EnvironmentBundle {
	t.Helper()

	data, err := os.ReadFile(filepath.FromSlash(bundlePath))
	if err != nil {
		t.Fatalf("reading the bundle fixture: %v", err)
	}

	var bundle api.EnvironmentBundle
	if err := json.Unmarshal(data, &bundle); err != nil {
		t.Fatalf("parsing the bundle fixture: %v", err)
	}
	return &bundle
}

func fixturePrincipal(t *testing.T) *Principal {
	t.Helper()

	principal, err := ServicePrincipal(fixtureToken(), &api.TokenSelf{
		Token:        api.TokenPin{ID: fixtureTokenID, Name: "ci", AccessLevel: "read"},
		Organization: api.NamedSlug{ID: fixtureOrgID, Name: "Acme", Slug: "acme"},
	})
	if err != nil {
		t.Fatalf("resolving the service principal: %v", err)
	}
	return principal
}

// TestServiceTokenOpensACapturedBundle is the path a GitHub Actions run takes:
// a token in the environment, one pull, and a decrypted map — with no vault, no
// keyring and no browser anywhere in it.
func TestServiceTokenOpensACapturedBundle(t *testing.T) {
	principal := fixturePrincipal(t)
	defer principal.Close()

	if principal.Kind != e2ee.RecipientToken {
		t.Fatalf("principal kind = %q", principal.Kind)
	}

	secrets, err := DecryptBundle(loadBundle(t), principal)
	if err != nil {
		t.Fatalf("opening the bundle: %v", err)
	}

	const want = "postgres://app:hunter2@db.example.com:5432/app?sslmode=require"
	if secrets["DATABASE_URL"] != want {
		t.Errorf("DATABASE_URL\n got %q\nwant %q", secrets["DATABASE_URL"], want)
	}
	if len(secrets) != 1 {
		t.Errorf("decrypted %d secrets, want 1", len(secrets))
	}
}

// TestOpenedMaterialDecryptsEveryVectorCiphertext.
//
// The bundle carries one row, because a bundle serves one row per secret and the
// vector file's three ciphertexts are three *versions* of one. Presenting them
// as three rows would be a shape the server never produces; opening them
// directly through the same material exercises the version component of the AAD,
// which is the field a bundle cannot vary.
func TestOpenedMaterialDecryptsEveryVectorCiphertext(t *testing.T) {
	principal := fixturePrincipal(t)
	defer principal.Close()

	material, err := Open(loadBundle(t).Keys, principal)
	if err != nil {
		t.Fatalf("opening the grant: %v", err)
	}
	defer material.Close()

	for _, want := range []struct {
		version    int
		ciphertext string
		plaintext  string
	}{
		{
			version:    1,
			ciphertext: "xk2.gcm.m-nKxw9KsrkbcOGtgRdWFeW0a8gSHVR0YufZ59lwPgpGiuU7rjMpNQLh_MJG1_MKvxCwSjgwLH66wt8YVWBWmiTrCl94geY_7Gsw6kxFGiz4_HjI3nSDEE54",
			plaintext:  "postgres://app:hunter2@db.example.com:5432/app?sslmode=require",
		},
		// The empty value: a boundary the AEAD has to carry as faithfully as any
		// other, and the one a length check would silently reject.
		{version: 2, ciphertext: "xk2.gcm.biuI3K6gidqfbSeuk_H1KiSQEgmDrxRU9cO8zg", plaintext: ""},
		{
			version:    3,
			ciphertext: "xk2.gcm._1hgCerOdGPolE4kaF3mWCAEA1zWDVt3h_4BISwFNr7uVN0JNsDLWrZ8IFWTtDp52hbk",
			plaintext:  "naïve-token-café-2026",
		},
	} {
		got, err := material.DecryptSecret(api.ClientSecret{
			ID:           "018f3b2c-9c1a-7c3d-8e4f-2a1b2c3d4e5f",
			Name:         "DATABASE_URL",
			Ciphertext:   want.ciphertext,
			EnvDataKeyID: material.EnvDataKeyID,
			Version:      want.version,
		})
		if err != nil {
			t.Fatalf("v%d: %v", want.version, err)
		}
		if got != want.plaintext {
			t.Errorf("v%d\n got %q\nwant %q", want.version, got, want.plaintext)
		}
	}
}

// TestTheGrantIsBoundToItsOwnPrincipal.
//
// Every one of these is a field the CLI reads out of the response, and reading
// any of them from the wrong place is the cross-implementation bug this whole
// arrangement exists to catch early.
func TestTheGrantIsBoundToItsOwnPrincipal(t *testing.T) {
	principal := fixturePrincipal(t)
	defer principal.Close()

	for name, mutate := range map[string]func(*Principal, *api.EnvironmentBundle){
		"a member rather than a token": func(p *Principal, _ *api.EnvironmentBundle) {
			p.Kind = e2ee.RecipientMember
		},
		"another token's id": func(p *Principal, _ *api.EnvironmentBundle) {
			p.ID = "018f3b2c-9c1a-7c3d-8e4f-4a1b2c3d4e5f"
		},
		"another environment": func(_ *Principal, b *api.EnvironmentBundle) {
			b.Keys.EnvironmentID = "018f3b2c-9c1a-7c3d-8e4f-0a1b2c3d4e5f"
		},
		"the next EDK version": func(_ *Principal, b *api.EnvironmentBundle) {
			b.Keys.ActiveEDK.Version = 2
		},
	} {
		altered := *principal
		bundle := loadBundle(t)
		mutate(&altered, bundle)

		if _, err := Open(bundle.Keys, &altered); err == nil {
			t.Errorf("the grant opened with %s", name)
		}
	}
}

// TestARowUnderARetiredKeyIsNamed. Only the active grant is served, and the
// retired EDK was never stored anywhere — so "nobody can read this any more" and
// "something is wrong" need different words.
func TestARowUnderARetiredKeyIsNamed(t *testing.T) {
	principal := fixturePrincipal(t)
	defer principal.Close()

	bundle := loadBundle(t)
	bundle.Secrets[0].EnvDataKeyID = "018f3b2c-9c1a-7c3d-8e4f-8a1b2c3d4e5f"

	_, err := DecryptBundle(bundle, principal)
	if !errors.Is(err, ErrRotatedAway) {
		t.Errorf("want ErrRotatedAway, got %v", err)
	}
	// A partial environment injected into a child process is worse than none:
	// the child starts, reads a variable that is silently absent, and fails
	// somewhere far from the cause.
	if err == nil {
		t.Error("an unreadable row did not stop the pull")
	}
}

// TestAPendingGrantIsNotAFailure. An admin can grant access without holding the
// key, so "nobody has shared this with you yet" is a designed state and needs an
// error a caller can turn into an instruction.
func TestAPendingGrantIsNotAFailure(t *testing.T) {
	principal := fixturePrincipal(t)
	defer principal.Close()

	bundle := loadBundle(t)
	bundle.Keys.MyGrant = nil

	if _, err := Open(bundle.Keys, principal); !errors.Is(err, ErrNoGrant) {
		t.Errorf("want ErrNoGrant, got %v", err)
	}
}

// TestServerModeIsRefusedRatherThanGuessedAt.
func TestServerModeIsRefusedRatherThanGuessedAt(t *testing.T) {
	principal := fixturePrincipal(t)
	defer principal.Close()

	bundle := loadBundle(t)
	bundle.Keys.EncryptionMode = "server"

	if _, err := Open(bundle.Keys, principal); err == nil {
		t.Error("a server-mode environment was opened as an encrypted one")
	}
}

// TestALegacyTokenSaysSoBeforeItFails. A token minted before Phase 4
// authenticates perfectly and decrypts nothing; the failure it would otherwise
// produce is "a grant would not open", which names the wrong thing.
func TestALegacyTokenSaysSoBeforeItFails(t *testing.T) {
	_, err := ServicePrincipal("xst_live_"+fixtureAuthHalf, &api.TokenSelf{
		Token:        api.TokenPin{ID: fixtureTokenID},
		Organization: api.NamedSlug{ID: fixtureOrgID},
	})
	if err == nil {
		t.Fatal("a keyless token produced a principal")
	}
	if got := err.Error(); got == "" {
		t.Error("the refusal says nothing")
	}
}

// ── Reporting every row that failed, not the first one ──
//
// A pull still fails as a unit. What changed is that it says what is wrong with
// the environment rather than what is wrong with the first row of it, because
// the shape of the answer — "these three, all naming the old key" — is what
// distinguishes a rotation in progress from a damaged record.

// retiredRow copies a row and points it at a key that is not the active one.
func retiredRow(source api.ClientSecret, name string) api.ClientSecret {
	row := source
	row.Name = name
	row.EnvDataKeyID = "018f3b2c-9c1a-7c3d-8e4f-8a1b2c3d4e5f"
	return row
}

func TestDecryptBundleReportsEveryFailingRow(t *testing.T) {
	principal := fixturePrincipal(t)
	defer principal.Close()

	bundle := loadBundle(t)
	source := bundle.Secrets[0]
	bundle.Secrets = []api.ClientSecret{
		retiredRow(source, "LEGACY_ONE"),
		source,
		retiredRow(source, "LEGACY_TWO"),
	}

	_, err := DecryptBundle(bundle, principal)
	if err == nil {
		t.Fatal("unreadable rows did not stop the pull")
	}

	var bundleErr *BundleError
	if !errors.As(err, &bundleErr) {
		t.Fatalf("err = %T (%v), want a *BundleError", err, err)
	}
	if len(bundleErr.Failures) != 2 || bundleErr.Total != 3 {
		t.Fatalf("failures = %d of %d, want 2 of 3", len(bundleErr.Failures), bundleErr.Total)
	}

	// Both names, in the order the bundle listed them: a message that stops at
	// the first is a user running the same command once per broken secret.
	message := err.Error()
	for _, name := range []string{"LEGACY_ONE", "LEGACY_TWO"} {
		if !strings.Contains(message, name) {
			t.Errorf("the message does not name %s: %s", name, message)
		}
	}
	if strings.Index(message, "LEGACY_ONE") > strings.Index(message, "LEGACY_TWO") {
		t.Errorf("the failures are not in bundle order: %s", message)
	}
	if !strings.Contains(message, ErrRotatedAway.Error()) {
		t.Errorf("the message does not carry each row's reason: %s", message)
	}

	// Every failure names a retired key, so the remedy is stated.
	if !bundleErr.AllRotatedAway() {
		t.Error("AllRotatedAway is false for a bundle whose every failure is one")
	}
	if !strings.Contains(message, "set them again") {
		t.Errorf("the rewrite instruction is missing: %s", message)
	}
	if !errors.Is(err, ErrRotatedAway) {
		t.Error("errors.Is does not reach the row errors")
	}
}

// The hint is only correct when every failure is a retired-key row. Rewriting a
// secret whose ciphertext failed for some other reason destroys the evidence and
// fixes nothing, so a mixed bundle does not suggest it.
func TestAMixedBundleDoesNotSuggestRewritingSecrets(t *testing.T) {
	principal := fixturePrincipal(t)
	defer principal.Close()

	bundle := loadBundle(t)
	source := bundle.Secrets[0]
	damaged := source
	damaged.Name = "DAMAGED"
	damaged.Version = source.Version + 1 // the AAD no longer matches the blob

	bundle.Secrets = []api.ClientSecret{retiredRow(source, "LEGACY_ONE"), damaged}

	_, err := DecryptBundle(bundle, principal)
	var bundleErr *BundleError
	if !errors.As(err, &bundleErr) {
		t.Fatalf("err = %v, want a *BundleError", err)
	}
	if len(bundleErr.Failures) != 2 {
		t.Fatalf("failures = %d, want both rows", len(bundleErr.Failures))
	}
	if bundleErr.AllRotatedAway() {
		t.Fatal("a decryption failure was counted as a rotated-away row")
	}
	if strings.Contains(err.Error(), "set them again") {
		t.Errorf("a mixed bundle suggested a rewrite: %s", err.Error())
	}
}

// A bundle that opens completely reports nothing, which is the case that would
// otherwise be broken by collecting failures in a slice nobody empties.
func TestACleanBundleStillOpens(t *testing.T) {
	principal := fixturePrincipal(t)
	defer principal.Close()

	secrets, err := DecryptBundle(loadBundle(t), principal)
	if err != nil {
		t.Fatalf("DecryptBundle: %v", err)
	}
	if len(secrets) == 0 {
		t.Fatal("no secrets came back from a clean bundle")
	}
}

// ── The wraps this machine keeps, and the ones it does not ──

func TestVaultWrapsRoundTripAndCarryOnlyTheWraps(t *testing.T) {
	store := memoryStore{}

	material := &api.VaultMaterial{
		EncPrivateKeyEnc:  "xk2.gcm.enc",
		SignPrivateKeyEnc: "xk2.gcm.sign",
		PassphraseWrap:    "xk2.gcm.passphrase",
		KdfSalt:           "c2FsdA",
	}
	if err := StoreVaultWraps(store, material); err != nil {
		t.Fatalf("StoreVaultWraps: %v", err)
	}

	stored := store[VaultWrapsEntry]
	if !strings.Contains(stored, "xk2.gcm.enc") || !strings.Contains(stored, "xk2.gcm.sign") {
		t.Fatalf("the private-key wraps did not survive: %s", stored)
	}
	// The passphrase wrap and the salt are the User Key under a human secret.
	// Keeping them here would hand anybody who reads this store an offline
	// guessing target, and nothing needs them to go from the UK to a private key.
	if strings.Contains(stored, "passphrase") || strings.Contains(stored, "c2FsdA") {
		t.Fatalf("the passphrase wrap was stored: %s", stored)
	}

	wraps, err := readVaultWraps(store)
	if err != nil {
		t.Fatalf("readVaultWraps: %v", err)
	}
	if wraps.EncPrivateKeyEnc != material.EncPrivateKeyEnc {
		t.Fatalf("encPrivateKeyEnc = %q", wraps.EncPrivateKeyEnc)
	}
}

// Forgetting the User Key forgets the wraps too, so "deleting this entry is
// cryptographic erasure" stays a sentence without a footnote.
func TestForgetUserKeyForgetsTheWraps(t *testing.T) {
	store := memoryStore{}
	userKey := make([]byte, e2ee.KeyBytes)

	if err := StoreUserKey(store, userKey); err != nil {
		t.Fatal(err)
	}
	if err := StoreVaultWraps(store, &api.VaultMaterial{EncPrivateKeyEnc: "xk2.gcm.enc"}); err != nil {
		t.Fatal(err)
	}
	if err := ForgetUserKey(store); err != nil {
		t.Fatalf("ForgetUserKey: %v", err)
	}

	if _, ok := store[UserKeyEntry]; ok {
		t.Error("the vault key survived a logout")
	}
	if _, ok := store[VaultWrapsEntry]; ok {
		t.Error("the private-key wrap survived a logout")
	}
	// And it is idempotent: a second logout, or a logout on a machine that never
	// held one, must not fail.
	if err := ForgetUserKey(store); err != nil {
		t.Errorf("a second ForgetUserKey: %v", err)
	}
}

// A machine that holds the User Key and no wraps is a login made by an earlier
// build. It fails with the one instruction that fixes it for ever, rather than
// with "run login again", which would throw the working credential away too.
func TestOfflinePrincipalWithoutWrapsNamesTheRemedy(t *testing.T) {
	store := memoryStore{}
	if err := StoreUserKey(store, make([]byte, e2ee.KeyBytes)); err != nil {
		t.Fatal(err)
	}

	_, err := OfflineMemberPrincipal(store, "user", "org")
	if !errors.Is(err, ErrNoVaultWraps) {
		t.Fatalf("err = %v, want ErrNoVaultWraps", err)
	}
	if strings.Contains(err.Error(), "xecret login") {
		t.Errorf("the message sends the user to re-login unnecessarily: %v", err)
	}
}

// memoryStore is an in-memory keyring.Store, so these tests never touch the
// machine's real keychain.
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
