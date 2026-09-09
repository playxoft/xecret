// Package envkeys is how this process comes to hold an environment's keys.
//
// It is to the CLI what `components/envkeys/env-keys.ts` is to the browser: the
// one module that composes cryptography, so that no command does. A command asks
// for "the key for this environment" and gets it, or gets a reason it cannot
// have one; which AAD, which principal, and what gets wiped when are decided
// here.
//
// ── Two principals, one operation ──
//
// A **service token** carries its own X25519 scalar in its token string (spec
// §13.1). It needs nothing else: no vault, no passphrase, no round trip. That is
// the whole reason the key half exists, and it is what makes `xecret run` in CI
// a single request.
//
// A **CLI token** acts as its user, so its grants are sealed to that user's
// public key and the private half is a wrap under the User Key. The User Key
// arrives once, at login, over the hand-off (spec §13.2) and lives in the OS
// keyring; the private key is unwrapped from `GET /api/auth/vault` at use.
//
// The difference is two AAD components. Everything downstream — opening a grant,
// decrypting a value, computing a valueHmac — is identical, which is why a
// rotation re-seals to both without caring which is which.
package envkeys

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/keyring"
)

// UserKeyEntry is where the hand-off leaves the User Key.
//
// Beside the cache key in the same store, for the same reason: deleting it —
// which logout does — is cryptographic erasure of everything this machine could
// read.
const UserKeyEntry = "user-key"

// ErrNoUserKey means this machine has never completed a hand-off.
var ErrNoUserKey = errors.New(
	"this login holds no vault key — run 'xecret login' again to hand one over",
)

// ErrNoGrant means the caller has access to an environment but nobody has shared
// its key. A designed state, not a failure: an admin granted access without
// holding the key, or a rotation has not reached this principal yet.
var ErrNoGrant = errors.New(
	"you have access to this environment but nobody has shared its key with you yet",
)

// ErrRotatedAway means a secret version was written under a key that has since
// been rotated. There is no way to recover it: only the active grant is served,
// and the retired key was never stored anywhere.
var ErrRotatedAway = errors.New(
	"this version was written under a key that has since been rotated away",
)

// Principal is the identity a grant is opened as.
type Principal struct {
	Kind e2ee.RecipientKind
	// ID is the user id for a member, the service-token id for a token. An AAD
	// component either way.
	ID string
	// OrgID is a component of every secret's AAD. Slugs are renameable; this is
	// not, which is why the AAD binds the id.
	OrgID string
	// PrivateKey is the X25519 scalar this principal opens grants with.
	PrivateKey []byte
}

// Close wipes the private key. Every command that resolves a principal defers it.
func (p *Principal) Close() {
	if p == nil {
		return
	}
	for i := range p.PrivateKey {
		p.PrivateKey[i] = 0
	}
}

// ServicePrincipal derives the principal a service token is.
//
// No network, no keyring, no vault: the scalar is in the token string. A legacy
// single-half token has none, and the error says so rather than failing later
// with an undecryptable grant.
func ServicePrincipal(token string, self *api.TokenSelf) (*Principal, error) {
	parsed, err := e2ee.SplitServiceToken(token)
	if err != nil {
		return nil, fmt.Errorf("reading XECRET_TOKEN: %w", err)
	}
	if parsed.PrivateKey == nil {
		return nil, errors.New(
			"this service token was minted before end-to-end encryption and holds no key — " +
				"mint a replacement from the dashboard",
		)
	}
	if self.Token.ID == "" || self.Organization.ID == "" {
		return nil, errors.New("the server did not identify this token; upgrade it")
	}

	return &Principal{
		Kind:       e2ee.RecipientToken,
		ID:         self.Token.ID,
		OrgID:      self.Organization.ID,
		PrivateKey: parsed.PrivateKey,
	}, nil
}

