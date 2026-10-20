package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// The endpoints that exist only because the server cannot decrypt.
//
// Everything here returns ciphertext, key material sealed to somebody, or the
// shape of one. Nothing in this file can be made to return a plaintext secret,
// and that is the point: after the cutover the server holds no key that would
// let it.
//
// Kept beside xecret.go rather than inside it because these responses are read
// by internal/envkeys and nothing else, and the split says so.

// VaultMaterial is GET /api/auth/vault's `material`.
//
// Public halves, wraps, and KDF parameters — everything an unlock needs and
// nothing an unlock produces. Served to a CLI token for its issuing user, which
// is what lets a headless process open the private key its grants are sealed to.
type VaultMaterial struct {
	EncAlgorithm string `json:"encAlgorithm"`
	EncPublicKey string `json:"encPublicKey"`
	// EncPrivateKeyEnc is the X25519 scalar as an xk2.gcm. blob under the User Key.
	EncPrivateKeyEnc string `json:"encPrivateKeyEnc"`
	SignAlgorithm    string `json:"signAlgorithm"`
	SignPublicKey    string `json:"signPublicKey"`
	// SignPrivateKeyEnc is the Ed25519 seed, likewise under the User Key.
	SignPrivateKeyEnc string `json:"signPrivateKeyEnc"`
	// KdfSalt is base64url; KdfParams is stored verbatim and validated by the
	// client before it is allowed to drive Argon2id.
	KdfSalt   string          `json:"kdfSalt"`
	KdfParams json.RawMessage `json:"kdfParams"`
	// PassphraseWrap is the User Key under the passphrase wrap key.
	PassphraseWrap string `json:"passphraseWrap"`
}

// VaultResponse is GET /api/auth/vault.
type VaultResponse struct {
	Vault struct {
		Configured bool `json:"configured"`
		Unlocked   bool `json:"unlocked"`
	} `json:"vault"`
	// Material is null for a service token, which has no vault to read.
	Material *VaultMaterial `json:"material"`
}

// Vault reads the caller's vault material.
func (c *Client) Vault(ctx context.Context) (*VaultResponse, error) {
	var response VaultResponse
	if err := c.Get(ctx, "/api/auth/vault", &response); err != nil {
		return nil, err
	}
	return &response, nil
}

// ActiveKey names the environment data key a grant is against.
type ActiveKey struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
}

// MyGrant is the caller's own sealed pair for an environment.
type MyGrant struct {
	EDKSealed string `json:"edkSealed"`
	EHKSealed string `json:"ehkSealed"`
	Signature string `json:"signature"`
	// SignedByUserID is who created the grant. Verification is deferred (ADR
	// 0009, trade-off 3), so this is carried and not yet acted on.
	SignedByUserID string `json:"signedByUserId"`
}

// EnvironmentKeys is GET …/keys, the `keys` half of the pull bundle, and — with
// IsProduction absent — the `keys` of each layer of a version 2 bundle.
type EnvironmentKeys struct {
	// EncryptionMode is "e2ee" or "server". Every dual-mode decision the CLI
	// makes reads this rather than guessing from a response's shape.
	EncryptionMode string     `json:"encryptionMode"`
	EnvironmentID  string     `json:"environmentId"`
	ActiveEDK      *ActiveKey `json:"activeEdk"`
	// MyGrant is null when the caller has access but nobody has shared the key.
	MyGrant *MyGrant `json:"myGrant"`
	// IsProduction is read from GET …/keys, which every write already makes, so
	// that the secret policy's production scope costs no second request to
	// decide. False where the server does not say, which is the direction that
	// asks less of a value rather than refusing one.
	IsProduction bool `json:"isProduction"`
}

// DeclaredReference is one reference a template's writer declared, as a pull
// serves it: the text between the braces, split into its parts, and the
// environment the server resolved that text to.
//
// EnvironmentID is null for an unqualified `${KEY}`, which means "the
// environment being read" and so cannot be resolved until something is read.
type DeclaredReference struct {
	Project       string  `json:"project,omitempty"`
	Environment   string  `json:"environment,omitempty"`
	Name          string  `json:"name"`
	EnvironmentID *string `json:"environmentId"`
}

// ReferenceDeclaration is a reference as a *write* declares it: the parts of
// the text and nothing the server works out. No environmentId — the server
// resolves the slugs itself, against the graph as it stands when the write
// lands, and refuses a body that tries to tell it the answer.
type ReferenceDeclaration struct {
	Project     string `json:"project,omitempty"`
	Environment string `json:"environment,omitempty"`
	Name        string `json:"name"`
}

