package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/output"
)

// The service-token path: XECRET_TOKEN wins over any stored login, the pin is
// introspected exactly once, and its scope fills whatever the flags and
// .xecret.yaml leave open.

func serviceTokenServer(t *testing.T, calls *int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tokens/self" {
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer xst_live_abc" {
			t.Fatalf("authorization = %q", got)
		}
		*calls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":        map[string]any{"name": "deploy", "accessLevel": "read"},
			"organization": map[string]any{"name": "Acme", "slug": "acme"},
			"project":      map[string]any{"name": "API", "slug": "backend"},
			"environment":  map[string]any{"name": "Production", "slug": "production", "isProduction": true},
		})
	}))
}

func TestServiceTokenClientIntrospectsOnce(t *testing.T) {
	calls := 0
	server := serviceTokenServer(t, &calls)
	defer server.Close()

	t.Setenv("XECRET_TOKEN", "xst_live_abc")
	t.Setenv("XECRET_API_URL", server.URL)

	a := &app{printer: output.New(false)}

	_, credentials, err := a.client()
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	if credentials.OrgSlug != "acme" {
		t.Fatalf("org = %q, want acme", credentials.OrgSlug)
	}

	// A second client on the same invocation reuses the cached pin.
	if _, _, err := a.client(); err != nil {
		t.Fatalf("second client: %v", err)
	}
	if calls != 1 {
		t.Fatalf("introspections = %d, want 1", calls)
	}
}

// A two-half token must present its auth half and nothing else. The key half is
// the X25519 scalar that opens every secret in the environment (spec §13.1): a
// request carrying it hands it to the server, its logs and every proxy between —
// and the server refuses such a token outright, so the mistake is both a
// disclosure and a broken flow.
func TestServiceTokenSendsOnlyTheAuthHalf(t *testing.T) {
	// 43 base64url characters each. The final character carries only two
	// significant bits, so it has to be one whose low bits are zero — 'B' in the
	// last position would not decode to 32 bytes.
	authHalf := strings.Repeat("A", 43)
	keyHalf := strings.Repeat("B", 42) + "A"
	token := "xst_live_" + authHalf + "k" + keyHalf

	var seen string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":        map[string]any{"name": "deploy", "accessLevel": "read"},
			"organization": map[string]any{"name": "Acme", "slug": "acme"},
			"project":      map[string]any{"name": "API", "slug": "backend"},
			"environment":  map[string]any{"name": "Production", "slug": "production"},
		})
	}))
	defer server.Close()

	t.Setenv("XECRET_TOKEN", token)
	t.Setenv("XECRET_API_URL", server.URL)

	a := &app{printer: output.New(false)}
	_, credentials, err := a.client()
	if err != nil {
		t.Fatalf("client: %v", err)
	}

	if want := "Bearer xst_live_" + authHalf; seen != want {
		t.Fatalf("authorization = %q, want %q", seen, want)
	}
	if strings.Contains(seen, keyHalf) {
		t.Fatal("the key half reached the Authorization header")
	}
	// The credential the rest of the command carries must be the auth half too,
	// or the next request built from it puts the scalar back on the wire.
	if credentials.Token != "xst_live_"+authHalf {
		t.Fatalf("credential token = %q", credentials.Token)
	}
}

// A token this build cannot parse is not a service token of either known shape,
// so there is no key half to strip and the server gets to answer.
func TestServiceTokenPassesAnUnparseableTokenThrough(t *testing.T) {
	if got := authHalfOf("xst_live_abc"); got != "xst_live_abc" {
		t.Fatalf("authHalfOf = %q", got)
	}
}

func TestResolveScopeFallsBackToTokenPin(t *testing.T) {
	// An empty directory: no .xecret.yaml anywhere above the temp root would
	// be found, but flags are also empty, so the token pin must answer.
	t.Chdir(t.TempDir())

	a := &app{printer: output.New(false)}
	a.tokenScope = &api.TokenSelf{}
	a.tokenScope.Organization.Slug = "acme"
	a.tokenScope.Project.Slug = "backend"
	a.tokenScope.Environment.Slug = "production"

	resolved, err := a.resolveScope(&cred.Credentials{OrgSlug: "acme"}, "", "")
	if err != nil {
		t.Fatalf("resolveScope: %v", err)
	}
	if resolved.Project != "backend" || resolved.Environment != "production" {
		t.Fatalf("resolved = %+v", resolved)
	}

	// Flags still win over the pin: the server is the enforcement point.
	resolved, err = a.resolveScope(&cred.Credentials{OrgSlug: "acme"}, "other", "staging")
	if err != nil {
		t.Fatalf("resolveScope with flags: %v", err)
	}
	if resolved.Project != "other" || resolved.Environment != "staging" {
		t.Fatalf("resolved = %+v", resolved)
	}
}

func TestLogoutRefusesUnderServiceToken(t *testing.T) {
	t.Setenv("XECRET_TOKEN", "xst_live_abc")

	if err := cmdLogout(nil); err == nil {
		t.Fatal("expected logout to refuse while XECRET_TOKEN is set")
	}
}