// MemberPrincipal derives the principal a CLI login is.
//
// Two steps, and both are unavoidable. The User Key comes from the keyring,
// where the login hand-off left it; the X25519 scalar is unwrapped from the
// vault material, which is read fresh so that a passphrase change or a key
// upgrade is picked up rather than cached into staleness.
func MemberPrincipal(
	ctx context.Context,
	client *api.Client,
	store keyring.Store,
	userID, orgID string,
) (*Principal, error) {
	if userID == "" || orgID == "" {
		return nil, ErrNoUserKey
	}

	userKey, err := readUserKey(store)
	if err != nil {
		return nil, err
	}
	defer func() {
		for i := range userKey {
			userKey[i] = 0
		}
	}()

	vault, err := client.Vault(ctx)
	if err != nil {
		return nil, err
	}
	if vault.Material == nil {
		return nil, errors.New("this account has no vault; set one up in the dashboard first")
	}

	privateKey, err := e2ee.UnwrapPrivateKey(
		userKey, vault.Material.EncPrivateKeyEnc, userID, e2ee.PurposeEncryption,
	)
	if err != nil {
		// The stored User Key does not open this account's private key. A vault
		// reset is the usual cause, and the fix is the same in every case.
		return nil, fmt.Errorf("%w: run 'xecret login' again", ErrNoUserKey)
	}

	return &Principal{
		Kind:       e2ee.RecipientMember,
		ID:         userID,
		OrgID:      orgID,
		PrivateKey: privateKey,
	}, nil
}

// StoreUserKey records the User Key a hand-off produced.
func StoreUserKey(store keyring.Store, userKey []byte) error {
	if len(userKey) != e2ee.KeyBytes {
		return fmt.Errorf("a User Key is %d bytes", e2ee.KeyBytes)
	}
	if err := store.Set(UserKeyEntry, e2ee.EncodeKey(userKey)); err != nil {
		return fmt.Errorf("storing the vault key: %w", err)
	}
	return nil
}

// ForgetUserKey removes it. Logout calls this; so does anything that discovers
// the stored key no longer opens anything.
func ForgetUserKey(store keyring.Store) error {
	if err := store.Delete(UserKeyEntry); err != nil && !keyring.IsNotFound(err) {
		return err
	}
	return nil
}

func readUserKey(store keyring.Store) ([]byte, error) {
	stored, err := store.Get(UserKeyEntry)
	if err != nil {
		if keyring.IsNotFound(err) {
			return nil, ErrNoUserKey
		}
		return nil, fmt.Errorf("reading the vault key: %w", err)
	}

	userKey, err := e2ee.DecodeKey(stored)
	if err != nil {
		return nil, fmt.Errorf("%w: the stored vault key is corrupt", ErrNoUserKey)
	}
	return userKey, nil
}

// Material is an environment's keys, opened, with the identity of the key
// version they belong to.
type Material struct {
	EnvironmentID string
	EnvDataKeyID  string
	EDKVersion    int
	Keys          e2ee.EnvironmentKeys
	// OrgID travels with the material because every secret AAD needs it and no
	// caller should be assembling one from two sources.
	OrgID string
}

// Close wipes both keys.
func (m *Material) Close() {
	if m != nil {
		m.Keys.Zeroize()
	}
}

// Open opens an environment's grant.
//
// The version comes from the grant's own key state, never from a second read: a
// grant for version 3 does not open as a grant for version 4, so opening against
// anything but the state that carried the blob is a race with a rotation.
func Open(keys api.EnvironmentKeys, principal *Principal) (*Material, error) {
	if keys.EncryptionMode != "e2ee" {
		return nil, fmt.Errorf("this environment uses server-side encryption")
	}
	if keys.ActiveEDK == nil {
		return nil, errors.New("this environment has no active key")
	}
	if keys.MyGrant == nil {
		return nil, ErrNoGrant
	}

	recipient := e2ee.GrantRecipient{
		EnvironmentID: keys.EnvironmentID,
		EDKVersion:    keys.ActiveEDK.Version,
		RecipientKind: principal.Kind,
		RecipientID:   principal.ID,
	}

	opened, err := e2ee.OpenGrant(recipient, principal.PrivateKey, e2ee.SealedGrant{
		EDKSealed: keys.MyGrant.EDKSealed,
		EHKSealed: keys.MyGrant.EHKSealed,
	})
	if err != nil {
		return nil, err
	}

	return &Material{
		EnvironmentID: keys.EnvironmentID,
		EnvDataKeyID:  keys.ActiveEDK.ID,
		EDKVersion:    keys.ActiveEDK.Version,
		Keys:          opened,
		OrgID:         principal.OrgID,
	}, nil
}

