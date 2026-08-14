package cache

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/playxoft/xecret/cli/internal/keyring"
)

// memoryStore is an in-memory keyring.Store, so these tests never touch the
// machine's real keychain.
type memoryStore map[string]string

func (m memoryStore) Set(key, value string) error { m[key] = value; return nil }
func (m memoryStore) Get(key string) (string, error) {
	value, ok := m[key]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return value, nil
}
func (m memoryStore) Delete(key string) error {
	if _, ok := m[key]; !ok {
		return keyring.ErrNotFound
	}
	delete(m, key)
	return nil
}

func testScope() Scope {
	return Scope{Host: "https://xecret.example", Org: "acme", Project: "web", Environment: "dev"}
}

// isolateHome points the cache directory at a temp dir for one test.
func isolateHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
}

func TestWriteThenReadRoundTrips(t *testing.T) {
	isolateHome(t)
	store := memoryStore{}
	now := time.Now()

	secrets := map[string]string{"DATABASE_URL": "postgres://u:p@h/db", "EMPTY": ""}
	if err := Write(store, testScope(), secrets, now); err != nil {
		t.Fatal(err)
	}

	entry, err := Read(store, testScope())
	if err != nil {
		t.Fatal(err)
	}
	if entry.Secrets["DATABASE_URL"] != secrets["DATABASE_URL"] {
		t.Error("round trip lost a value")
	}
	if _, ok := entry.Secrets["EMPTY"]; !ok {
		t.Error("an empty value is a value; it must survive")
	}
}

func TestCiphertextIsNotPlaintext(t *testing.T) {
	isolateHome(t)
	store := memoryStore{}

	if err := Write(store, testScope(), map[string]string{"K": "super-secret-value"}, time.Now()); err != nil {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(Dir())
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected exactly one cache file, got %d (%v)", len(entries), err)
	}
	raw, _ := os.ReadFile(filepath.Join(Dir(), entries[0].Name()))
	if bytes.Contains(raw, []byte("super-secret-value")) || bytes.Contains(raw, []byte(`"K"`)) {
		t.Fatal("plaintext reached disk")
	}
}

func TestCacheFileModeIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not meaningful on Windows")
	}
	isolateHome(t)
	store := memoryStore{}
	if err := Write(store, testScope(), map[string]string{"K": "v"}, time.Now()); err != nil {
		t.Fatal(err)
	}

	entries, _ := os.ReadDir(Dir())
	info, err := entries[0].Info()
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("cache file mode = %o, want 0600", info.Mode().Perm())
	}
}

func TestTamperedFileIsRefused(t *testing.T) {
	isolateHome(t)
	store := memoryStore{}
	if err := Write(store, testScope(), map[string]string{"K": "v"}, time.Now()); err != nil {
		t.Fatal(err)
	}

	entries, _ := os.ReadDir(Dir())
	path := filepath.Join(Dir(), entries[0].Name())
	raw, _ := os.ReadFile(path)
	raw[len(raw)-1] ^= 0x01
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := Read(store, testScope()); err == nil {
		t.Fatal("a tampered cache file must not decrypt")
	}
}

// TestScopeRelocationIsRefused is the client-side version of the server's
// ciphertext-relocation defence: one environment's cache renamed into another
// scope's slot must fail verification, not decrypt into the wrong project.
func TestScopeRelocationIsRefused(t *testing.T) {
	isolateHome(t)
	store := memoryStore{}
	if err := Write(store, testScope(), map[string]string{"K": "v"}, time.Now()); err != nil {
		t.Fatal(err)
	}

	otherScope := testScope()
	otherScope.Environment = "production"

	entries, _ := os.ReadDir(Dir())
	source := filepath.Join(Dir(), entries[0].Name())
	if err := os.Rename(source, path(otherScope)); err != nil {
		t.Fatal(err)
	}

	if _, err := Read(store, otherScope); err == nil {
		t.Fatal("a relocated cache file must not decrypt under another scope")
	}
}

func TestReadWithoutWriteIsAMiss(t *testing.T) {
	isolateHome(t)
	if _, err := Read(memoryStore{}, testScope()); !errors.Is(err, ErrMiss) {
		t.Fatalf("want ErrMiss, got %v", err)
	}
}

func TestClearDestroysFilesAndKey(t *testing.T) {
	isolateHome(t)
	store := memoryStore{}
	if err := Write(store, testScope(), map[string]string{"K": "v"}, time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := Clear(store); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(Dir()); !errors.Is(err, os.ErrNotExist) {
		t.Error("cache directory should be gone")
	}
	if _, err := store.Get("cache-key"); !errors.Is(err, keyring.ErrNotFound) {
		t.Error("cache key should be gone — its absence is the cryptographic erasure")
	}
}
