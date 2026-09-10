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
// keyring; the wrap it opens comes from `GET /api/auth/vault`, and a copy of
// that wrap is kept beside it — see [StoreVaultWraps].
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
	"strings"

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

// VaultWrapsEntry is where the private-key wraps live, beside the User Key.
//
// ── Why the keyring and not the cache directory ──
//
// The alternative was a file in the 0600 cache directory, encrypted under the
// User Key. It would have been strictly more code — a second at-rest format,
// its own AAD, its own corruption story — for no property this does not already
// have. What is stored here is `encPrivateKeyEnc` and `signPrivateKeyEnc`
// verbatim: blobs that are *already* sealed under the User Key, by the browser,
// with an AAD binding the account and the purpose (spec §4.2). Encrypting them
// again under the same key would be theatre.
//
// So the only question is custody, and the answer is that these blobs are
// worthless without the User Key and the User Key is in this same store. Putting
// them anywhere else would create a second thing to forget on logout and a
// second thing to reason about when the store degrades to the file fallback.
// [ForgetUserKey] removes both, which keeps "deleting the User Key entry is
// cryptographic erasure" a true sentence rather than one with a footnote.
//
// **What is deliberately not stored** is the rest of `material`: the passphrase
// wrap, the KDF salt and its parameters. Those are the User Key under a *human*
// secret, and keeping them on disk would hand anybody who reads this store an
// offline guessing target against a passphrase — which is a strictly worse
// position than the one they are already in, and none of it is needed to go from
// the User Key to a private key.
const VaultWrapsEntry = "vault-wraps"

// ErrNoUserKey means this machine has never completed a hand-off.
var ErrNoUserKey = errors.New(
	"this login holds no vault key — run 'xecret login' again to hand one over",
)

