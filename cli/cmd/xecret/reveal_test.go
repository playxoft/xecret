package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/envkeys"
	"github.com/playxoft/xecret/cli/internal/keyring"
	"github.com/playxoft/xecret/cli/internal/output"
)

// C12(3). `secrets get --plain` read the environment's key state *after* the
// reveal it was going to open, which is a race with every rotation: the reveal
// returns ciphertext against the old key, the key read returns the new state,
// the row's `envDataKeyId` no longer matches the active one, and the user is
// told their secret was rotated away when nothing of the sort happened. The key
// is read first now, so the key is at least as old as the ciphertext and a
// mismatch is a real one.
//
// This asserts the order on the wire, because that is the whole of the fix and
// it is not visible anywhere else.
func TestRevealReadsTheKeyStateBeforeTheCiphertext(t *testing.T) {
	fixture := newE2eeFixture(t)
	bundle := mustBundle(t, fixture.bundle)
	secret := bundle.Secrets[0]

	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.HasSuffix(r.URL.Path, "/keys"):
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": bundle.Keys})
		case strings.HasSuffix(r.URL.Path, "/auth/vault"):
			_ = json.NewEncoder(w).Encode(map[string]any{"material": fixture.material})
		case strings.Contains(r.URL.Path, "/secrets/"):
			_ = json.NewEncoder(w).Encode(map[string]any{"secret": api.RevealedCiphertext{
				ID:           secret.ID,
				Name:         secret.Name,
				Ciphertext:   secret.Ciphertext,
				EnvDataKeyID: secret.EnvDataKeyID,
				Version:      secret.Version,
			}})
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XECRET_KEYRING", "file")
	t.Setenv("XECRET_TOKEN", "")

	printer := output.New(false)
	store := keyring.Open(printer.Warnf)
	if err := cred.Save(store, cred.Credentials{
		APIURL: server.URL, Token: "xct_live_abc", Email: "ada@example.com",
		OrgSlug: "acme", UserID: fixture.userID, OrgID: fixture.orgID,
	}); err != nil {
		t.Skipf("this platform's file keyring is not writable under a temporary HOME: %v", err)
	}
	if err := envkeys.StoreUserKey(store, fixture.userKey); err != nil {
		t.Fatal(err)
	}

	if err := secretsGet([]string{
		"--plain", "--json", "--project", "web", "--environment", "dev", "DATABASE_URL",
	}); err != nil {
		t.Fatalf("secrets get --plain: %v", err)
	}

	keysAt, revealAt := -1, -1
	for i, path := range paths {
		if keysAt < 0 && strings.HasSuffix(path, "/keys") {
			keysAt = i
		}
		if revealAt < 0 && strings.Contains(path, "/secrets/") {
			revealAt = i
		}
	}
	if keysAt < 0 || revealAt < 0 {
		t.Fatalf("both requests must happen; paths = %v", paths)
	}
	if keysAt > revealAt {
		t.Fatalf("the key state was read after the reveal: %v", paths)
	}
}