// ClientSecret is one row of the e2ee pull bundle: ciphertext and the context
// its AAD is built from. No plaintext, and no field that could hold one.
type ClientSecret struct {
	// ID is the secrets row id, and an AAD component — so it is load-bearing,
	// not decoration.
	ID              string `json:"id"`
	Name            string `json:"name"`
	Ciphertext      string `json:"ciphertext"`
	ClientAlgorithm string `json:"clientAlgorithm"`
	// EnvDataKeyID may name a key that has since been rotated away, in which
	// case this row cannot be read and says so rather than failing obscurely.
	EnvDataKeyID string `json:"envDataKeyId"`
	Version      int    `json:"version"`
	UpdatedAt    string `json:"updatedAt"`
	// Template says this row's text is read for references. Present only on a
	// template, and only in a version 2 bundle; every other row is literal text
	// for ever, whatever it happens to contain.
	Template bool `json:"template,omitempty"`
	// References is what the template's writer declared, which the decrypted
	// text is checked against before anything is resolved.
	References []DeclaredReference `json:"references,omitempty"`
}

// EnvironmentBundle is GET …/pull for an e2ee environment: the key state and
// every current ciphertext, read together so a rotation cannot land between two
// requests and leave the client holding a key for the wrong version.
type EnvironmentBundle struct {
	// Bundle is the marker that says what this response *is*, rather than
	// leaving a client to work it out from what the response happens to contain.
	// See [Client.Pull].
	Bundle bool `json:"bundle"`
	// BundleVersion is the shape of everything below it. 1 is an environment's
	// own secrets and nothing else; 2 adds Environment and Layers, for an
	// environment that inherits or holds a template. A plain environment is
	// still served as 1 to a client that can read 2.
	BundleVersion  int             `json:"bundleVersion"`
	EncryptionMode string          `json:"encryptionMode"`
	Keys           EnvironmentKeys `json:"keys"`
	Secrets        []ClientSecret  `json:"secrets"`
	// Environment names the environment being read: the context every
	// unqualified reference resolves in. Version 2 only.
	Environment *BundleEnvironment `json:"environment,omitempty"`
	// Layers is every other environment the resolution touches — each ancestor
	// whole, and each environment a template reaches into with only the secrets
	// it reaches. Version 2 only.
	Layers []BundleLayer `json:"layers,omitempty"`
	// Policy is what the environment's policy says about this bundle leaving
	// xecret's control. Absent from a server that predates the policy, which is
	// the same answer as "allowed".
	//
	// In a version 2 bundle it is the *effective* policy: "disabled" when the
	// environment, or any layer that contributes a value to it, disables export
	// — so a client that reads only this field still refuses to write
	// production's values out through a staging template. The per-environment
	// answers are on Environment.Policy and each layer's Policy.
	Policy *BundlePolicy `json:"policy,omitempty"`
}

// BundleEnvironment is the `environment` of a version 2 bundle.
type BundleEnvironment struct {
	ID          string `json:"id"`
	ProjectSlug string `json:"projectSlug"`
	Slug        string `json:"slug"`
	// ParentEnvironmentID is null for an environment that inherits from nothing.
	ParentEnvironmentID *string `json:"parentEnvironmentId"`
	// Policy is this environment's own export setting, before any layer's. Absent
	// from a server that sends only the effective policy.
	Policy *BundlePolicy `json:"policy,omitempty"`
}

// BundleLayer is one environment a version 2 bundle carries beyond the one
// being read.
//
// Every ciphertext in it is bound by its AAD to the row and the environment
// that hold it, and opens only under that environment's own key, which is why
// a layer carries its own grant. Nothing is re-encrypted: a layer is ciphertext
// the caller could have pulled directly, delivered together so the resolution
// happens on one consistent read.
type BundleLayer struct {
	EnvironmentID       string  `json:"environmentId"`
	ProjectSlug         string  `json:"projectSlug"`
	EnvironmentSlug     string  `json:"environmentSlug"`
	ParentEnvironmentID *string `json:"parentEnvironmentId"`
	// Keys is null for a layer that contributes no secret — an ancestor of a
	// referenced environment that sets nothing the reference needs. It is there
	// only so the client can walk the same chain the server walked.
	Keys    *EnvironmentKeys `json:"keys"`
	Secrets []ClientSecret   `json:"secrets"`
	// Policy is the layer's own export setting. It counts only for a layer that
	// contributes a value (Keys not null). Absent from an older server.
	Policy *BundlePolicy `json:"policy,omitempty"`
}

