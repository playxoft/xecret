package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
