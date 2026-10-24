package envkeys

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/references"
)

// A version 2 bundle, built the way apps/web builds one and opened the way
// `xecret run` opens it.
//
// Every environment below has its own data key and its own grant sealed to the
// same member, and every row is encrypted under its *own* environment's key with
// that environment's id in the AAD — so a layer opened with the wrong grant, or
// a row decrypted against the reader's environment id instead of its own, fails
// here rather than in somebody's deploy. The bundle is assembled as JSON in the
// server's field names and parsed through api.EnvironmentBundle, which is what
// proves the struct tags read the shape that is actually served.

const (
	v2OrgID  = "018f3b2c-9c1a-7c3d-8e4f-2a0000000001"
	v2UserID = "018f3b2c-9c1a-7c3d-8e4f-2a0000000002"
	// staging inherits from base; its template reaches into shared, which
	// inherits from shared-root.
	v2BaseID       = "018f3b2c-9c1a-7c3d-8e4f-2a00000000b1"
	v2StagingID    = "018f3b2c-9c1a-7c3d-8e4f-2a00000000b2"
	v2SharedID     = "018f3b2c-9c1a-7c3d-8e4f-2a00000000b3"
	v2SharedRootID = "018f3b2c-9c1a-7c3d-8e4f-2a00000000b4"
)

// layerKeys is one environment's keys and the member's grant on them.
type layerKeys struct {
	environmentID string
	edkID         string
	keys          e2ee.EnvironmentKeys
	grant         e2ee.SealedGrant
}

func newLayerKeys(t *testing.T, environmentID, edkID string, recipientPublicKey []byte) layerKeys {
	t.Helper()
	edk := make([]byte, e2ee.KeyBytes)
	ehk := make([]byte, e2ee.KeyBytes)
	for _, buffer := range [][]byte{edk, ehk} {
		if _, err := rand.Read(buffer); err != nil {
			t.Fatal(err)
		}
	}
	keys := e2ee.EnvironmentKeys{EDK: edk, EHK: ehk}
	grant, err := e2ee.SealGrant(e2ee.GrantRecipient{
		EnvironmentID:      environmentID,
		EDKVersion:         1,
		RecipientKind:      e2ee.RecipientMember,
		RecipientID:        v2UserID,
		RecipientPublicKey: recipientPublicKey,
	}, keys)
	if err != nil {
		t.Fatalf("sealing the grant for %s: %v", environmentID, err)
	}
	return layerKeys{environmentID: environmentID, edkID: edkID, keys: keys, grant: grant}
}

// keysJSON is the `keys` object the server serves for this environment.
func (l layerKeys) keysJSON() map[string]any {
	return map[string]any{
		"encryptionMode": "e2ee",
		"environmentId":  l.environmentID,
		"activeEdk":      map[string]any{"id": l.edkID, "version": 1},
		"myGrant":        map[string]any{"edkSealed": l.grant.EDKSealed, "ehkSealed": l.grant.EHKSealed},
	}
}

// row is one ciphertext row, sealed under this environment's own key and id.
func (l layerKeys) row(t *testing.T, secretID, name, value string, declared ...map[string]any) map[string]any {
	t.Helper()
	ciphertext, err := e2ee.EncryptSecret(l.keys.EDK, e2ee.SecretContext{
		Field:         e2ee.FieldValue,
		OrgID:         v2OrgID,
		EnvironmentID: l.environmentID,
		SecretID:      secretID,
		Version:       1,
	}, value)
	if err != nil {
		t.Fatalf("encrypting %s: %v", name, err)
	}
	row := map[string]any{
		"id": secretID, "name": name, "ciphertext": ciphertext,
		"clientAlgorithm": ClientAlgorithm, "envDataKeyId": l.edkID, "version": 1,
	}
	if declared != nil {
		row["template"] = true
		row["references"] = declared
	}
	return row
}

func unqualified(name string) map[string]any {
	return map[string]any{"name": name, "environmentId": nil}
}

// v2Fixture is the whole graph and the principal its grants are sealed to.
type v2Fixture struct {
	principal *Principal
	base      layerKeys
	staging   layerKeys
	shared    layerKeys
	document  map[string]any
}

