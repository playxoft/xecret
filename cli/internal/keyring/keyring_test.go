package keyring

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func isolatedFileStore(t *testing.T) *fileStore {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
	warnings := 0
	store := newFileStore(func(format string, args ...any) { warnings++ })
	return store
}

func TestFileStoreRoundTrip(t *testing.T) {
	store := isolatedFileStore(t)

	if err := store.Set("credentials", `{"token":"xct_live_x"}`); err != nil {
		t.Fatal(err)
	}
	value, err := store.Get("credentials")
	if err != nil {
		t.Fatal(err)
	}
	if value != `{"token":"xct_live_x"}` {
		t.Errorf("round trip lost data: %q", value)
	}
}

func TestFileStoreMissingKey(t *testing.T) {
	store := isolatedFileStore(t)
	if _, err := store.Get("absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestFileStorePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not meaningful on Windows")
	}
	store := isolatedFileStore(t)
	if err := store.Set("credentials", "value"); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(store.path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("credential file mode = %o, want 0600", info.Mode().Perm())
	}

	dirInfo, err := os.Stat(filepath.Dir(store.path))
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Errorf("directory mode = %o, want 0700", dirInfo.Mode().Perm())
	}
}

func TestFileStoreWarnsExactlyOnce(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
	warnings := 0
	store := newFileStore(func(format string, args ...any) { warnings++ })

	_ = store.Set("a", "1")
	_ = store.Set("b", "2")
	if warnings != 1 {
		t.Errorf("the fallback should announce itself once, warned %d times", warnings)
	}
}

func TestFileStoreDeleteRemovesEmptyFile(t *testing.T) {
	store := isolatedFileStore(t)
	_ = store.Set("only", "value")

	if err := store.Delete("only"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.path); !errors.Is(err, os.ErrNotExist) {
		t.Error("an empty credential file should not linger on disk")
	}
	if err := store.Delete("only"); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleting twice should be ErrNotFound, got %v", err)
	}
}