// contributes reports whether a layer hands the client any value to write out.
func (l BundleLayer) contributes() bool {
	return l.Keys != nil || len(l.Secrets) > 0
}

// BundlePolicy is the `policy` of a bundle.
type BundlePolicy struct {
	// PlaintextExport is "allowed" or "disabled". See [PlaintextExportDisabled].
	PlaintextExport string `json:"plaintextExport"`
}

// PlaintextExportDisabled is the one value of the export policy that refuses.
//
// Stated as the refusal rather than as "anything but allowed": an absent field,
// an empty one, and a value this build has never heard of all mean a server
// that did not say "disabled", and turning an unknown word into a refusal would
// break `pull` against a deployment for having added a third state.
const PlaintextExportDisabled = "disabled"

// PlaintextExportHeader is how a server-mode pull says the same thing. A
// server-rendered document has nowhere to carry a policy field, and inventing
// one inside it would change the document `pull` writes out.
const PlaintextExportHeader = "x-xecret-plaintext-export"

// Pulled is what a pull produced, in whichever mode the environment is in.
//
// One type for both because every caller wants the same thing — "give me this
// environment" — and the difference is which field is populated. A caller that
// forgets to check `Bundle` gets an empty document rather than a decrypted one,
// which is the safe direction to be wrong in.
type Pulled struct {
	// Bundle is set for an e2ee environment. Its secrets are ciphertext.
	Bundle *EnvironmentBundle
	// Raw is the bundle's response body exactly as it arrived, for the offline
	// cache. Re-marshalling the parsed struct would cache this build's idea of
	// the shape rather than the server's, which is the one thing a cached
	// ciphertext cannot afford: a field this build drops is a field the next one
	// needs, and there is no key anywhere to re-derive it from.
	Raw []byte
	// Document is the server-rendered file for a server-mode environment,
	// verbatim, in the requested format.
	Document []byte
	// PlaintextExport is the pull's PlaintextExportHeader, as the server sent
	// it. Read for a server-mode environment, whose document has nowhere else to
	// say it; a bundle's own Policy is what answers for an e2ee one.
	PlaintextExport string
}

// ExportDisabled reports whether the environment's policy refuses a plaintext
// copy of what this pull produced — the question `pull` and `export` ask before
// writing anything, and `run` never asks.
//
// For a version 2 bundle it is asked of every environment the output draws
// on, not only the one being pulled: the server's effective policy says so,
// and a layer's own "disabled" is honoured here as well, so a server that sent
// the per-layer answers but not the effective one cannot make a difference.
func (p *Pulled) ExportDisabled() bool {
	if p.Bundle != nil {
		if disabled(p.Bundle.Policy) {
			return true
		}
		return len(p.ExportRefusedBy()) > 0
	}
	return p.PlaintextExport == PlaintextExportDisabled
}

// ExportRefusedBy names, as "project/environment", each environment whose own
// policy refuses this output: the one pulled, if it is one, and every layer
// that contributes a value. Empty when the server did not say which — a
// version 1 bundle, a server-mode document, or a server that sends only the
// effective policy — and the caller then names the environment it pulled.
func (p *Pulled) ExportRefusedBy() []string {
	if p.Bundle == nil {
		return nil
	}
	var names []string
	if environment := p.Bundle.Environment; environment != nil && disabled(environment.Policy) {
		names = append(names, environment.ProjectSlug+"/"+environment.Slug)
	}
	for _, layer := range p.Bundle.Layers {
		if layer.contributes() && disabled(layer.Policy) {
			names = append(names, layer.ProjectSlug+"/"+layer.EnvironmentSlug)
		}
	}
	return names
}

func disabled(policy *BundlePolicy) bool {
	return policy != nil && policy.PlaintextExport == PlaintextExportDisabled
}

