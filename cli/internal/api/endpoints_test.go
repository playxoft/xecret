package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The endpoints added for version history, metadata, resources, tokens and the
// audit log. Each test asserts the two things a typed client can get wrong: the
// request it builds, and the response fields it reads.

func TestSecretVersionsFollowsTheCursor(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.RequestURI())
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("cursor") == "" {
			_, _ = w.Write([]byte(`{"data":[{"version":2,"current":true,"createdAt":"2026-08-01T00:00:00Z"}],"nextCursor":"2"}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"version":1,"current":false,"createdAt":"2026-07-01T00:00:00Z"}],"nextCursor":null}`))
	}))
	defer server.Close()

	versions, err := New(server.URL, "xct_live_abc", "test-agent").
		SecretVersions(context.Background(), "acme", "web", "production", "DATABASE_URL")
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 2 || versions[0].Version != 2 || !versions[0].Current {
		t.Fatalf("versions = %+v", versions)
	}
	if len(paths) != 2 || !strings.Contains(paths[1], "cursor=2") {
		t.Fatalf("paths = %v", paths)
	}
	if !strings.Contains(paths[0], "/secrets/DATABASE_URL/versions") {
		t.Fatalf("first path = %q", paths[0])
	}
}

func TestRevealVersionAsksForTheRightVersion(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"secret":{"name":"API_KEY","value":"old-value","version":3,"current":false}}`))
	}))
	defer server.Close()

	revealed, err := New(server.URL, "xct_live_abc", "test-agent").
		RevealVersion(context.Background(), "acme", "web", "production", "API_KEY", 3)
	if err != nil {
		t.Fatal(err)
	}
	if revealed.Value != "old-value" || revealed.Current {
		t.Fatalf("revealed = %+v", revealed)
	}
	if !strings.HasSuffix(path, "/secrets/API_KEY/versions/3") {
		t.Fatalf("path = %q", path)
	}
}

func TestRestoreSendsTheVersionAndReadsTheSource(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"secret":{"name":"API_KEY","version":7,"status":"changed","restoredFrom":3}}`))
	}))
	defer server.Close()

	result, err := New(server.URL, "xct_live_abc", "test-agent").
		RestoreSecret(context.Background(), "acme", "web", "production", "API_KEY", 3)
	if err != nil {
		t.Fatal(err)
	}
	if body["version"] != float64(3) {
		t.Fatalf("body = %+v", body)
	}
	if result.Version != 7 || result.RestoredFrom != 3 {
		t.Fatalf("result = %+v", result)
	}
}

// A cleared note must reach the server as JSON null: "" would set the note to
// an empty string, which the dashboard renders as a note that is there and
// says nothing.
func TestUpdateMetadataSendsNullToClearANote(t *testing.T) {
	var raw string
	var method string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		// io.ReadAll, not a single Read into a fixed buffer: one Read may
		// legitimately return a prefix, which would make this test flake on the
		// one wire detail it exists to pin down.
		body, _ := io.ReadAll(r.Body)
		raw = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"secret":{"name":"API_KEY","note":null,"valueType":"string"}}`))
	}))
	defer server.Close()

	empty := ""
	if _, err := New(server.URL, "xct_live_abc", "test-agent").UpdateMetadata(
		context.Background(), "acme", "web", "production", "API_KEY",
		MetadataUpdate{Note: &empty},
	); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPut {
		t.Fatalf("method = %s, want PUT", method)
	}
	if !strings.Contains(raw, `"note":null`) {
		t.Fatalf("body = %s", raw)
	}
}

func TestUpdateMetadataOmitsUntouchedFields(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"secret":{"name":"PORT","note":null,"valueType":"int"}}`))
	}))
	defer server.Close()

	valueType := "int"
	if _, err := New(server.URL, "xct_live_abc", "test-agent").UpdateMetadata(
		context.Background(), "acme", "web", "production", "PORT",
		MetadataUpdate{ValueType: &valueType},
	); err != nil {
		t.Fatal(err)
	}
	if _, present := body["note"]; present {
		t.Fatalf("an untouched note was sent: %+v", body)
	}
	if _, present := body["name"]; present {
		t.Fatalf("an untouched name was sent: %+v", body)
	}
}

