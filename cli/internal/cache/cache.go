// Package cache is the encrypted offline copy of an environment's secrets —
// what keeps a xecret outage from stopping every customer's `npm run dev`.
//
// Properties, in the order they matter:
//
//   - AES-256-GCM, with the cache key in the OS keychain (or its announced
//     fallback), never beside the ciphertext. Stealing ~/.xecret/cache alone
//     yields nothing.
//   - The AAD binds each file to (host, org, project, environment), the same
//     trick the server uses to stop ciphertext relocation: renaming one
//     project's cache file to another's makes it undecryptable, not wrong.
//   - Files and the directory are 0600/0700 from birth.
//   - The cache is only ever consulted after the API has *failed to answer* —
//     and only for network-shaped failures. A 401 or 403 never falls back:
//     a revoked token must not keep working out of a file (see api.IsNetworkError).
package cache

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/playxoft/xecret/cli/internal/keyring"
)

// ErrMiss means no usable cache entry exists for this scope.
var ErrMiss = errors.New("no offline copy of these secrets exists yet")

// keyStoreEntry is where the cache key lives in the keyring store.
const keyStoreEntry = "cache-key"

// Scope identifies whose secrets a cache file holds.
type Scope struct {
	Host        string
	Org         string
	Project     string
	Environment string
}

// Entry is one cached environment.
type Entry struct {
	FetchedAt time.Time         `json:"fetchedAt"`
	Secrets   map[string]string `json:"secrets"`
}

// Age is how stale this copy is, rounded for display.
func (e *Entry) Age(now time.Time) time.Duration {
	return now.Sub(e.FetchedAt).Round(time.Second)
}

// Dir is where cache files live.
func Dir() string { return filepath.Join(keyring.ConfigDir(), "cache") }

// path derives the file name from the scope by digest, so slugs never appear
// in a directory listing and no character in one can escape a filename.
func path(scope Scope) string {
	digest := sha256.Sum256([]byte(aad(scope)))
	return filepath.Join(Dir(), hex.EncodeToString(digest[:12])+".enc")
}

// aad is the canonical identity string bound into the ciphertext. The unit
// separator cannot appear in a slug or hostname, so two scopes can never
// concatenate to the same string.
func aad(scope Scope) string {
	const sep = "\x1f"
	return "xecret-cache-v1" + sep + scope.Host + sep + scope.Org + sep +
		scope.Project + sep + scope.Environment
}

// key loads the cache key, minting one on first use. The key is 32 random
// bytes that exist only in the keyring store — deleting it (logout does) is
// cryptographic erasure of every cache file at once.
func key(store keyring.Store, createIfMissing bool) ([]byte, error) {
	stored, err := store.Get(keyStoreEntry)
	if err == nil {
		decoded, decodeErr := base64.RawStdEncoding.DecodeString(stored)
		if decodeErr != nil || len(decoded) != 32 {
			return nil, errors.New("stored cache key is corrupt — run 'xecret cache clear'")
		}
		return decoded, nil
	}
	if !keyring.IsNotFound(err) {
		return nil, fmt.Errorf("reading cache key: %w", err)
	}
	if !createIfMissing {
		return nil, ErrMiss
	}

	fresh := make([]byte, 32)
	if _, err := rand.Read(fresh); err != nil {
		return nil, err
	}
	if err := store.Set(keyStoreEntry, base64.RawStdEncoding.EncodeToString(fresh)); err != nil {
		return nil, fmt.Errorf("storing cache key: %w", err)
	}
	return fresh, nil
}

// Write stores secrets for a scope, replacing any previous copy.
func Write(store keyring.Store, scope Scope, secrets map[string]string, now time.Time) error {
	cacheKey, err := key(store, true)
	if err != nil {
		return err
	}

	plaintext, err := json.Marshal(Entry{FetchedAt: now.UTC(), Secrets: secrets})
	if err != nil {
		return err
	}

	block, err := aes.NewCipher(cacheKey)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}

	sealed := gcm.Seal(nonce, nonce, plaintext, []byte(aad(scope)))

	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}

	// Write-then-rename, 0600 from birth: no moment exists where partial or
	// world-readable ciphertext is on disk under the final name.
	target := path(scope)
	tmp, err := os.CreateTemp(Dir(), ".cache-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(sealed); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}

// Read returns the cached entry for a scope, or ErrMiss.
func Read(store keyring.Store, scope Scope) (*Entry, error) {
	sealed, err := os.ReadFile(path(scope))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrMiss
	}
	if err != nil {
		return nil, err
	}

	cacheKey, err := key(store, false)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(cacheKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, errors.New("cache file is corrupt — run 'xecret cache clear'")
	}

	plaintext, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], []byte(aad(scope)))
	if err != nil {
		// Tampered, or renamed across scopes. Either way it is not the file
		// it claims to be, and it does not decrypt.
		return nil, errors.New("cache file failed verification — run 'xecret cache clear'")
	}

	var entry Entry
	if err := json.Unmarshal(plaintext, &entry); err != nil {
		return nil, errors.New("cache file is corrupt — run 'xecret cache clear'")
	}
	return &entry, nil
}

// Clear removes every cache file and forgets the cache key. Used by
// `xecret cache clear` and by logout.
func Clear(store keyring.Store) error {
	if err := os.RemoveAll(Dir()); err != nil {
		return err
	}
	if err := store.Delete(keyStoreEntry); err != nil && !keyring.IsNotFound(err) {
		return err
	}
	return nil
}