// Pull fetches an environment.
//
// The mode is read from the response rather than asked for in advance: one
// request either way, and no window in which the mode could change between two.
//
// ── How a bundle is recognised ──
//
// By the response saying it is one. The bundle carries a top-level
// `"bundle": true`, which is a field the server chose to send and not a
// coincidence of content, and that is what this branches on.
//
// It did not always. The test used to be `encryptionMode == "e2ee"` at the top
// level — and for `format=json` a server-mode pull is a *flat name→value object
// of the environment's own secrets*, so an environment containing a secret
// literally named `encryptionMode` whose value was `e2ee` was read as a bundle,
// and its secrets were then treated as ciphertext. Nothing about that is exotic:
// it is a name a person migrating between the two modes would plausibly write
// down.
//
// The old shape is still accepted, because a client that only understands the
// new marker cannot talk to a deployment that has not shipped it yet — but it is
// accepted with the ambiguity closed: `secrets` must be a JSON *array*, which in
// a flat document it can never be, because every value in one is a string. That
// tolerance can be deleted once no supported deployment predates the marker.
//
// ── `bundle=2`, on every pull ──
//
// The request says this client can resolve inheritance and references (P19 §1).
// It is a statement of capability, not a request for a shape: an environment
// that uses neither is still answered with version 1, unchanged, and one that
// uses either is answered with version 2 — which a client that did not say so
// is refused with a 409 `resolution_unsupported:` rather than handed a view
// missing every inherited value and holding a template's literal `${…}` text.
// A deployment that predates the parameter ignores it.
func (c *Client) Pull(ctx context.Context, org, project, env, format string) (*Pulled, error) {
	raw, header, err := c.getRawWithHeader(ctx,
		envPath(org, project, env)+"/pull?format="+url.QueryEscape(format)+"&bundle=2")
	if err != nil {
		return nil, err
	}
	exportPolicy := strings.ToLower(strings.TrimSpace(header.Get(PlaintextExportHeader)))

	if looksLikeBundle(raw) {
		var bundle EnvironmentBundle
		if json.Unmarshal(raw, &bundle) == nil {
			return &Pulled{Bundle: &bundle, Raw: raw, PlaintextExport: exportPolicy}, nil
		}
	}
	return &Pulled{Document: raw, PlaintextExport: exportPolicy}, nil
}

// looksLikeBundle answers the question above without decoding the whole body.
func looksLikeBundle(raw []byte) bool {
	var probe struct {
		Bundle         bool            `json:"bundle"`
		EncryptionMode string          `json:"encryptionMode"`
		Secrets        json.RawMessage `json:"secrets"`
	}
	if json.Unmarshal(raw, &probe) != nil {
		return false
	}
	if probe.Bundle {
		return true
	}
	return probe.EncryptionMode == "e2ee" && isJSONArray(probe.Secrets)
}

func isJSONArray(raw json.RawMessage) bool {
	var array []json.RawMessage
	return len(raw) > 0 && json.Unmarshal(raw, &array) == nil
}

// EnvironmentKeyState reads GET …/keys on its own, for the paths that need the
// key without the values — `secrets get --plain`, and a write.
func (c *Client) EnvironmentKeyState(ctx context.Context, org, project, env string) (*EnvironmentKeys, error) {
	var response struct {
		Keys EnvironmentKeys `json:"keys"`
	}
	if err := c.Get(ctx, envPath(org, project, env)+"/keys", &response); err != nil {
		return nil, err
	}
	return &response.Keys, nil
}

// ClientValue is the sealed half of a write: what the server stores without
// being able to read it.
type ClientValue struct {
	Ciphertext      string `json:"ciphertext"`
	ClientAlgorithm string `json:"clientAlgorithm"`
	EnvDataKeyID    string `json:"envDataKeyId"`
	// ValueHmac is keyed from the long-lived EHK, so the server's no-op check
	// survives an EDK rotation without seeing a plaintext.
	ValueHmac string `json:"valueHmac"`
}

// RevealedCiphertext is GET …/secrets/{name} for an e2ee environment. `value`
// comes back null; the caller decrypts.
type RevealedCiphertext struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Value           *string `json:"value"`
	Ciphertext      string  `json:"ciphertext"`
	ClientAlgorithm string  `json:"clientAlgorithm"`
	EnvDataKeyID    string  `json:"envDataKeyId"`
	ValueType       string  `json:"valueType"`
	Version         int     `json:"version"`
}

// RevealClient reads one secret's ciphertext.
func (c *Client) RevealClient(ctx context.Context, org, project, env, name string) (*RevealedCiphertext, error) {
	var response struct {
		Secret RevealedCiphertext `json:"secret"`
	}
	if err := c.Get(ctx, secretPath(org, project, env, name), &response); err != nil {
		return nil, err
	}
	return &response.Secret, nil
}

