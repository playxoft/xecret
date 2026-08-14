package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteThenLoadRoundTrips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)

	if err := Write(path, Config{Project: "my-app", Environment: "development"}); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Project != "my-app" || cfg.Environment != "development" {
		t.Errorf("round trip lost data: %+v", cfg)
	}
}

func TestWrittenFileSaysItHoldsNoSecrets(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)
	if err := Write(path, Config{Project: "p", Environment: "e"}); err != nil {
		t.Fatal(err)
	}

	content, _ := os.ReadFile(path)
	if !strings.Contains(string(content), "Secrets never live in this file") {
		t.Error("the header promise is part of the product; keep it")
	}
}

func TestFindWalksUpToTheProjectRoot(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "src", "app", "deep")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Write(filepath.Join(root, Filename), Config{Project: "p", Environment: "e"}); err != nil {
		t.Fatal(err)
	}

	path, cfg, err := Find(nested)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Project != "p" {
		t.Errorf("found the wrong config: %+v", cfg)
	}
	if path != filepath.Join(root, Filename) {
		t.Errorf("reported path %q, want the root's file", path)
	}
}

func TestFindReportsNotFound(t *testing.T) {
	_, _, err := Find(t.TempDir())
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if !strings.Contains(err.Error(), "xecret init") {
		t.Error("the error should say what to do next")
	}
}

func TestLoadRejectsMissingFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)
	if err := os.WriteFile(path, []byte("project: only-half\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("a config without an environment must be refused")
	}
}

func TestLoadRejectsInvalidYaml(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)
	if err := os.WriteFile(path, []byte("{{nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("junk YAML must be refused, not defaulted")
	}
}