// ErrNoVaultWraps means the User Key is here but the wraps it opens are not, and
// the API cannot be reached to fetch them.
//
// Its own error rather than [ErrNoUserKey] because the remedy is different and
// the situation is narrower: a login that predates this build stored the key
// without the wraps, and one online command is enough to fix it for ever.
var ErrNoVaultWraps = errors.New(
	"this machine has no offline copy of your vault's private key",
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

// MemberPrincipal derives the principal a CLI login is, preferring the server's
// answer and surviving without it.
//
// Two steps. The User Key comes from the keyring, where the login hand-off left
// it; the X25519 scalar is unwrapped from the private-key wrap, which is read
// fresh so that a vault reset or a key upgrade is picked up rather than cached
// into staleness — and recorded on the way past, so the next command can be run
// on a train.
//
// The fallback is for *unavailability only*, on the same terms the offline cache
// is: a network-shaped failure falls back, and every judgement the server makes
// — 401, 403, a vault that is not configured — is passed through. A revoked
// credential must not keep decrypting out of a keyring entry any more than it
// keeps reading out of a cache file.
func MemberPrincipal(
	ctx context.Context,
	client *api.Client,
	store keyring.Store,
	userID, orgID string,
) (*Principal, error) {
	if userID == "" || orgID == "" {
		return nil, ErrNoUserKey
	}

	vault, err := client.Vault(ctx)
	if err != nil {
		if !api.IsNetworkError(err) {
			return nil, err
		}
		return OfflineMemberPrincipal(store, userID, orgID)
	}
	if vault.Material == nil {
		return nil, errors.New("this account has no vault; set one up in the dashboard first")
	}

	// Recorded before it is used, and a failure to record is not fatal: the
	// material is correct for this command either way, and refusing to decrypt
	// over a keyring write would be trading the thing the user asked for against
	// a convenience for next time.
	_ = StoreVaultWraps(store, vault.Material)

	return openWith(store, userID, orgID, vault.Material.EncPrivateKeyEnc)
}

// OfflineMemberPrincipal derives the same principal from what this machine
// already holds, making no request at all.
//
// This is what `xecret run --offline` uses, and what the network-failure
// fallback lands on. It is a separate entry point rather than a flag on
// [MemberPrincipal] because the guarantee is different in kind: this function
// cannot reach the network, which is a property a reader can check by looking at
// its signature.
func OfflineMemberPrincipal(store keyring.Store, userID, orgID string) (*Principal, error) {
	if userID == "" || orgID == "" {
		return nil, ErrNoUserKey
	}

	wraps, err := readVaultWraps(store)
	if err != nil {
		return nil, err
	}
	return openWith(store, userID, orgID, wraps.EncPrivateKeyEnc)
}

// openWith unwraps the encryption scalar under the stored User Key. The one
// place either path arrives at, so both fail with the same words.
func openWith(store keyring.Store, userID, orgID, encPrivateKeyEnc string) (*Principal, error) {
	userKey, err := readUserKey(store)
	if err != nil {
		return nil, err
	}
	defer e2ee.ZeroizeKey(userKey)

	privateKey, err := e2ee.UnwrapPrivateKey(userKey, encPrivateKeyEnc, userID, e2ee.PurposeEncryption)
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

// vaultWraps is the part of `GET /api/auth/vault` this machine keeps, and no
// more of it. See [VaultWrapsEntry] for what is left behind and why.
type vaultWraps struct {
	EncPrivateKeyEnc  string `json:"encPrivateKeyEnc"`
	SignPrivateKeyEnc string `json:"signPrivateKeyEnc"`
}

// StoreVaultWraps records the two private-key wraps beside the User Key.
//
// Called from the login paths, which have the material in hand anyway, and from
// [MemberPrincipal], which is what fixes a login made by an earlier build: the
// first successful online command records them, and every command after it can
// be offline.
func StoreVaultWraps(store keyring.Store, material *api.VaultMaterial) error {
	if material == nil || material.EncPrivateKeyEnc == "" {
		return errors.New("this account's vault material carries no private key")
	}

	encoded, err := json.Marshal(vaultWraps{
		EncPrivateKeyEnc:  material.EncPrivateKeyEnc,
		SignPrivateKeyEnc: material.SignPrivateKeyEnc,
	})
	if err != nil {
		return err
	}
	if err := store.Set(VaultWrapsEntry, string(encoded)); err != nil {
		return fmt.Errorf("storing the vault's private key: %w", err)
	}
	return nil
}

// ForgetUserKey removes the User Key and the wraps it opens. Logout calls this;
// so does anything that discovers the stored key no longer opens anything.
//
// Both, in one function, because they are one credential: a wrap without its key
// opens nothing, but leaving it behind would make "delete the vault key" an
// erasure with a footnote, and every future caller would have to remember the
// second half.
func ForgetUserKey(store keyring.Store) error {
	if err := store.Delete(UserKeyEntry); err != nil && !keyring.IsNotFound(err) {
		return err
	}
	if err := store.Delete(VaultWrapsEntry); err != nil && !keyring.IsNotFound(err) {
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

func readVaultWraps(store keyring.Store) (*vaultWraps, error) {
	stored, err := store.Get(VaultWrapsEntry)
	if err != nil {
		if keyring.IsNotFound(err) {
			return nil, fmt.Errorf(
				"%w — run any command with the API reachable once, and this machine keeps it",
				ErrNoVaultWraps,
			)
		}
		return nil, fmt.Errorf("reading the vault's private key: %w", err)
	}

	var wraps vaultWraps
	if err := json.Unmarshal([]byte(stored), &wraps); err != nil || wraps.EncPrivateKeyEnc == "" {
		return nil, fmt.Errorf("%w: the stored copy is corrupt", ErrNoVaultWraps)
	}
	return &wraps, nil
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
	value, err := m.decryptRow(secret)
	if err != nil {
		return "", fmt.Errorf("%s: %w", secret.Name, err)
	}
	return value, nil
}

// decryptRow is the same operation without the name in front of the error, for
// [DecryptBundle] — which prints the name itself, once, in a list.
func (m *Material) decryptRow(secret api.ClientSecret) (string, error) {
	if secret.EnvDataKeyID != "" && secret.EnvDataKeyID != m.EnvDataKeyID {
		return "", ErrRotatedAway
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

// RowFailure is one secret of a pull that did not open, and why.
type RowFailure struct {
	Name string
	Err  error
}

// BundleError is every row that failed, reported together.
//
// ── Why the whole list, and not the first one ──
//
// A pull fails as a unit — see [DecryptBundle] — but *stopping* at the first bad
// row and *reporting* only the first bad row are different decisions, and only
// the first is justified. The situation this shows up in is a rotation that
// re-sealed some rows and not others, or a principal whose grant is for a key
// version half the environment has moved off. Reported one row at a time, that
// is a user running the same command four times, fixing one name per attempt,
// with no way to tell after the first whether they are looking at a mid-rotation
// environment or at four unrelated problems. The answer to "what is wrong with
// this environment" is the list.
type BundleError struct {
	// Failures is in the order the bundle listed them, so two runs against the
	// same environment produce the same message.
	Failures []RowFailure
	// Total is how many secrets the bundle held, which is what makes "3 of 4"
	// readable as a mid-rotation environment rather than as a broken key.
	Total int
}

func (e *BundleError) Error() string {
	var out strings.Builder
	fmt.Fprintf(&out, "%d of %d secrets in this environment could not be decrypted:",
		len(e.Failures), e.Total)
	for _, failure := range e.Failures {
		fmt.Fprintf(&out, "\n  %s: %v", failure.Name, failure.Err)
	}
	if e.AllRotatedAway() {
		// Only when every failure is one, because the instruction is only correct
		// then: rewriting a secret whose ciphertext is damaged for some other
		// reason destroys the evidence and fixes nothing.
		out.WriteString(
			"\n  Every one of them names a key that has been rotated away. " +
				"Their current values were written before the rotation and cannot be recovered by anyone; " +
				"set them again to store them under the environment's current key.")
	}
	return out.String()
}

// Unwrap exposes the row errors so `errors.Is` answers about the set.
//
// Note what that means for [ErrRotatedAway]: it matches when *any* row names a
// retired key, which is the right question for "does this error involve a
// rotation" and the wrong one for "is a rewrite the remedy". The second question
// is [BundleError.AllRotatedAway], and the hint above asks it.
func (e *BundleError) Unwrap() []error {
	unwrapped := make([]error, 0, len(e.Failures))
	for _, failure := range e.Failures {
		unwrapped = append(unwrapped, failure.Err)
	}
	return unwrapped
}

// AllRotatedAway reports whether every failure is a row naming a retired key.
func (e *BundleError) AllRotatedAway() bool {
	if len(e.Failures) == 0 {
		return false
	}
	for _, failure := range e.Failures {
		if !errors.Is(failure.Err, ErrRotatedAway) {
			return false
		}
	}
	return true
}

// DecryptBundle opens every secret in a pull, returning the flat map the rest of
// the CLI already speaks.
//
// A row that cannot be read fails the whole pull rather than being skipped. A
// partial environment injected into a child process is worse than none: the
// child starts, reads a variable that is silently absent, and fails somewhere
// far away from the cause.
//
// Every row is still attempted, though, and the failures are reported together —
// see [BundleError]. Aborting on the first one costs nothing at the time and
// costs the user a diagnosis afterwards, because the shape of the answer ("these
// four, all naming the old key") is what says whether this is a rotation in
// progress or something else entirely.
func DecryptBundle(bundle *api.EnvironmentBundle, principal *Principal) (map[string]string, error) {
	material, err := Open(bundle.Keys, principal)
	if err != nil {
		return nil, err
	}
	defer material.Close()

	secrets := make(map[string]string, len(bundle.Secrets))
	var failures []RowFailure
	for _, secret := range bundle.Secrets {
		value, err := material.decryptRow(secret)
		if err != nil {
			failures = append(failures, RowFailure{Name: secret.Name, Err: err})
			continue
		}
		secrets[secret.Name] = value
	}

	if len(failures) > 0 {
		return nil, &BundleError{Failures: failures, Total: len(bundle.Secrets)}
	}
	return secrets, nil
}

// ValidateKdfParams is the client-side policy control over server-supplied
// Argon2id parameters, exposed for the headless login path and for doctor.
func ValidateKdfParams(raw json.RawMessage) error {
	_, err := e2ee.ParseKdfParams(raw)
	return err
}
