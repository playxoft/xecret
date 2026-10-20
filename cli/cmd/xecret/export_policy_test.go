package main

import (
	"context"
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