func newV2Fixture(t *testing.T) *v2Fixture {
	t.Helper()
	pair, err := e2ee.GenerateEncryptionKeyPair()
	if err != nil {
		t.Fatal(err)
	}

	f := &v2Fixture{
		principal: &Principal{Kind: e2ee.RecipientMember, ID: v2UserID, OrgID: v2OrgID, PrivateKey: pair.PrivateKey},
		base:      newLayerKeys(t, v2BaseID, "018f3b2c-9c1a-7c3d-8e4f-2a00000000e1", pair.PublicKey),
		staging:   newLayerKeys(t, v2StagingID, "018f3b2c-9c1a-7c3d-8e4f-2a00000000e2", pair.PublicKey),
		shared:    newLayerKeys(t, v2SharedID, "018f3b2c-9c1a-7c3d-8e4f-2a00000000e3", pair.PublicKey),
	}

	f.document = map[string]any{
		"bundle": true, "bundleVersion": 2, "encryptionMode": "e2ee",
		"keys": f.staging.keysJSON(),
		"environment": map[string]any{
			"id": v2StagingID, "projectSlug": "api", "slug": "staging", "parentEnvironmentId": v2BaseID,
		},
		// The environment being read overrides HOST and sets nothing else.
		"secrets": []any{
			f.staging.row(t, "018f3b2c-9c1a-7c3d-8e4f-2a00000000c1", "HOST", "staging.internal"),
		},
		"layers": []any{
			// The parent, whole: a template written there resolves its
			// unqualified references in the view of the environment being read.
			map[string]any{
				"environmentId": v2BaseID, "projectSlug": "api", "environmentSlug": "base",
				"parentEnvironmentId": nil,
				"keys":                f.base.keysJSON(),
				"secrets": []any{
					f.base.row(t, "018f3b2c-9c1a-7c3d-8e4f-2a00000000c2", "HOST", "base.internal"),
					f.base.row(t, "018f3b2c-9c1a-7c3d-8e4f-2a00000000c3", "PORT", "5432"),
					f.base.row(t, "018f3b2c-9c1a-7c3d-8e4f-2a00000000c4", "SCRIPT", "echo ${HOME}"),
					f.base.row(t, "018f3b2c-9c1a-7c3d-8e4f-2a00000000c5", "URL",
						"postgres://${HOST}:${PORT}/${shared.DB_NAME}?literal=$${X}",
						unqualified("HOST"), unqualified("PORT"),
						map[string]any{"environment": "shared", "name": "DB_NAME", "environmentId": v2SharedID}),
				},
			},
			// A referenced environment carries only what is reached: DB_NAME, and
			// not whatever else it holds.
			map[string]any{
				"environmentId": v2SharedID, "projectSlug": "api", "environmentSlug": "shared",
				"parentEnvironmentId": v2SharedRootID,
				"keys":                f.shared.keysJSON(),
				"secrets": []any{
					f.shared.row(t, "018f3b2c-9c1a-7c3d-8e4f-2a00000000c6", "DB_NAME", "orders"),
				},
			},
			// And its parent contributes nothing, so it carries no key: it is
			// there so the chain can be walked.
			map[string]any{
				"environmentId": v2SharedRootID, "projectSlug": "api", "environmentSlug": "shared-root",
				"parentEnvironmentId": nil, "keys": nil, "secrets": []any{},
			},
		},
		"policy": map[string]any{"plaintextExport": "allowed"},
	}
	return f
}

// bundle round-trips the document through JSON into the type the CLI reads.
func (f *v2Fixture) bundle(t *testing.T) *api.EnvironmentBundle {
	t.Helper()
	raw, err := json.Marshal(f.document)
	if err != nil {
		t.Fatal(err)
	}
	var bundle api.EnvironmentBundle
	if err := json.Unmarshal(raw, &bundle); err != nil {
		t.Fatalf("the v2 document does not parse: %v", err)
	}
	return &bundle
}

func (f *v2Fixture) layers() []any { return f.document["layers"].([]any) }

func (f *v2Fixture) layer(i int) map[string]any { return f.layers()[i].(map[string]any) }

