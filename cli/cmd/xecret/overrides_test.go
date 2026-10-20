package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cache"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/envkeys"
)

// Personal overrides: the command that manages them, and `run`, the one place
// that applies them.

const sharedURL = "postgres://shared.internal/app"

// runWorld is a logged-in machine whose environment holds one shared secret,
// with the pull answered.
func runWorld(t *testing.T) (*world, *fakeAPI, *app, *bytes.Buffer) {
	t.Helper()
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.reply(http.MethodGet, "/pull", http.StatusOK, w.bundle("", w.row(worldSecretID, "DATABASE_URL", sharedURL, 1)))
	a, warnings := testApp(t)
	return w, fake, a, warnings
}

// fetchFor runs the online half of `run` against the fake API, as the login
// the harness stored.
func fetchFor(t *testing.T, a *app, fake *fakeAPI) (map[string]string, error) {
	t.Helper()
	credentials, err := cred.Load(a.store)
	if err != nil {
		t.Fatalf("loading the stored login: %v", err)
	}
	resolved := scope{Org: "acme", Project: "web", Environment: "dev"}
	return fetchSecrets(a, api.New(fake.URL(), credentials.Token, userAgent()), credentials, resolved,
		cacheScope(credentials, resolved), cachePolicy{noCache: true, maxAge: cache.DefaultMaxAge})
}

func TestRunAppliesPersonalOverridesOverTheResolvedEnvironment(t *testing.T) {
	w, fake, a, warnings := runWorld(t)
	fake.reply(http.MethodGet, "/overrides", http.StatusOK, map[string]any{"overrides": []api.PersonalOverride{
		w.override(w.privateKey, "DATABASE_URL", "postgres://localhost/mine"),
		w.override(w.privateKey, "LOCAL_ONLY", "debug-on"),
	}})

	secrets, err := fetchFor(t, a, fake)
	if err != nil {
		t.Fatalf("fetchSecrets: %v", err)
	}
	if secrets["DATABASE_URL"] != "postgres://localhost/mine" || secrets["LOCAL_ONLY"] != "debug-on" {
		t.Fatalf("the overrides were not applied: DATABASE_URL=%q LOCAL_ONLY=%q",
			secrets["DATABASE_URL"], secrets["LOCAL_ONLY"])
	}

	said := warnings.String()
	if !strings.Contains(said, "applied 2 personal override(s): DATABASE_URL, LOCAL_ONLY") {
		t.Errorf("the run did not say which overrides it applied: %q", said)
	}
	for _, value := range []string{"localhost/mine", "debug-on", sharedURL} {
		if strings.Contains(said, value) {
			t.Errorf("a value reached stderr (%q): %q", value, said)
		}
	}
}

// A vault reset gives the account a new keypair, and an override sealed to the
// old one stops opening. Falling back to the shared value would hand the process
// exactly what its owner set the override to avoid.
func TestAnOverrideThatWillNotOpenStopsTheRun(t *testing.T) {
	w, fake, a, _ := runWorld(t)
	stale, err := e2ee.GenerateEncryptionKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	fake.reply(http.MethodGet, "/overrides", http.StatusOK, map[string]any{"overrides": []api.PersonalOverride{
		w.override(stale.PrivateKey, "DATABASE_URL", "postgres://localhost/old-key"),
	}})

	secrets, err := fetchFor(t, a, fake)
	if err == nil {
		t.Fatalf("an unopenable override fell back to the shared value: %v", secrets)
	}
	message := err.Error()
	if !strings.Contains(message, "xecret overrides unset DATABASE_URL") {
		t.Errorf("the error does not name the remedy: %s", message)
	}
	if strings.Contains(message, "old-key") || strings.Contains(message, sharedURL) {
		t.Errorf("the error carries a value: %s", message)
	}
}

// A server that predates overrides answers the route with a 404. The pull that
// just succeeded proves the environment exists, so that is "none", said once.
func TestAServerWithoutOverridesWarnsAndRuns(t *testing.T) {
	_, fake, a, warnings := runWorld(t)
	fake.handle(http.MethodGet, "/overrides", func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		// What a framework's own 404 looks like: no envelope at all.
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("<html>not found</html>"))
	})

	secrets, err := fetchFor(t, a, fake)
	if err != nil {
		t.Fatalf("fetchSecrets: %v", err)
	}
	if secrets["DATABASE_URL"] != sharedURL {
		t.Fatalf("DATABASE_URL = %q", secrets["DATABASE_URL"])
	}
	if said := warnings.String(); strings.Count(said, "does not support personal overrides") != 1 {
		t.Errorf("the 404 should be one warning: %q", said)
	}
}

// Anything else stops the run: the caller may have overrides this process could
// not read, and running without them is the silent fallback by another road.
func TestAnOverridesFailureOtherThanAnOldServerStopsTheRun(t *testing.T) {
	_, fake, a, _ := runWorld(t)
	fake.refuse(http.MethodGet, "/overrides", http.StatusInternalServerError, "internal_error", "boom")

	if _, err := fetchFor(t, a, fake); err == nil || !strings.Contains(err.Error(), "personal overrides") {
		t.Fatalf("err = %v, want the run refused", err)
	}
}

