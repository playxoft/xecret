package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/e2ee"
)

// An environment whose policy disables a plaintext export (P19 §3) refuses
// `pull` and `export` — in either encryption mode, with nothing written and
// nothing printed to stdout — and leaves `run` alone.

const disabledMessage = "plaintext export is disabled for web/dev by its environment policy; an owner or admin " +
	"of the organisation can change it in the environment's settings. 'xecret run' is unaffected."

func outFile(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "secrets.env")
}

func assertNotWritten(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("%s exists after a refused export", path)
	}
}

func TestPullRefusesAnE2eeEnvironmentWhosePolicyDisablesExport(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.reply(http.MethodGet, "/pull", http.StatusOK,
		w.bundle("disabled", w.row(worldSecretID, "DATABASE_URL", sharedURL, 1)))

	path := outFile(t)
	for _, args := range [][]string{withScope("-o", path), withScope()} {
		stdout, _, err := captured(t, func() error { return cmdPull(args) })
		if err == nil || err.Error() != disabledMessage {
			t.Fatalf("pull %v: err = %v", args, err)
		}
		if stdout != "" {
			t.Errorf("pull %v printed to stdout after refusing: %q", args, stdout)
		}
	}
	assertNotWritten(t, path)
	// Refused before anything was decrypted: no principal was ever opened.
	if fake.any("/api/auth/vault") {
		t.Error("a refused pull opened the vault")
	}
}

func TestPullRefusesAServerModeEnvironmentWhoseHeaderDisablesExport(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.handle(http.MethodGet, "/pull", func(rw http.ResponseWriter, _ *http.Request, _ []byte) {
		rw.Header().Set(api.PlaintextExportHeader, "disabled")
		_, _ = rw.Write([]byte("DATABASE_URL=" + sharedURL + "\n"))
	})

	path := outFile(t)
	stdout, stderr, err := captured(t, func() error { return cmdPull(withScope("-o", path)) })
	if err == nil || err.Error() != disabledMessage {
		t.Fatalf("err = %v", err)
	}
	assertNotWritten(t, path)
	if strings.Contains(stdout+stderr, sharedURL) {
		t.Error("the document the server sent reached the terminal")
	}
}

func TestExportRefusesAServerModeEnvironmentThePolicyDisables(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.refuse(http.MethodGet, "/export", http.StatusForbidden, "forbidden",
		"export_disabled: this environment's policy disables plaintext export.")

	path := outFile(t)
	_, _, err := captured(t, func() error { return cmdExport(withScope("-o", path)) })
	if err == nil || err.Error() != disabledMessage {
		t.Fatalf("err = %v", err)
	}
	assertNotWritten(t, path)
	// The refusal is this CLI's sentence, not the 403's — whose hint would send
	// somebody to ask for access they already have.
	if _, isAPI := api.AsError(err); isAPI {
		t.Error("the refusal is still the server's error, and will collect its access hint")
	}
}

func TestExportRefusesAnE2eeEnvironmentThePolicyDisables(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.refuse(http.MethodGet, "/export", http.StatusConflict, "conflict",
		"client_side_only: this environment is end-to-end encrypted.")
	fake.reply(http.MethodGet, "/pull", http.StatusOK,
		w.bundle("disabled", w.row(worldSecretID, "DATABASE_URL", sharedURL, 1)))

	path := outFile(t)
	_, _, err := captured(t, func() error { return cmdExport(withScope("-o", path)) })
	if err == nil || err.Error() != disabledMessage {
		t.Fatalf("err = %v", err)
	}
	assertNotWritten(t, path)
	if fake.any("/api/auth/vault") {
		t.Error("a refused export opened the vault")
	}
}

// resolvedBundle is a version 2 bundle of web/dev that inherits from
// web/production, with each environment's own export setting and the
// effective one the server works out. Refused before anything is decrypted, so
// the parent's layer needs no key that opens anything.
func (w *world) resolvedBundle(effective, own, parent string, rows ...api.ClientSecret) []byte {
	w.t.Helper()
	parentID := "018f3b2c-9c1a-7c3d-8e4f-3a00000000f0"
	document := map[string]any{
		"bundle": true, "bundleVersion": 2, "encryptionMode": "e2ee",
		"keys": w.keyState(false)["keys"], "secrets": rows,
		"environment": map[string]any{
			"id": worldEnvID, "projectSlug": "web", "slug": "dev", "parentEnvironmentId": parentID,
			"policy": map[string]any{"plaintextExport": own},
		},
		"layers": []any{map[string]any{
			"environmentId": parentID, "projectSlug": "web", "environmentSlug": "production",
			"parentEnvironmentId": nil,
			"keys": map[string]any{
				"encryptionMode": "e2ee", "environmentId": parentID,
				"activeEdk": map[string]any{"id": worldEdkID, "version": 1},
				"myGrant":   map[string]any{"edkSealed": w.grant.EDKSealed, "ehkSealed": w.grant.EHKSealed},
			},
			"secrets": []api.ClientSecret{w.row("018f3b2c-9c1a-7c3d-8e4f-3a00000000f1", "DB_PASSWORD", "hunter2-production", 1)},
			"policy":  map[string]any{"plaintextExport": parent},
		}},
		"policy": map[string]any{"plaintextExport": effective},
	}
	raw, err := json.Marshal(document)
	if err != nil {
		w.t.Fatal(err)
	}
	return raw
}

