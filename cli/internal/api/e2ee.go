package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
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

// EnvironmentKeys is GET …/keys, and the `keys` half of the pull bundle.
type EnvironmentKeys struct {
	// EncryptionMode is "e2ee" or "server". Every dual-mode decision the CLI
	// makes reads this rather than guessing from a response's shape.
	EncryptionMode string     `json:"encryptionMode"`
	EnvironmentID  string     `json:"environmentId"`
	ActiveEDK      *ActiveKey `json:"activeEdk"`
	// MyGrant is null when the caller has access but nobody has shared the key.
	MyGrant *MyGrant `json:"myGrant"`
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
}

// EnvironmentBundle is GET …/pull for an e2ee environment: the key state and
// every current ciphertext, read together so a rotation cannot land between two
// requests and leave the client holding a key for the wrong version.
type EnvironmentBundle struct {
	EncryptionMode string          `json:"encryptionMode"`
	Keys           EnvironmentKeys `json:"keys"`
	Secrets        []ClientSecret  `json:"secrets"`
}

// Pulled is what a pull produced, in whichever mode the environment is in.
//
// One type for both because every caller wants the same thing — "give me this
// environment" — and the difference is which field is populated. A caller that
// forgets to check `Bundle` gets an empty document rather than a decrypted one,
// which is the safe direction to be wrong in.
type Pulled struct {
	// Bundle is set for an e2ee environment. Its secrets are ciphertext.
	Bundle *EnvironmentBundle
	// Document is the server-rendered file for a server-mode environment,
	// verbatim, in the requested format.
	Document []byte
}

// Pull fetches an environment.
//
// The mode is read from the response rather than asked for in advance. An e2ee
// environment answers with a JSON object carrying `encryptionMode: "e2ee"`; a
// server-mode one answers with a rendered document, which for `format=json` is
// a flat name→value object that cannot be mistaken for a bundle. One request
// either way, and no window in which the mode could change between two.
func (c *Client) Pull(ctx context.Context, org, project, env, format string) (*Pulled, error) {
	raw, err := c.GetRaw(ctx, envPath(org, project, env)+"/pull?format="+url.QueryEscape(format))
	if err != nil {
		return nil, err
	}

	var bundle EnvironmentBundle
	if json.Unmarshal(raw, &bundle) == nil && bundle.EncryptionMode == "e2ee" {
		return &Pulled{Bundle: &bundle}, nil
	}
	return &Pulled{Document: raw}, nil
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

// CreateClientSecret writes a pre-encrypted secret.
//
// The id is minted here rather than by the server, and that is not a
// convenience: it is an AAD component, so the ciphertext is already sealed
// against it by the time this request is built. A server-assigned id would
// arrive after the only moment it could have been bound.
func (c *Client) CreateClientSecret(
	ctx context.Context,
	org, project, env, id, name string,
	value ClientValue,
	valueType string,
	encNote *string,
) (*WriteResult, error) {
	body := map[string]any{"id": id, "name": name, "value": value}
	if valueType != "" {
		body["valueType"] = valueType
	}
	if encNote != nil {
		body["encNote"] = *encNote
	}

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
func (c *Client) UpdateClientSecret(
	ctx context.Context,
	org, project, env, name string,
	value ClientValue,
	valueType string,
) (*WriteResult, error) {
	body := map[string]any{"value": value}
	if valueType != "" {
		body["valueType"] = valueType
	}

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
	ID      string      `json:"id"`
	Name    string      `json:"name"`
	Value   ClientValue `json:"value"`
	EncNote *string     `json:"encNote,omitempty"`
}

// RestoreClientSecret re-appends an earlier value, re-encrypted for the version
// it is about to become.
//
// The old ciphertext is never copied. It names version N in its AAD, and a copy
// stored as version N+1 would authenticate against nothing — which is the same
// reason the server re-encrypts on the `server`-mode path, done on the only side
// that can here.
func (c *Client) RestoreClientSecret(
	ctx context.Context,
	org, project, env, name string,
	version int,
	value ClientValue,
) (*RestoreResult, error) {
	var response struct {
		Secret RestoreResult `json:"secret"`
	}
	body := map[string]any{"version": version, "value": value}
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
