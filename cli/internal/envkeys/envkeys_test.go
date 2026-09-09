package envkeys

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/e2ee"
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
