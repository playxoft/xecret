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
//
// ── What an end-to-end encrypted environment stores here ──
//
// Ciphertext, and the grant that opens it — never plaintext. The pull bundle is
// written verbatim, so a cache file for such an environment is encrypted twice
// over: once by this package under the cache key, and once by the environment's
// own data key, which lives nowhere on this machine except behind the vault key
// in the same keyring. Stealing the cache *and* the cache key still yields
// nothing without the vault key, which is a property the plaintext form cannot
// have however it is encrypted at rest.
//
// Those files carry a distinct AAD, so they land under a distinct name. That is
// not tidiness: it means a binary too old to understand a bundle finds no cache
// at all and says so, rather than reading an entry whose plaintext map is empty
// and injecting nothing into a child process that then fails somewhere else.
// Server-mode entries keep the AAD and the filename they have always had, so an
// upgrade does not invalidate one.
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

// ErrTooOld means an offline copy exists and is older than this run is willing
// to serve. See [ResolveMaxAge] for what the bound is for.
var ErrTooOld = errors.New("the offline copy is older than the age bound")

// keyStoreEntry is where the cache key lives in the keyring store.
const keyStoreEntry = "cache-key"

// Scope identifies whose secrets a cache file holds.
type Scope struct {
	Host        string
	Org         string
	Project     string
	Environment string
	// Encrypted marks an environment whose values this machine cannot read
	// without its vault key. It changes the AAD, and therefore the filename, so
	// the two kinds of entry can never be read as one another.
	Encrypted bool
}

// Entry is one cached environment, in exactly one of its two forms.
type Entry struct {
	FetchedAt time.Time `json:"fetchedAt"`
	// Secrets is the plaintext map, for a server-mode environment. The server
	// decrypted it, so there is nothing this machine could hold back.
	Secrets map[string]string `json:"secrets,omitempty"`
	// Bundle is the pull response verbatim, for an end-to-end encrypted one:
	// ciphertext plus the sealed grant, decrypted at use and never at rest.
	Bundle json.RawMessage `json:"bundle,omitempty"`
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
	identity := "xecret-cache-v1" + sep + scope.Host + sep + scope.Org + sep +
		scope.Project + sep + scope.Environment
	if scope.Encrypted {
		// Appended rather than versioned, so a server-mode entry written by any
		// earlier build still decrypts under exactly the string it was sealed
		// with. Bumping the version instead would turn every existing cache into
		// a verification failure on the first upgrade.
		return identity + sep + "e2ee"
	}
	return identity
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

// Write stores plaintext secrets for a server-mode scope, replacing any previous
// copy.
func Write(store keyring.Store, scope Scope, secrets map[string]string, now time.Time) error {
	if scope.Encrypted {
		// A caller that reached here with an e2ee scope is about to write
		// plaintext into a file the model says holds none. Refused rather than
		// tolerated: this is the one invariant the whole file exists for.
		return errors.New("an end-to-end encrypted environment caches ciphertext, not values")
	}
	return write(store, scope, Entry{FetchedAt: now.UTC(), Secrets: secrets})
}

// WriteBundle stores the pull bundle of an end-to-end encrypted environment.
//
// bundle is the response body verbatim. This package does not look inside it and
// could not use it if it did — the key that opens it is not one this package
// holds.
func WriteBundle(store keyring.Store, scope Scope, bundle []byte, now time.Time) error {
	if !scope.Encrypted {
		return errors.New("a server-mode environment caches values, not a bundle")
	}
	return write(store, scope, Entry{FetchedAt: now.UTC(), Bundle: bundle})
}

func write(store keyring.Store, scope Scope, entry Entry) error {
	cacheKey, err := key(store, true)
	if err != nil {
		return err
	}

	plaintext, err := json.Marshal(entry)
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

// Forget removes one scope's cache file, leaving every other scope and the
// cache key alone.
//
// Written for the pre-migration plaintext copy an environment leaves behind when
// it becomes end-to-end encrypted. Refusing to *serve* that file is only half an
// answer: it stays on disk, holding values from before the migration, for the
// next binary and for anybody who can read the directory. The e2ee read that
// establishes there is a better copy is the moment it stops having a reason to
// exist, so that is where it goes.
//
// A file that is already gone is not an error — this is called on a path whose
// job is something else, and "the thing I was going to delete does not exist"
// is the outcome that path wanted.
func Forget(scope Scope) error {
	if err := os.Remove(path(scope)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
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