// Review round 1, M1: a resolved pull of dev, which inherits production's
// values, is refused when production disables export — and the refusal names
// production, whose admins can change it, rather than dev, whose setting is
// already "allowed".
func TestPullRefusesAResolvedBundleWhoseParentDisablesExport(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.reply(http.MethodGet, "/pull", http.StatusOK,
		w.resolvedBundle("disabled", "allowed", "disabled", w.row(worldSecretID, "LOG_LEVEL", "debug", 1)))

	path := outFile(t)
	stdout, _, err := captured(t, func() error { return cmdPull(withScope("--format", "env", "-o", path)) })
	want := "plaintext export is disabled for web/dev: it reads values from web/production, whose " +
		"environment policy disables plaintext export; an owner or admin of the organisation can " +
		"change it in that environment's settings. 'xecret run' is unaffected."
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v", err)
	}
	if stdout != "" {
		t.Errorf("a refused pull printed %q", stdout)
	}
	assertNotWritten(t, path)
	if fake.any("/api/auth/vault") {
		t.Error("a refused pull opened the vault")
	}
}

// The environment's own refusal still reads as its own, whatever its layers say.
func TestAResolvedBundleRefusedByItsOwnPolicyNamesItself(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.reply(http.MethodGet, "/pull", http.StatusOK,
		w.resolvedBundle("disabled", "disabled", "allowed", w.row(worldSecretID, "LOG_LEVEL", "debug", 1)))

	_, _, err := captured(t, func() error { return cmdPull(withScope("--format", "env", "-o", outFile(t))) })
	if err == nil || err.Error() != disabledMessage {
		t.Fatalf("err = %v", err)
	}
}

// The allowed case is unchanged — and the person pulling is told about the
// overrides the document does not contain.
func TestAnAllowedPullStillWritesAndMentionsOverrides(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.reply(http.MethodGet, "/pull", http.StatusOK,
		w.bundle("allowed", w.row(worldSecretID, "DATABASE_URL", sharedURL, 1)))
	fake.reply(http.MethodGet, "/overrides", http.StatusOK, map[string]any{"overrides": []api.PersonalOverride{
		w.override(w.publicKey, "DATABASE_URL", "postgres://localhost/mine"),
	}})

	path := outFile(t)
	_, stderr, err := captured(t, func() error { return cmdPull(withScope("-o", path)) })
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), sharedURL) {
		t.Errorf("the document = %q", written)
	}
	if strings.Contains(string(written), "localhost/mine") {
		t.Error("a pull applied a personal override")
	}
	if !strings.Contains(stderr, "1 personal override(s) are set for this environment and are not in this output") {
		t.Errorf("the pull did not mention the override: %q", stderr)
	}
}

func TestTheOverrideNoteIsBestEffortAndNeverAsksUnderAToken(t *testing.T) {
	fake := newFakeAPI(t)
	fake.refuse(http.MethodGet, "/overrides", http.StatusInternalServerError, "internal_error", "boom")
	client := api.New(fake.URL(), "xct_live_abc", userAgent())
	resolved := scope{Org: "acme", Project: "web", Environment: "dev"}

	t.Setenv("XECRET_TOKEN", "")
	a, warnings := testApp(t)
	a.noteUnappliedOverrides(context.Background(), client, resolved)
	if warnings.Len() != 0 {
		t.Errorf("a failed listing printed something: %q", warnings.String())
	}

	t.Setenv("XECRET_TOKEN", "xst_live_"+strings.Repeat("A", 43))
	before := len(fake.sent(http.MethodGet, "/overrides"))
	a.noteUnappliedOverrides(context.Background(), client, resolved)
	if len(fake.sent(http.MethodGet, "/overrides")) != before {
		t.Error("the overrides listing was requested under XECRET_TOKEN")
	}
}

// `run` reads through the same pull, and the policy is not its business.
func TestRunIsUnaffectedByADisabledExport(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.reply(http.MethodGet, "/pull", http.StatusOK,
		w.bundle("disabled", w.row(worldSecretID, "DATABASE_URL", sharedURL, 1)))
	fake.reply(http.MethodGet, "/overrides", http.StatusOK, map[string]any{"overrides": []any{}})
	a, _ := testApp(t)

	secrets, err := fetchFor(t, a, fake)
	if err != nil {
		t.Fatalf("run against a disabled-export environment: %v", err)
	}
	if secrets["DATABASE_URL"] != sharedURL {
		t.Fatalf("DATABASE_URL = %q", secrets["DATABASE_URL"])
	}
}
