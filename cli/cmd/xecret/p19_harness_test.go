package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/envkeys"
	"github.com/playxoft/xecret/cli/internal/keyring"
	"github.com/playxoft/xecret/cli/internal/output"
)

// The harness the P19 command tests share: one end-to-end encrypted environment
// built in memory, a fake API that records every request it is sent, and a way
// to run a command and read what it printed.
//
// The world keeps every key it made, unlike newE2eeFixture, because these tests
// have to do the server's half too — answer a reveal with a ciphertext of a
// chosen version, or seal an override to the caller — and to check what the
// client sent, by opening it.

const (
	worldUserID   = "018f3b2c-9c1a-7c3d-8e4f-3a0000000001"
	worldOrgID    = "018f3b2c-9c1a-7c3d-8e4f-3a0000000002"
	worldEnvID    = "018f3b2c-9c1a-7c3d-8e4f-3a0000000003"
	worldEdkID    = "018f3b2c-9c1a-7c3d-8e4f-3a0000000004"
	worldTokenID  = "018f3b2c-9c1a-7c3d-8e4f-3a0000000005"
	worldSecretID = "018f3b2c-9c1a-7c3d-8e4f-3a0000000010"
)

// world is one environment, the member who reads it, and everything either
// side of the wire would hold.
type world struct {
	t          *testing.T
	recipient  e2ee.RecipientKind
	privateKey []byte
	publicKey  []byte
	userKey    []byte
	keys       e2ee.EnvironmentKeys
	grant      e2ee.SealedGrant
	material   *api.VaultMaterial
	// token is the XECRET_TOKEN string, for a world whose grant is a service
	// token's.
	token string
}

func newWorld(t *testing.T, recipient e2ee.RecipientKind) *world {
	t.Helper()

	pair, err := e2ee.GenerateEncryptionKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	w := &world{
		t: t, recipient: recipient, privateKey: pair.PrivateKey, publicKey: pair.PublicKey,
		userKey: randomKey(t),
		keys:    e2ee.EnvironmentKeys{EDK: randomKey(t), EHK: randomKey(t)},
	}

	recipientID := worldUserID
	if recipient == e2ee.RecipientToken {
		recipientID = worldTokenID
		w.token = "xst_live_" + base64.RawURLEncoding.EncodeToString(randomKey(t)) +
			"k" + base64.RawURLEncoding.EncodeToString(pair.PrivateKey)
	}
	if w.grant, err = e2ee.SealGrant(e2ee.GrantRecipient{
		EnvironmentID: worldEnvID, EDKVersion: 1, RecipientKind: recipient,
		RecipientID: recipientID, RecipientPublicKey: pair.PublicKey,
	}, w.keys); err != nil {
		t.Fatal(err)
	}

	encPrivateKeyEnc, err := e2ee.WrapPrivateKey(w.userKey, pair.PrivateKey, worldUserID, e2ee.PurposeEncryption)
	if err != nil {
		t.Fatal(err)
	}
	w.material = &api.VaultMaterial{EncPrivateKeyEnc: encPrivateKeyEnc}
	return w
}

func randomKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, e2ee.KeyBytes)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	return key
}

// keyState is GET …/keys for this environment.
func (w *world) keyState(isProduction bool) map[string]any {
	return map[string]any{"keys": map[string]any{
		"encryptionMode": "e2ee",
		"environmentId":  worldEnvID,
		"activeEdk":      map[string]any{"id": worldEdkID, "version": 1},
		"myGrant":        map[string]any{"edkSealed": w.grant.EDKSealed, "ehkSealed": w.grant.EHKSealed},
		"isProduction":   isProduction,
	}}
}

// row is one secret's ciphertext at a version, as a bundle or a reveal serves it.
func (w *world) row(secretID, name, value string, version int) api.ClientSecret {
	w.t.Helper()
	ciphertext, err := e2ee.EncryptSecret(w.keys.EDK, e2ee.SecretContext{
		Field: e2ee.FieldValue, OrgID: worldOrgID, EnvironmentID: worldEnvID,
		SecretID: secretID, Version: version,
	}, value)
	if err != nil {
		w.t.Fatal(err)
	}
	return api.ClientSecret{
		ID: secretID, Name: name, Ciphertext: ciphertext,
		ClientAlgorithm: envkeys.ClientAlgorithm, EnvDataKeyID: worldEdkID, Version: version,
	}
}

// bundle is GET …/pull for this environment, version 1, with the export policy
// stated when policy is not empty.
func (w *world) bundle(policy string, rows ...api.ClientSecret) []byte {
	w.t.Helper()
	document := map[string]any{
		"bundle": true, "bundleVersion": 1, "encryptionMode": "e2ee",
		"keys": w.keyState(false)["keys"], "secrets": rows,
	}
	if policy != "" {
		document["policy"] = map[string]any{"plaintextExport": policy}
	}
	raw, err := json.Marshal(document)
	if err != nil {
		w.t.Fatal(err)
	}
	return raw
}

// override encrypts a value the way `overrides set` does, under whichever private key
// the test says.
func (w *world) override(privateKey []byte, name, value string) api.PersonalOverride {
	w.t.Helper()
	ciphertext, err := e2ee.SealOverrideValue(privateKey, e2ee.OverrideContext{
		OrgID: worldOrgID, EnvironmentID: worldEnvID, UserID: worldUserID, Name: name,
	}, value)
	if err != nil {
		w.t.Fatal(err)
	}
	return api.PersonalOverride{Name: name, Ciphertext: ciphertext, UpdatedAt: "2026-10-01T09:30:00Z"}
}

