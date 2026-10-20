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

// The P19 wire contract: the resolved pull, the export policy in both of its
// spellings, the template declaration on every write that can carry one, the
// personal-override endpoints and the organisation's policies. As elsewhere in
// this package, each test pins the request this client builds and the response
// fields it reads.

// Every pull says the client can resolve, whatever the format and whatever the
// environment turns out to hold — a client that does not say so is refused by
// an environment that inherits or holds a template.
func TestPullAsksForTheResolvedBundle(t *testing.T) {
	var query string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		_, _ = io.WriteString(w, "A=1\n")
	}))
	defer server.Close()

	if _, err := New(server.URL, "xct_live_abc", "test-agent").
		Pull(context.Background(), "acme", "web", "dev", "env"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(query, "bundle=2") {
		t.Errorf("query = %q, want bundle=2", query)
	}
	if !strings.Contains(query, "format=env") {
		t.Errorf("query = %q lost the format", query)
	}
}

// A server-rendered document has nowhere to carry a policy field, so a
// server-mode pull says it in a header.
func TestPullReadsTheExportPolicyHeaderOfAServerModePull(t *testing.T) {
	for header, disabled := range map[string]bool{
		"disabled": true,
		"Disabled": true,
		"allowed":  false,
		"":         false,
		// A word this build has never heard of is not a refusal: turning it into
		// one would break `pull` against a server for having added a state.
		"audited": false,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if header != "" {
				w.Header().Set(PlaintextExportHeader, header)
			}
			_, _ = io.WriteString(w, "A=1\n")
		}))
		pulled, err := New(server.URL, "xct_live_abc", "test-agent").
			Pull(context.Background(), "acme", "web", "dev", "env")
		server.Close()
		if err != nil {
			t.Fatal(err)
		}
		if pulled.ExportDisabled() != disabled {
			t.Errorf("header %q: ExportDisabled = %v, want %v", header, pulled.ExportDisabled(), disabled)
		}
	}
}

// The version 2 shape, as apps/web serves it.
func TestPullReadsAVersionTwoBundle(t *testing.T) {
	pulled := pullOnce(t, `{
		"bundle": true, "bundleVersion": 2, "encryptionMode": "e2ee",
		"keys": {"encryptionMode":"e2ee","environmentId":"env-staging","activeEdk":{"id":"k1","version":1}},
		"environment": {"id":"env-staging","projectSlug":"api","slug":"staging","parentEnvironmentId":"env-base"},
		"secrets": [{"id":"s1","name":"HOST","ciphertext":"xk2.gcm.x","version":1}],
		"layers": [
			{"environmentId":"env-base","projectSlug":"api","environmentSlug":"base","parentEnvironmentId":null,
			 "keys":{"encryptionMode":"e2ee","environmentId":"env-base","activeEdk":{"id":"k2","version":3},
			         "myGrant":{"edkSealed":"xk2.x25519.a","ehkSealed":"xk2.x25519.b"}},
			 "secrets":[{"id":"s2","name":"URL","ciphertext":"xk2.gcm.y","version":2,"template":true,
			             "references":[{"name":"HOST","environmentId":null},
			                           {"environment":"shared","name":"DB","environmentId":"env-shared"}]}]},
			{"environmentId":"env-root","projectSlug":"api","environmentSlug":"root","parentEnvironmentId":null,
			 "keys":null,"secrets":[]}
		],
		"policy": {"plaintextExport":"disabled"}
	}`)

	bundle := pulled.Bundle
	if bundle == nil || bundle.BundleVersion != 2 {
		t.Fatalf("bundle = %+v", bundle)
	}
	if bundle.Environment == nil || bundle.Environment.ID != "env-staging" ||
		bundle.Environment.ParentEnvironmentID == nil || *bundle.Environment.ParentEnvironmentID != "env-base" {
		t.Fatalf("environment = %+v", bundle.Environment)
	}
	if len(bundle.Layers) != 2 {
		t.Fatalf("layers = %+v", bundle.Layers)
	}

	base := bundle.Layers[0]
	if base.Keys == nil || base.Keys.ActiveEDK.Version != 3 || base.Keys.MyGrant == nil {
		t.Fatalf("base keys = %+v", base.Keys)
	}
	url := base.Secrets[0]
	if !url.Template || len(url.References) != 2 {
		t.Fatalf("URL = %+v", url)
	}
	if url.References[0].EnvironmentID != nil {
		t.Errorf("an unqualified reference came back with a target: %v", *url.References[0].EnvironmentID)
	}
	if target := url.References[1].EnvironmentID; target == nil || *target != "env-shared" {
		t.Errorf("a qualified reference lost its target: %v", target)
	}

	if root := bundle.Layers[1]; root.Keys != nil || len(root.Secrets) != 0 {
		t.Errorf("a keyless layer = %+v", root)
	}
	if !pulled.ExportDisabled() {
		t.Error("a bundle whose policy disables export reads as allowed")
	}
}