// withReferences puts a template's declaration on a write body, and puts
// nothing there for a value that is not a template.
//
// Two states, and the distinction is the server's rule rather than this
// client's taste: a template's write **must** declare its references — an
// empty list is a template that references nothing, and an absent one is
// refused — and any other write **must not**. So nil means "not a template"
// and leaves the key off; a non-nil slice, empty or not, is sent as an array.
func withReferences(body map[string]any, references []ReferenceDeclaration) {
	if references != nil {
		body["references"] = references
	}
}

// WriteOption adjusts a client-encrypted write's body.
type WriteOption func(body map[string]any)

// ConfirmCrossesProtection says the caller knows a production template is
// being made to read from an environment that is not production. Without it
// the server refuses such a write with 409 `link_crosses_protection:`, naming
// who could then change production's values; it is sent only when the person
// asked for it (`--confirm-link`), never as a retry this client decides on.
func ConfirmCrossesProtection() WriteOption {
	return func(body map[string]any) { body["confirmCrossesProtection"] = true }
}

func applyOptions(body map[string]any, options []WriteOption) {
	for _, option := range options {
		option(body)
	}
}

// CreateClientSecret writes a pre-encrypted secret.
//
// The id is minted here rather than by the server, and that is not a
// convenience: it is an AAD component, so the ciphertext is already sealed
// against it by the time this request is built. A server-assigned id would
// arrive after the only moment it could have been bound.
//
// references is the template's declaration, or nil — see [withReferences].
func (c *Client) CreateClientSecret(
	ctx context.Context,
	org, project, env, id, name string,
	value ClientValue,
	valueType string,
	encNote *string,
	references []ReferenceDeclaration,
	options ...WriteOption,
) (*WriteResult, error) {
	body := map[string]any{"id": id, "name": name, "value": value}
	if valueType != "" {
		body["valueType"] = valueType
	}
	if encNote != nil {
		body["encNote"] = *encNote
	}
	withReferences(body, references)
	applyOptions(body, options)

	var response struct {
		Secret WriteResult `json:"secret"`
	}
	if err := c.Post(ctx, envPath(org, project, env)+"/secrets", body, &response); err != nil {
		return nil, err
	}
	response.Secret.Status = "created"
	return &response.Secret, nil
}

// UpdateClientSecret appends a pre-encrypted version.
//
// expectedVersion is the version this ciphertext is bound to. It is not
// bookkeeping: the AAD binds the version (spec §4.2), the server derives its own
// target from the stored row, and a disagreement — a second writer, a stale
// listing — would store bytes the row does not name, unopenable for ever behind
// a 200. Stating it turns that into a 409 the caller retries.
//
// references is the template's declaration, or nil — see [withReferences].
// Whether this write is a template's is the caller's to work out, from the type
// it is setting or, failing that, the type the secret already has.
func (c *Client) UpdateClientSecret(
	ctx context.Context,
	org, project, env, name string,
	value ClientValue,
	expectedVersion int,
	valueType string,
	references []ReferenceDeclaration,
	options ...WriteOption,
) (*WriteResult, error) {
	body := map[string]any{"value": value, "expectedVersion": expectedVersion}
	if valueType != "" {
		body["valueType"] = valueType
	}
	withReferences(body, references)
	applyOptions(body, options)

	var response struct {
		Secret WriteResult `json:"secret"`
	}
	if err := c.Patch(ctx, secretPath(org, project, env, name), body, &response); err != nil {
		return nil, err
	}
	return &response.Secret, nil
}

// ClientImportEntry is one pre-encrypted row of an import.
type ClientImportEntry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// ExpectedVersion is what this entry sealed for: 1 where the client planned a
	// create, the stored version plus one where it planned an overwrite. The
	// server re-plans against the complete listing and refuses an entry whose id
	// or version it does not agree with, rather than writing it under the row it
	// resolved — see UpdateClientSecret.
	ExpectedVersion int         `json:"expectedVersion"`
	Value           ClientValue `json:"value"`
	EncNote         *string     `json:"encNote,omitempty"`
}