func TestAVersionTwoBundleOpensEveryLayerAndResolves(t *testing.T) {
	f := newV2Fixture(t)

	secrets, err := DecryptBundle(f.bundle(t), f.principal)
	if err != nil {
		t.Fatalf("DecryptBundle: %v", err)
	}

	want := map[string]string{
		// The child's own value overrides the parent's.
		"HOST": "staging.internal",
		// A name the child does not set falls through.
		"PORT": "5432",
		// A non-template keeps its text, whatever it contains.
		"SCRIPT": "echo ${HOME}",
		// The parent's template sees the child's HOST, reaches into shared for
		// DB_NAME, and keeps an escaped ${ as text.
		"URL": "postgres://staging.internal:5432/orders?literal=${X}",
	}
	if len(secrets) != len(want) {
		t.Errorf("resolved %d names, want %d: %v", len(secrets), len(want), keysOf(secrets))
	}
	for name, value := range want {
		if secrets[name] != value {
			t.Errorf("%s\n got %q\nwant %q", name, secrets[name], value)
		}
	}
	// A referenced secret is reached, not inherited: it is not in the view.
	if _, present := secrets["DB_NAME"]; present {
		t.Error("a secret reached by a reference was injected as if the environment held it")
	}
}

// Every row is attempted and every failure reported together, across layers —
// and a row from a layer says which layer, because "HOST could not be decrypted"
// in a staging run that inherits it from base is a sentence about the wrong
// environment.
func TestRowFailuresAcrossLayersAreReportedTogether(t *testing.T) {
	f := newV2Fixture(t)
	retired := "018f3b2c-9c1a-7c3d-8e4f-2a00000000ff"
	f.document["secrets"].([]any)[0].(map[string]any)["envDataKeyId"] = retired
	f.layer(0)["secrets"].([]any)[1].(map[string]any)["envDataKeyId"] = retired

	_, err := DecryptBundle(f.bundle(t), f.principal)
	var bundleErr *BundleError
	if !errors.As(err, &bundleErr) {
		t.Fatalf("err = %v, want a *BundleError", err)
	}
	if len(bundleErr.Failures) != 2 || bundleErr.Total != 6 {
		t.Fatalf("failures = %d of %d, want 2 of 6: %v", len(bundleErr.Failures), bundleErr.Total, err)
	}
	if bundleErr.Failures[0].Name != "HOST" {
		t.Errorf("the reader's own row = %q", bundleErr.Failures[0].Name)
	}
	if bundleErr.Failures[1].Name != "PORT (from api/base)" {
		t.Errorf("the inherited row = %q, want it to name its layer", bundleErr.Failures[1].Name)
	}
	if !bundleErr.AllRotatedAway() {
		t.Error("two retired-key rows are not reported as such")
	}
}

// A layer's rows are authenticated against the environment id in its own
// `keys`. A layer that files them under a different id would put correctly
// sealed rows into the wrong environment of the graph, so it is refused.
func TestALayerFiledUnderAnotherEnvironmentIsRefused(t *testing.T) {
	f := newV2Fixture(t)
	f.layer(1)["environmentId"] = v2BaseID

	if _, err := DecryptBundle(f.bundle(t), f.principal); err == nil ||
		!strings.Contains(err.Error(), "under one environment") {
		t.Fatalf("err = %v, want the mismatch refused", err)
	}
}

// The same rule for the environment being read.
func TestTheBundleMustNameTheEnvironmentItsKeyOpens(t *testing.T) {
	f := newV2Fixture(t)
	f.document["environment"].(map[string]any)["id"] = v2BaseID

	if _, err := DecryptBundle(f.bundle(t), f.principal); err == nil ||
		!strings.Contains(err.Error(), "carries the key of another") {
		t.Fatalf("err = %v, want the mismatch refused", err)
	}
}

// A layer that holds secrets and no key cannot be opened, and is not skipped:
// skipping it would resolve against a view with that layer's names missing.
func TestALayerWithSecretsAndNoKeyIsRefused(t *testing.T) {
	f := newV2Fixture(t)
	f.layer(1)["keys"] = nil

	if _, err := DecryptBundle(f.bundle(t), f.principal); err == nil {
		t.Fatal("a layer with secrets and no key was read")
	}
}

// A layer whose grant nobody shared says so in words a caller can turn into an
// instruction, as the reader's own environment does.
func TestALayerWithoutAGrantIsNamed(t *testing.T) {
	f := newV2Fixture(t)
	f.layer(0)["keys"].(map[string]any)["myGrant"] = nil

	_, err := DecryptBundle(f.bundle(t), f.principal)
	if !errors.Is(err, ErrNoGrant) {
		t.Fatalf("err = %v, want ErrNoGrant", err)
	}
	if !strings.Contains(err.Error(), "api/base") {
		t.Errorf("the error does not say which environment: %v", err)
	}
}