// recordedRequest is one request the fake API received.
type recordedRequest struct {
	method string
	path   string
	query  string
	body   []byte
}

type fakeRoute struct {
	method  string
	suffix  string
	handler func(w http.ResponseWriter, r *http.Request, body []byte)
}

// fakeAPI answers the routes a test registers, matched by method and the
// longest path suffix, and fails the test on anything else.
type fakeAPI struct {
	t        *testing.T
	server   *httptest.Server
	mu       sync.Mutex
	requests []recordedRequest
	routes   []fakeRoute
}

func newFakeAPI(t *testing.T) *fakeAPI {
	t.Helper()
	f := &fakeAPI{t: t}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeAPI) URL() string { return f.server.URL }

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.requests = append(f.requests, recordedRequest{r.Method, r.URL.Path, r.URL.RawQuery, body})
	var match *fakeRoute
	for i := range f.routes {
		route := &f.routes[i]
		if route.method == r.Method && strings.HasSuffix(r.URL.Path, route.suffix) &&
			(match == nil || len(route.suffix) > len(match.suffix)) {
			match = route
		}
	}
	f.mu.Unlock()

	if match == nil {
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"code": "not_found", "message": "no route"}})
		return
	}
	match.handler(w, r, body)
}

func (f *fakeAPI) handle(method, suffix string, handler func(w http.ResponseWriter, r *http.Request, body []byte)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes = append(f.routes, fakeRoute{method, suffix, handler})
}

// reply registers a fixed JSON answer.
func (f *fakeAPI) reply(method, suffix string, status int, body any) {
	f.handle(method, suffix, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeJSON(w, status, body)
	})
}

// refuse registers an error envelope.
func (f *fakeAPI) refuse(method, suffix string, status int, code, message string) {
	f.reply(method, suffix, status, map[string]any{"error": map[string]any{"code": code, "message": message}})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if raw, ok := body.([]byte); ok {
		_, _ = w.Write(raw)
		return
	}
	_ = json.NewEncoder(w).Encode(body)
}

// sent returns every request matching method and suffix, in order.
func (f *fakeAPI) sent(method, suffix string) []recordedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	var matching []recordedRequest
	for _, request := range f.requests {
		if request.method == method && strings.HasSuffix(request.path, suffix) {
			matching = append(matching, request)
		}
	}
	return matching
}

// any reports whether a request was made whose path contains fragment.
func (f *fakeAPI) any(fragment string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, request := range f.requests {
		if strings.Contains(request.path, fragment) {
			return true
		}
	}
	return false
}

// everything is every request body and query, joined — for asserting a value
// never left the process in plaintext.
func (f *fakeAPI) everything() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var b strings.Builder
	for _, request := range f.requests {
		b.WriteString(request.path + "?" + request.query + "\n")
		b.Write(request.body)
		b.WriteString("\n")
	}
	return b.String()
}

// loggedIn makes this machine a login to the fake API: an isolated home, a file
// keyring holding the credential and the User Key, and the two routes every
// member's key read makes.
func loggedIn(t *testing.T, w *world, fake *fakeAPI) *cred.Credentials {
	t.Helper()

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XECRET_KEYRING", "file")
	t.Setenv("XECRET_TOKEN", "")
	t.Setenv("XECRET_API_URL", "")

	store := keyring.Open(output.New(false).Warnf)
	credentials := cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
		OrgSlug: "acme", UserID: worldUserID, OrgID: worldOrgID,
	}
	if err := cred.Save(store, credentials); err != nil {
		t.Skipf("this platform's file keyring is not writable under a temporary HOME: %v", err)
	}
	if err := envkeys.StoreUserKey(store, w.userKey); err != nil {
		t.Fatal(err)
	}

	fake.reply(http.MethodGet, "/api/auth/vault", http.StatusOK, map[string]any{
		"vault": map[string]any{"configured": true, "unlocked": true}, "material": w.material,
	})
	return &credentials
}

// testApp is an app whose output lands in buffers rather than on the terminal.
func testApp(t *testing.T) (*app, *bytes.Buffer) {
	t.Helper()
	warnings := &bytes.Buffer{}
	printer := &output.Printer{Out: io.Discard, Err: warnings}
	return &app{printer: printer, store: keyring.Open(printer.Warnf)}, warnings
}

// captured runs a command that builds its own app — and so writes to the real
// os.Stdout and os.Stderr — and returns what it wrote to each.
func captured(t *testing.T, command func() error) (stdout, stderr string, err error) {
	t.Helper()

	outRead, outWrite, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatal(pipeErr)
	}
	errRead, errWrite, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatal(pipeErr)
	}

	realOut, realErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outWrite, errWrite

	var outBuf, errBuf bytes.Buffer
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, _ = io.Copy(&outBuf, outRead) }()
	go func() { defer wg.Done(); _, _ = io.Copy(&errBuf, errRead) }()

	err = command()

	os.Stdout, os.Stderr = realOut, realErr
	_ = outWrite.Close()
	_ = errWrite.Close()
	wg.Wait()
	return outBuf.String(), errBuf.String(), err
}

// valueFile writes a value to a file with no trailing newline, which is how
// these tests hand `--from-file` a value without a terminal.
func valueFile(t *testing.T, value string) string {
	t.Helper()
	path := t.TempDir() + string(os.PathSeparator) + "value"
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// scopeFlags is the flag pair every command test passes, so no .xecret.yaml is
// needed.
var scopeFlags = []string{"--project", "web", "--environment", "dev"}

func withScope(args ...string) []string { return append(args, scopeFlags...) }