func TestAuditPassesFiltersAndStopsAtTheLimit(t *testing.T) {
	var queries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data":[{"id":"1","action":"secret.revealed","outcome":"success","createdAt":"2026-08-01T00:00:00Z"}],
			"nextCursor":"opaque",
			"window":{"from":"2026-05-01T00:00:00Z","to":"2026-08-01T00:00:00Z"}
		}`))
	}))
	defer server.Close()

	page, err := New(server.URL, "xct_live_abc", "test-agent").Audit(
		context.Background(), "acme",
		AuditFilter{Action: "secret.revealed", Outcome: "denied", ProjectSlug: "web", Limit: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 1 {
		t.Fatalf("events = %+v", page.Events)
	}
	// One page was enough for the limit, so the cursor must not be followed.
	if len(queries) != 1 {
		t.Fatalf("requests = %d, want 1", len(queries))
	}
	if !page.Truncated {
		t.Error("a server that offered another page means the answer is partial")
	}
	if page.Window.From != "2026-05-01T00:00:00Z" {
		t.Errorf("window = %+v", page.Window)
	}
	for _, want := range []string{"action=secret.revealed", "outcome=denied", "projectSlug=web", "limit=1"} {
		if !strings.Contains(queries[0], want) {
			t.Errorf("query %q missing %q", queries[0], want)
		}
	}
}

func TestAuditOmitsEmptyFilters(t *testing.T) {
	var query string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[],"nextCursor":null,"window":{"from":"","to":""}}`))
	}))
	defer server.Close()

	if _, err := New(server.URL, "xct_live_abc", "test-agent").
		Audit(context.Background(), "acme", AuditFilter{}); err != nil {
		t.Fatal(err)
	}
	for _, absent := range []string{"action=", "outcome=", "projectSlug=", "from=", "to="} {
		if strings.Contains(query, absent) {
			t.Errorf("query %q carries an empty %q", query, absent)
		}
	}
}

func TestRevokeTokenAddressesTheRightKind(t *testing.T) {
	var path, method string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, method = r.URL.Path, r.Method
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	if err := New(server.URL, "xct_live_abc", "test-agent").
		RevokeToken(context.Background(), "acme", "service", "tok-1"); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodDelete || path != "/api/orgs/acme/tokens/service/tok-1" {
		t.Fatalf("%s %s", method, path)
	}
}

func TestDeleteProjectAlwaysConfirms(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	if err := New(server.URL, "xct_live_abc", "test-agent").
		DeleteProject(context.Background(), "acme", "web", "web"); err != nil {
		t.Fatal(err)
	}
	if body["confirm"] != "web" {
		t.Fatalf("body = %+v", body)
	}
}

func TestCreateEnvironmentOmitsDefaults(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"environment":{"name":"Preview","slug":"preview","isProduction":false}}`))
	}))
	defer server.Close()

	environment, err := New(server.URL, "xct_live_abc", "test-agent").
		CreateEnvironment(context.Background(), "acme", "web", "Preview", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if environment.Slug != "preview" {
		t.Fatalf("environment = %+v", environment)
	}
	// The server derives a slug from the name and defaults isProduction; sending
	// either as an empty value would be a different request.
	if _, present := body["slug"]; present {
		t.Errorf("an empty slug was sent: %+v", body)
	}
	if _, present := body["isProduction"]; present {
		t.Errorf("a false isProduction was sent: %+v", body)
	}
}

func TestExportAndPullAreDifferentPaths(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		_, _ = w.Write([]byte("A=1\n"))
	}))
	defer server.Close()

	client := New(server.URL, "xct_live_abc", "test-agent")
	if _, err := client.Pull(context.Background(), "acme", "web", "production", "env"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Export(context.Background(), "acme", "web", "production", "env"); err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 || !strings.HasSuffix(paths[0], "/pull") || !strings.HasSuffix(paths[1], "/export") {
		t.Fatalf("paths = %v — the audit record is told apart by the path", paths)
	}
}