// An override is a sealed box, and a sealed box says who it is for, not who made
// it. The names through which a value becomes code are refused rather than
// injected, whoever sealed them.
func TestAnOverrideForAReservedNameIsRefused(t *testing.T) {
	w, fake, a, _ := runWorld(t)
	fake.reply(http.MethodGet, "/overrides", http.StatusOK, map[string]any{"overrides": []api.PersonalOverride{
		w.override(w.privateKey, "LD_PRELOAD", "/tmp/evil.so"),
	}})

	if _, err := fetchFor(t, a, fake); err == nil || !strings.Contains(err.Error(), "LD_PRELOAD") {
		t.Fatalf("err = %v, want LD_PRELOAD refused", err)
	}
}

// Nobody with no overrides pays for a principal: the listing is the only extra
// request, and an empty one ends the step.
func TestNoOverridesCostsOneRequest(t *testing.T) {
	_, fake, a, warnings := runWorld(t)
	fake.reply(http.MethodGet, "/overrides", http.StatusOK, map[string]any{"overrides": []any{}})

	if _, err := fetchFor(t, a, fake); err != nil {
		t.Fatal(err)
	}
	if got := len(fake.sent(http.MethodGet, "/api/auth/vault")); got != 1 {
		t.Errorf("the vault was read %d times, want once — for the bundle, not for an empty listing", got)
	}
	if strings.Contains(warnings.String(), "applied") {
		t.Errorf("an empty listing announced overrides: %q", warnings.String())
	}
}