// Review round 1, M1: a layer that contributes values and disables export
// refuses the output — named — even from a server that sent only the
// per-environment answers and an "allowed" effective policy; a layer carried
// only to walk the chain does not.
func TestExportPolicyIsAskedOfEveryContributingLayer(t *testing.T) {
	bundle := func(effective, ownPolicy, contributing, walkedOnly string) string {
		return `{"bundle":true,"bundleVersion":2,"encryptionMode":"e2ee",
			"keys":{"encryptionMode":"e2ee","environmentId":"env-staging","activeEdk":{"id":"k1","version":1}},
			"environment":{"id":"env-staging","projectSlug":"api","slug":"staging","parentEnvironmentId":"env-prod",
			               "policy":{"plaintextExport":"` + ownPolicy + `"}},
			"secrets":[],
			"layers":[
				{"environmentId":"env-prod","projectSlug":"api","environmentSlug":"production","parentEnvironmentId":null,
				 "keys":{"encryptionMode":"e2ee","environmentId":"env-prod","activeEdk":{"id":"k2","version":1}},
				 "secrets":[{"id":"s1","name":"DB_PASSWORD","ciphertext":"xk2.gcm.x","version":1}],
				 "policy":{"plaintextExport":"` + contributing + `"}},
				{"environmentId":"env-root","projectSlug":"api","environmentSlug":"root","parentEnvironmentId":null,
				 "keys":null,"secrets":[],"policy":{"plaintextExport":"` + walkedOnly + `"}}
			],
			"policy":{"plaintextExport":"` + effective + `"}}`
	}

	refused := pullOnce(t, bundle("allowed", "allowed", "disabled", "allowed"))
	if !refused.ExportDisabled() {
		t.Error("a contributing layer that disables export was ignored")
	}
	if got := refused.ExportRefusedBy(); len(got) != 1 || got[0] != "api/production" {
		t.Errorf("ExportRefusedBy = %v, want [api/production]", got)
	}

	walked := pullOnce(t, bundle("allowed", "allowed", "allowed", "disabled"))
	if walked.ExportDisabled() || len(walked.ExportRefusedBy()) != 0 {
		t.Errorf("a layer that contributes nothing refused the export: %v", walked.ExportRefusedBy())
	}

	own := pullOnce(t, bundle("disabled", "disabled", "allowed", "allowed"))
	if got := own.ExportRefusedBy(); !own.ExportDisabled() || len(got) != 1 || got[0] != "api/staging" {
		t.Errorf("the environment's own refusal: disabled=%v by=%v", own.ExportDisabled(), got)
	}
}

// A server that predates the policy says nothing, which is "allowed".
func TestABundleWithNoPolicyAllowsExport(t *testing.T) {
	pulled := pullOnce(t, `{"bundle":true,"bundleVersion":1,"encryptionMode":"e2ee",
		"keys":{"encryptionMode":"e2ee","environmentId":"env-1","activeEdk":{"id":"k1","version":1}},
		"secrets":[]}`)
	if pulled.ExportDisabled() {
		t.Error("an absent policy refused an export")
	}
}

func recordingServer(t *testing.T, response string, captured *map[string]any) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		*captured = body
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(server.Close)
	return server
}

// A template's write declares its references — the text's parts and nothing the
// server works out, so no environmentId — and every other write declares none.
// The server refuses both mistakes, so both directions are pinned here.
func TestWritesDeclareReferencesOnlyForATemplate(t *testing.T) {
	declared := []ReferenceDeclaration{
		{Name: "HOST"},
		{Environment: "shared", Name: "DB"},
		{Project: "core", Environment: "prod", Name: "KEY"},
	}
	value := ClientValue{Ciphertext: "xk2.gcm.AAAA", ClientAlgorithm: "xk2.gcm"}

	writes := map[string]func(*Client, []ReferenceDeclaration) error{
		"create": func(c *Client, references []ReferenceDeclaration) error {
			_, err := c.CreateClientSecret(context.Background(), "acme", "web", "dev",
				"018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e53", "URL", value, "template", nil, references)
			return err
		},
		"update": func(c *Client, references []ReferenceDeclaration) error {
			_, err := c.UpdateClientSecret(context.Background(), "acme", "web", "dev", "URL", value, 2, "", references)
			return err
		},
		"restore": func(c *Client, references []ReferenceDeclaration) error {
			_, err := c.RestoreClientSecret(context.Background(), "acme", "web", "dev", "URL", 1, value, 3, references)
			return err
		},
	}

	for name, write := range writes {
		var body map[string]any
		server := recordingServer(t, `{"secret":{"name":"URL","version":2,"status":"changed"}}`, &body)
		client := New(server.URL, "xct_live_abc", "test-agent")

		if err := write(client, declared); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		sent, ok := body["references"].([]any)
		if !ok || len(sent) != 3 {
			t.Fatalf("%s: references = %#v", name, body["references"])
		}
		first, _ := sent[0].(map[string]any)
		if _, has := first["environment"]; has {
			t.Errorf("%s: an unqualified reference was sent with an environment: %v", name, first)
		}
		for _, entry := range sent {
			if _, has := entry.(map[string]any)["environmentId"]; has {
				t.Errorf("%s: a write told the server the target it resolves itself: %v", name, entry)
			}
		}
		if third, _ := sent[2].(map[string]any); third["project"] != "core" || third["environment"] != "prod" {
			t.Errorf("%s: the qualified reference = %v", name, third)
		}

		// A template that references nothing still says so — as an empty array.
		if err := write(client, []ReferenceDeclaration{}); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if empty, ok := body["references"].([]any); !ok || len(empty) != 0 {
			t.Errorf("%s: an empty declaration = %#v, want []", name, body["references"])
		}

		// And a value that is not a template sends no key at all.
		if err := write(client, nil); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, has := body["references"]; has {
			t.Errorf("%s: a plain write declared references: %v", name, body["references"])
		}
	}
}