// Opening every row is not the whole check: a graph that loops fails the read
// as a unit, names the secrets involved, and carries none of their values.
func TestAResolutionFailureFailsTheReadAndNamesNoValue(t *testing.T) {
	f := newV2Fixture(t)
	// Turn the child's HOST into a template that points at URL, which points
	// back at HOST: a cycle that exists only through inheritance.
	f.document["secrets"] = []any{
		f.staging.row(t, "018f3b2c-9c1a-7c3d-8e4f-2a00000000c1", "HOST", "loop-${URL}", unqualified("URL")),
	}

	_, err := DecryptBundle(f.bundle(t), f.principal)
	var resolution *ResolutionError
	if !errors.As(err, &resolution) {
		t.Fatalf("err = %v, want a *ResolutionError", err)
	}
	var kind *references.ResolutionError
	if !errors.As(err, &kind) || kind.Kind != references.KindCycle {
		t.Fatalf("err = %v, want a cycle", err)
	}
	message := err.Error()
	if !strings.Contains(message, "api/staging") || !strings.Contains(message, "HOST") {
		t.Errorf("the error does not name the environment and the secret: %s", message)
	}
	for _, value := range []string{"loop-", "base.internal", "orders", "5432"} {
		if strings.Contains(message, value) {
			t.Errorf("the error carries a value (%q): %s", value, message)
		}
	}
}

// A template whose text does not match what its writer declared is refused at
// read time — the server checked the declaration and nothing else.
func TestAnUndeclaredReferenceIsRefusedAtReadTime(t *testing.T) {
	f := newV2Fixture(t)
	base := f.layer(0)["secrets"].([]any)
	base[3] = f.base.row(t, "018f3b2c-9c1a-7c3d-8e4f-2a00000000c5", "URL",
		"postgres://${HOST}:${PORT}/${shared.DB_NAME}", unqualified("HOST"), unqualified("PORT"))

	_, err := DecryptBundle(f.bundle(t), f.principal)
	var kind *references.ResolutionError
	if !errors.As(err, &kind) || kind.Kind != references.KindUndeclared {
		t.Fatalf("err = %v, want undeclared", err)
	}
}

// The environment being read can arrive twice — once as itself and once as a
// layer, when a sibling that inherits from it is a reference's target. The
// second copy adds nothing and breaks nothing.
func TestTheReadersOwnEnvironmentMayAlsoBeALayer(t *testing.T) {
	f := newV2Fixture(t)
	f.document["layers"] = append(f.layers(), map[string]any{
		"environmentId": v2StagingID, "projectSlug": "api", "environmentSlug": "staging",
		"parentEnvironmentId": v2BaseID,
		"keys":                f.staging.keysJSON(),
		"secrets": []any{
			f.staging.row(t, "018f3b2c-9c1a-7c3d-8e4f-2a00000000c1", "HOST", "staging.internal"),
		},
	})

	secrets, err := DecryptBundle(f.bundle(t), f.principal)
	if err != nil {
		t.Fatalf("DecryptBundle: %v", err)
	}
	if secrets["HOST"] != "staging.internal" || secrets["URL"] != "postgres://staging.internal:5432/orders?literal=${X}" {
		t.Fatalf("secrets = %v", keysOf(secrets))
	}
}

// Version 1 is exactly what it was: a row that happens to say `template` in a
// version 1 bundle is literal text, because a version 1 bundle has no graph to
// resolve it in.
func TestAVersionOneBundleIsLiteralWhateverItsRowsSay(t *testing.T) {
	f := newV2Fixture(t)
	document := map[string]any{
		"bundle": true, "bundleVersion": 1, "encryptionMode": "e2ee",
		"keys": f.base.keysJSON(),
		"secrets": []any{
			f.base.row(t, "018f3b2c-9c1a-7c3d-8e4f-2a00000000c5", "URL", "postgres://${HOST}/db", unqualified("HOST")),
		},
	}
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	var bundle api.EnvironmentBundle
	if err := json.Unmarshal(raw, &bundle); err != nil {
		t.Fatal(err)
	}

	secrets, err := DecryptBundle(&bundle, f.principal)
	if err != nil {
		t.Fatalf("DecryptBundle: %v", err)
	}
	if secrets["URL"] != "postgres://${HOST}/db" {
		t.Errorf("URL = %q, want the stored text", secrets["URL"])
	}
}

func keysOf(secrets map[string]string) []string {
	names := make([]string, 0, len(secrets))
	for name := range secrets {
		names = append(names, name)
	}
	return names
}
