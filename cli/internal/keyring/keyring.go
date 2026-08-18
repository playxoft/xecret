// Package keyring stores the CLI's credentials in the operating system's
// credential manager — macOS Keychain, Windows Credential Manager, or the
// Linux Secret Service — falling back to a 0600 file only when no manager is
// available, and saying so out loud.
//
// This is rule 2 of this binary: credentials never live in a dotfile a user
// might commit or sync to cloud storage *silently*. The fallback file exists
// because a headless Linux box has no Secret Service and the CLI must still
// work there, but it announces itself on every write so nobody mistakes it
// for the secure path.
package keyring

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	zkeyring "github.com/zalando/go-keyring"
)

// service namespaces every entry this binary writes.
const service = "xecret-cli"

// ErrNotFound is returned when no value is stored under a key.
var ErrNotFound = errors.New("not found")

// Store persists small named secrets. Implementations must never log values.
type Store interface {
	Set(key, value string) error
	Get(key string) (string, error)
	Delete(key string) error
}

// Warner receives the one-line notice when the file fallback engages.
type Warner func(format string, args ...any)

// Open returns the best store this machine offers.
//
// XECRET_KEYRING=file forces the file store — for containers and CI images
// where probing the system keyring wastes a helpful error. Anything else, or
// nothing, means: try the OS keyring, and fall back per-operation only when
// it is genuinely unavailable.
func Open(warn Warner) Store {
	if os.Getenv("XECRET_KEYRING") == "file" {
		return newFileStore(warn)
	}
	return &systemStore{fallback: newFileStore(warn), warn: warn}
}

// systemStore uses the OS credential manager, degrading to the file store
// when the platform has none. The degradation is sticky per operation, not
// per process: a Set that fell back must be readable by the next Get.
type systemStore struct {
	fallback *fileStore
	warn     Warner
}

func (s *systemStore) Set(key, value string) error {
	if err := zkeyring.Set(service, key, value); err != nil {
		s.warnOnce()
		return s.fallback.Set(key, value)
	}
	return nil
}

func (s *systemStore) Get(key string) (string, error) {
	value, err := zkeyring.Get(service, key)
	if err == nil {
		return value, nil
	}
	if errors.Is(err, zkeyring.ErrNotFound) {
		// The keyring works and has no entry — but an earlier Set may have
		// fallen back, so the file store gets the final word.
		return s.fallback.Get(key)
	}
	return s.fallback.Get(key)
}

func (s *systemStore) Delete(key string) error {
	keyringErr := zkeyring.Delete(service, key)
	fileErr := s.fallback.Delete(key)
	// Deleting a credential must succeed if it is gone from everywhere,
	// whichever store actually held it.
	if (keyringErr == nil || errors.Is(keyringErr, zkeyring.ErrNotFound)) &&
		(fileErr == nil || errors.Is(fileErr, ErrNotFound)) {
		return nil
	}
	if keyringErr != nil && !errors.Is(keyringErr, zkeyring.ErrNotFound) {
		return fmt.Errorf("removing credential from system keyring: %w", keyringErr)
	}
	return fileErr
}

func (s *systemStore) warnOnce() {
	if s.warn == nil || s.fallback.warned {
		return
	}
	s.fallback.warned = true
	s.warn(
		"no usable system keyring; storing credentials in %s (0600). Anyone with access to this file can act as you.",
		s.fallback.path,
	)
}

// fileStore is the 0600-file fallback: one JSON object of key → value.
type fileStore struct {
	path   string
	warn   Warner
	warned bool
}

func newFileStore(warn Warner) *fileStore {
	return &fileStore{path: filepath.Join(configDir(), "credentials.json"), warn: warn}
}

// configDir is ~/.xecret, creatable and private.
func configDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		// No home directory at all — extremely unusual. A relative path keeps
		// the CLI functional rather than panicking in a container.
		return ".xecret"
	}
	return filepath.Join(home, ".xecret")
}

// ConfigDir exposes the CLI's private directory for the cache package.
func ConfigDir() string { return configDir() }

func (f *fileStore) read() (map[string]string, error) {
	data, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading credential file: %w", err)
	}
	entries := map[string]string{}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &entries); err != nil {
			return nil, fmt.Errorf("credential file %s is corrupt; delete it and log in again", f.path)
		}
	}
	return entries, nil
}

func (f *fileStore) write(entries map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(f.path), 0o700); err != nil {
		return fmt.Errorf("creating %s: %w", filepath.Dir(f.path), err)
	}
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	// Write-then-rename so a crash cannot leave a half-written credential
	// file, and the temporary file is 0600 from birth — there is no window
	// where the content exists with wider permissions.
	tmp, err := os.CreateTemp(filepath.Dir(f.path), ".credentials-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), f.path)
}

func (f *fileStore) Set(key, value string) error {
	if f.warn != nil && !f.warned {
		f.warned = true
		f.warn(
			"storing credentials in %s (0600). Anyone with access to this file can act as you.",
			f.path,
		)
	}
	entries, err := f.read()
	if err != nil {
		return err
	}
	entries[key] = value
	return f.write(entries)
}

func (f *fileStore) Get(key string) (string, error) {
	entries, err := f.read()
	if err != nil {
		return "", err
	}
	value, ok := entries[key]
	if !ok {
		return "", ErrNotFound
	}
	return value, nil
}

func (f *fileStore) Delete(key string) error {
	entries, err := f.read()
	if err != nil {
		return err
	}
	if _, ok := entries[key]; !ok {
		return ErrNotFound
	}
	delete(entries, key)
	if len(entries) == 0 {
		if err := os.Remove(f.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	return f.write(entries)
}

// IsNotFound reports whether err means "nothing stored", from either backend.
func IsNotFound(err error) bool {
	return errors.Is(err, ErrNotFound) || errors.Is(err, zkeyring.ErrNotFound)
}