func TestOverrideEndpoints(t *testing.T) {
	type request struct{ method, path, body string }
	var seen []request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		seen = append(seen, request{r.Method, r.URL.Path, string(raw)})
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			_, _ = io.WriteString(w, `{"overrides":[{"name":"DB_URL","ciphertext":"xk2.x25519.abc","updatedAt":"2026-10-01T00:00:00Z"}]}`)
		case http.MethodPut:
			_, _ = io.WriteString(w, `{"override":{"name":"DB_URL","updatedAt":"2026-10-02T00:00:00Z","created":true}}`)
		case http.MethodDelete:
			_, _ = io.WriteString(w, `{"override":{"name":"DB_URL","deleted":true}}`)
		}
	}))
	defer server.Close()
	client := New(server.URL, "xct_live_abc", "test-agent")
	ctx := context.Background()

	overrides, err := client.Overrides(ctx, "acme", "web", "dev")
	if err != nil {
		t.Fatal(err)
	}
	if len(overrides) != 1 || overrides[0].Name != "DB_URL" || overrides[0].Ciphertext != "xk2.x25519.abc" {
		t.Fatalf("overrides = %+v", overrides)
	}

	written, err := client.SetOverride(ctx, "acme", "web", "dev", "DB_URL", "xk2.x25519.def")
	if err != nil {
		t.Fatal(err)
	}
	if !written.Created || written.Name != "DB_URL" {
		t.Fatalf("written = %+v", written)
	}

	if err := client.DeleteOverride(ctx, "acme", "web", "dev", "DB_URL"); err != nil {
		t.Fatal(err)
	}

	want := []request{
		{http.MethodGet, "/api/orgs/acme/projects/web/environments/dev/overrides", ""},
		{http.MethodPut, "/api/orgs/acme/projects/web/environments/dev/overrides/DB_URL", `{"ciphertext":"xk2.x25519.def"}`},
		{http.MethodDelete, "/api/orgs/acme/projects/web/environments/dev/overrides/DB_URL", ""},
	}
	if len(seen) != len(want) {
		t.Fatalf("requests = %+v", seen)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Errorf("request %d = %+v, want %+v", i, seen[i], want[i])
		}
	}
}

func TestPoliciesReadsTheSecretsHalf(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"tokens":{"requireIpAllowlist":true,"maxLifetimeDays":30},
			"secrets":{"enabled":true,"scope":"production","namePattern":"[A-Z_]+","minValueEntropyBits":64,
			           "entropyAppliesTo":["TOKEN"],"forbiddenSubstrings":["changeme"]},
			"somethingNew":{"x":1}
		}`)
	}))
	defer server.Close()

	policies, err := New(server.URL, "xct_live_abc", "test-agent").Policies(context.Background(), "acme")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/api/orgs/acme/policies" {
		t.Errorf("path = %q", path)
	}
	secrets := policies.Secrets
	if !secrets.Enabled || secrets.Scope != "production" || secrets.MinValueEntropyBits == nil ||
		*secrets.MinValueEntropyBits != 64 || len(secrets.ForbiddenSubstrings) != 1 {
		t.Fatalf("secrets = %+v", secrets)
	}
}

func TestKeyStateReadsWhetherTheEnvironmentIsProduction(t *testing.T) {
	server := pullServer(t, `{"keys":{"encryptionMode":"e2ee","environmentId":"env-1","isProduction":true}}`)
	defer server.Close()

	keys, err := New(server.URL, "xct_live_abc", "test-agent").
		EnvironmentKeyState(context.Background(), "acme", "web", "production")
	if err != nil {
		t.Fatal(err)
	}
	if !keys.IsProduction {
		t.Error("isProduction was not read")
	}
}