// DecryptSecret opens one row of a pull bundle.
//
// A row naming a retired key is reported as [ErrRotatedAway] rather than as a
// decryption failure, because the two need different words: one is "nobody can
// read this any more", the other is "something is wrong".
func (m *Material) DecryptSecret(secret api.ClientSecret) (string, error) {
	if secret.EnvDataKeyID != "" && secret.EnvDataKeyID != m.EnvDataKeyID {
		return "", fmt.Errorf("%s: %w", secret.Name, ErrRotatedAway)
	}

	return e2ee.DecryptSecret(m.Keys.EDK, e2ee.SecretContext{
		Field:         e2ee.FieldValue,
		OrgID:         m.OrgID,
		EnvironmentID: m.EnvironmentID,
		SecretID:      secret.ID,
		Version:       secret.Version,
	}, secret.Ciphertext)
}

// EncryptSecret seals a value for the version it will be stored as.
//
// **The version being written, not the one being read.** That distinction is
// what makes a restore a re-encryption rather than a copy: bytes produced for
// version 3 and stored as version 7 authenticate against nothing.
func (m *Material) EncryptSecret(secretID string, version int, plaintext string) (api.ClientValue, error) {
	ciphertext, err := e2ee.EncryptSecret(m.Keys.EDK, e2ee.SecretContext{
		Field:         e2ee.FieldValue,
		OrgID:         m.OrgID,
		EnvironmentID: m.EnvironmentID,
		SecretID:      secretID,
		Version:       version,
	}, plaintext)
	if err != nil {
		return api.ClientValue{}, err
	}

	valueHmac, err := e2ee.ComputeValueHmac(m.Keys.EHK, plaintext)
	if err != nil {
		return api.ClientValue{}, err
	}

	return api.ClientValue{
		Ciphertext:      ciphertext,
		ClientAlgorithm: ClientAlgorithm,
		EnvDataKeyID:    m.EnvDataKeyID,
		ValueHmac:       e2ee.EncodeValueHmac(valueHmac),
	}, nil
}

// EncryptNote seals a note. Notes live on the secrets row, so their AAD carries
// no version.
func (m *Material) EncryptNote(secretID, note string) (string, error) {
	return e2ee.EncryptSecret(m.Keys.EDK, e2ee.SecretContext{
		Field:         e2ee.FieldNote,
		OrgID:         m.OrgID,
		EnvironmentID: m.EnvironmentID,
		SecretID:      secretID,
	}, note)
}

// ClientAlgorithm is the label recorded beside every value this client writes.
//
// Stated once and sent verbatim. The server draws no conclusion from it — the
// blob's own xk2.gcm. prefix is what a reader parses — so its job is to let an
// operator answer "what wrote this row" without decoding anything.
const ClientAlgorithm = "xk2.gcm"

// DecryptBundle opens every secret in a pull, returning the flat map the rest of
// the CLI already speaks.
//
// A row that cannot be read stops the whole pull rather than being skipped. A
// partial environment injected into a child process is worse than none: the
// child starts, reads a variable that is silently absent, and fails somewhere
// far away from the cause.
func DecryptBundle(bundle *api.EnvironmentBundle, principal *Principal) (map[string]string, error) {
	material, err := Open(bundle.Keys, principal)
	if err != nil {
		return nil, err
	}
	defer material.Close()

	secrets := make(map[string]string, len(bundle.Secrets))
	for _, secret := range bundle.Secrets {
		value, err := material.DecryptSecret(secret)
		if err != nil {
			return nil, err
		}
		secrets[secret.Name] = value
	}
	return secrets, nil
}

// ValidateKdfParams is the client-side policy control over server-supplied
// Argon2id parameters, exposed for the headless login path and for doctor.
func ValidateKdfParams(raw json.RawMessage) error {
	_, err := e2ee.ParseKdfParams(raw)
	return err
}