// RestoreClientSecret re-appends an earlier value, re-encrypted for the version
// it is about to become.
//
// The old ciphertext is never copied. It names version N in its AAD, and a copy
// stored as version N+1 would authenticate against nothing — which is the same
// reason the server re-encrypts on the `server`-mode path, done on the only side
// that can here.
//
// Two version numbers, and they are different: version is the one being restored
// *from*, expectedVersion the one these bytes are bound to. See
// UpdateClientSecret for what the second one prevents.
//
// references is, for a template, the restored text's references re-parsed from
// the version that was decrypted — the server checks them against the graph as
// it stands today, which may not be the graph that version was written into.
// nil for anything else; see [withReferences].
func (c *Client) RestoreClientSecret(
	ctx context.Context,
	org, project, env, name string,
	version int,
	value ClientValue,
	expectedVersion int,
	references []ReferenceDeclaration,
) (*RestoreResult, error) {
	var response struct {
		Secret RestoreResult `json:"secret"`
	}
	body := map[string]any{
		"version":         version,
		"expectedVersion": expectedVersion,
		"value":           value,
	}
	withReferences(body, references)
	if err := c.Post(ctx, secretPath(org, project, env, name)+"/restore", body, &response); err != nil {
		return nil, err
	}
	return &response.Secret, nil
}

// ClientImportOutcome is what the server made of one entry. `unchanged` is only
// knowable after the HMAC comparison, which happens there.
type ClientImportOutcome struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// ClientImportResult is the e2ee import response. No `format`, no `strategy`,
// no warnings: the parsing and the planning happened on this side.
type ClientImportResult struct {
	DryRun bool                  `json:"dryRun"`
	Counts map[string]int        `json:"counts"`
	Items  []ClientImportOutcome `json:"items"`
}

// ImportClientEntries posts a batch of pre-encrypted secrets.
func (c *Client) ImportClientEntries(
	ctx context.Context,
	org, project, env string,
	entries []ClientImportEntry,
	dryRun bool,
) (*ClientImportResult, error) {
	if len(entries) == 0 {
		return nil, fmt.Errorf("nothing to import")
	}

	var result ClientImportResult
	body := map[string]any{"entries": entries, "dryRun": dryRun}
	if err := c.Post(ctx, envPath(org, project, env)+"/import", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ── Personal overrides (P19 §2) ──
//
// One person's own value for one secret in one environment, used by `xecret
// run` on their machine in place of the shared one. Sealed to that person's own
// X25519 public key rather than under the environment's EDK (spec §2.2 type 13),
// because every reader of the environment holds the EDK and an override must
// not be readable by another member — as a property of the ciphertext, not only
// of the route that declines to serve it.
//
// So these endpoints are a person's and nobody else's. The listing returns the
// caller's own overrides and no one else's, and a service token is refused with
// a 403 — which the CLI never collects, because it never calls these under
// XECRET_TOKEN.

// PersonalOverride is one row of GET …/overrides. Ciphertext only: the server
// cannot open it, and neither can anybody but its owner.
type PersonalOverride struct {
	Name       string `json:"name"`
	Ciphertext string `json:"ciphertext"`
	UpdatedAt  string `json:"updatedAt"`
}

// OverrideWrite is what PUT …/overrides/{name} reports.
type OverrideWrite struct {
	Name      string `json:"name"`
	UpdatedAt string `json:"updatedAt"`
	// Created is false when an override for this name already existed and was
	// replaced — overrides are replaced in place, never versioned.
	Created bool `json:"created"`
}

func overridePath(org, project, env, name string) string {
	return envPath(org, project, env) + "/overrides/" + url.PathEscape(name)
}

// Overrides lists the caller's own overrides for an environment.
func (c *Client) Overrides(ctx context.Context, org, project, env string) ([]PersonalOverride, error) {
	var response struct {
		Overrides []PersonalOverride `json:"overrides"`
	}
	if err := c.Get(ctx, envPath(org, project, env)+"/overrides", &response); err != nil {
		return nil, err
	}
	return response.Overrides, nil
}

// SetOverride stores a sealed override, replacing the caller's existing one for
// that name if there is one. A plan without the feature answers 403
// `plan_limit`; a server-mode environment answers 409 `e2ee_required:`.
func (c *Client) SetOverride(
	ctx context.Context,
	org, project, env, name, ciphertext string,
) (*OverrideWrite, error) {
	var response struct {
		Override OverrideWrite `json:"override"`
	}
	body := map[string]any{"ciphertext": ciphertext}
	if err := c.Put(ctx, overridePath(org, project, env, name), body, &response); err != nil {
		return nil, err
	}
	return &response.Override, nil
}

// DeleteOverride removes the caller's override for a name. 404 when there is
// none.
func (c *Client) DeleteOverride(ctx context.Context, org, project, env, name string) error {
	return c.Delete(ctx, overridePath(org, project, env, name), nil, nil)
}