// CI never asks. A service token has no overrides, the route would refuse it,
// and a CI run's environment is the shared one by definition.
func TestAServiceTokenRunNeverCallsTheOverridesEndpoint(t *testing.T) {
	w := newWorld(t, e2ee.RecipientToken)
	fake := newFakeAPI(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XECRET_KEYRING", "file")
	t.Setenv("XECRET_TOKEN", w.token)

	fake.reply(http.MethodGet, "/pull", http.StatusOK, w.bundle("", w.row(worldSecretID, "DATABASE_URL", sharedURL, 1)))
	fake.handle(http.MethodGet, "/overrides", func(rw http.ResponseWriter, _ *http.Request, _ []byte) {
		t.Error("a service-token run asked for personal overrides")
		writeJSON(rw, http.StatusForbidden, map[string]any{"error": map[string]any{"code": "forbidden"}})
	})

	a, _ := testApp(t)
	a.tokenScope = &api.TokenSelf{
		Token:        api.TokenPin{ID: worldTokenID, Name: "ci", AccessLevel: "read"},
		Organization: api.NamedSlug{ID: worldOrgID, Slug: "acme"},
		Project:      api.NamedSlug{Slug: "web"},
		Environment:  api.PinnedEnvironment{Slug: "dev"},
	}
	credentials := &cred.Credentials{APIURL: fake.URL(), Token: authHalfOf(w.token), OrgSlug: "acme"}
	resolved := scope{Org: "acme", Project: "web", Environment: "dev"}

	secrets, err := fetchSecrets(a, api.New(fake.URL(), credentials.Token, userAgent()), credentials,
		resolved, cacheScope(credentials, resolved), cachePolicy{noCache: true})
	if err != nil {
		t.Fatalf("fetchSecrets: %v", err)
	}
	if secrets["DATABASE_URL"] != sharedURL {
		t.Fatalf("DATABASE_URL = %q", secrets["DATABASE_URL"])
	}
	if fake.any("/overrides") {
		t.Fatal("the overrides endpoint was called under XECRET_TOKEN")
	}
}

// Offline there is no way to know whether there is anything to apply, so the
// run says it applied nothing.
func TestAnOfflineRunSaysOverridesAreNotApplied(t *testing.T) {
	fixture := newE2eeFixture(t)
	h := newOfflineHarness(t, fixture)
	if err := envkeys.StoreVaultWraps(h.app.store, fixture.material); err != nil {
		t.Fatal(err)
	}
	if err := cache.WriteBundle(h.app.store, h.encryptedScope(), fixture.bundle, time.Now()); err != nil {
		t.Fatal(err)
	}

	if _, err := h.fetch(cachePolicy{offline: true, maxAge: cache.DefaultMaxAge}); err != nil {
		t.Fatalf("--offline: %v", err)
	}
	if !strings.Contains(h.warnings.String(), "personal overrides are not applied") {
		t.Errorf("the offline run did not say overrides were skipped: %q", h.warnings.String())
	}
}

// ── xecret overrides ──

func TestOverridesSetSealsToTheCallersOwnKey(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.reply(http.MethodGet, "/keys", http.StatusOK, w.keyState(false))
	fake.reply(http.MethodPut, "/overrides/DATABASE_URL", http.StatusOK, map[string]any{
		"override": map[string]any{"name": "DATABASE_URL", "updatedAt": "2026-10-20T00:00:00Z", "created": true},
	})

	const mine = "postgres://localhost/only-mine"
	_, stderr, err := captured(t, func() error {
		return overridesSet(withScope("DATABASE_URL", "--from-file", valueFile(t, mine)))
	})
	if err != nil {
		t.Fatalf("overrides set: %v", err)
	}

	puts := fake.sent(http.MethodPut, "/overrides/DATABASE_URL")
	if len(puts) != 1 {
		t.Fatalf("PUTs = %d", len(puts))
	}
	var body struct {
		Ciphertext string `json:"ciphertext"`
	}
	if err := json.Unmarshal(puts[0].body, &body); err != nil {
		t.Fatal(err)
	}

	// The owner opens it with their own private key, under this row's AAD —
	// which is the whole claim: sealed to them, bound to this row.
	opened, err := e2ee.OpenOverrideValue(w.privateKey, e2ee.OverrideContext{
		OrgID: worldOrgID, EnvironmentID: worldEnvID, UserID: worldUserID, Name: "DATABASE_URL",
	}, body.Ciphertext)
	if err != nil {
		t.Fatalf("the sealed override does not open for its owner: %v", err)
	}
	if opened != mine {
		t.Fatalf("opened %q", opened)
	}

	if strings.Contains(fake.everything(), "only-mine") {
		t.Error("the plaintext left the process")
	}
	if strings.Contains(stderr, "only-mine") {
		t.Errorf("the value reached stderr: %q", stderr)
	}
}

// The value is never an argument: it would land in shell history and in every
// process listing on the machine. `-` is the one second word accepted.
func TestOverridesSetRefusesAValueOnTheCommandLine(t *testing.T) {
	t.Setenv("XECRET_TOKEN", "")
	err := overridesSet(withScope("DATABASE_URL", "postgres://typed-on-the-command-line"))
	if err == nil {
		t.Fatal("a value on the command line was accepted")
	}
	if strings.Contains(err.Error(), "typed-on-the-command-line") {
		t.Errorf("the refusal echoes the value: %v", err)
	}
	if !strings.Contains(err.Error(), "overrides set DATABASE_URL -") {
		t.Errorf("the refusal does not show the form that works: %v", err)
	}
}

func TestOverridesRefuseAServiceTokenBeforeAnyRequest(t *testing.T) {
	fake := newFakeAPI(t)
	t.Setenv("XECRET_TOKEN", "xst_live_"+strings.Repeat("A", 43))
	t.Setenv("XECRET_API_URL", fake.URL())

	for name, command := range map[string]func() error{
		"list":  func() error { return overridesList(scopeFlags) },
		"set":   func() error { return overridesSet(withScope("DATABASE_URL", "-")) },
		"unset": func() error { return overridesUnset(withScope("DATABASE_URL")) },
	} {
		if err := command(); !errors.Is(err, errOverridesNeedAPerson) {
			t.Errorf("%s under XECRET_TOKEN: err = %v", name, err)
		}
	}
	if fake.any("/") {
		t.Error("an overrides command made a request under XECRET_TOKEN")
	}
}

func TestOverridesListShowsNamesAndNeverValues(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.reply(http.MethodGet, "/overrides", http.StatusOK, map[string]any{"overrides": []api.PersonalOverride{
		w.override(w.privateKey, "DATABASE_URL", "postgres://localhost/mine"),
	}})

	stdout, _, err := captured(t, func() error { return overridesList(withScope("--json")) })
	if err != nil {
		t.Fatalf("overrides list: %v", err)
	}
	var listing []map[string]string
	if err := json.Unmarshal([]byte(stdout), &listing); err != nil {
		t.Fatalf("the JSON listing does not parse: %v\n%s", err, stdout)
	}
	if len(listing) != 1 || listing[0]["name"] != "DATABASE_URL" || listing[0]["updatedAt"] == "" {
		t.Fatalf("listing = %v", listing)
	}
	if _, present := listing[0]["ciphertext"]; present {
		t.Error("the listing carries the ciphertext")
	}
	if fake.any("/api/auth/vault") {
		t.Error("listing names opened a principal it has no use for")
	}
}

func TestOverridesUnsetSaysWhenThereIsNone(t *testing.T) {
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.refuse(http.MethodDelete, "/overrides/DATABASE_URL", http.StatusNotFound, "not_found", "No such override.")

	_, _, err := captured(t, func() error { return overridesUnset(withScope("DATABASE_URL")) })
	if err == nil || !strings.Contains(err.Error(), "no personal override for DATABASE_URL") {
		t.Fatalf("err = %v", err)
	}
}

func TestOverridesAreDispatchedAndDocumented(t *testing.T) {
	if code := dispatch([]string{"overrides", "--help"}); code != 0 {
		t.Errorf("'xecret overrides --help' exited %d", code)
	}
	if !strings.Contains(usage, "overrides") {
		t.Error("'xecret help' does not list overrides")
	}
}
