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

const acmeID = "0192f0a1-0000-7000-8000-00000000a001"

// `xecret init` pins the organisation by its id, and the file says so in
// plain YAML.
func TestTheOrganisationIdRoundTrips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)

	if err := Write(path, Config{Organization: acmeID, Project: "payments-api", Environment: "production"}); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(path)
	if !strings.Contains(string(content), "organization: "+acmeID+"\n") {
		t.Fatalf("the file does not record the organisation's id:\n%s", content)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Organization != acmeID || cfg.OrganizationID() != acmeID ||
		cfg.Project != "payments-api" || cfg.Environment != "production" {
		t.Errorf("round trip lost data: %+v", cfg)
	}
}

// Every file written before the organisation was recorded. It loads exactly as
// it did, naming no organisation, and a file written without one is still
// written in that shape.
func TestAFileWithNoOrganisationStillLoads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)
	old := "# xecret configuration — safe to commit. Secrets never live in this file.\n" +
		"# Slugs match the dashboard; change them with 'xecret init'.\n" +
		"project: my-app\nenvironment: development\n"
	if err := os.WriteFile(path, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Organization != "" || cfg.OrganizationID() != "" || cfg.Project != "my-app" || cfg.Environment != "development" {
		t.Errorf("an old file loaded differently: %+v", cfg)
	}

	if err := Write(path, Config{Project: "my-app", Environment: "development"}); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(path)
	if strings.Contains(string(content), "organization:") {
		t.Errorf("a file with no organisation grew an empty key:\n%s", content)
	}
}

// A hand-written file may name the organisation by its legacy slug, which the
// API still accepts. It loads, and is not mistaken for an id.
func TestALegacySlugOrganisationStillLoads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)
	if err := os.WriteFile(path, []byte("organization: acme\nproject: web\nenvironment: dev\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Organization != "acme" || cfg.OrganizationID() != "" {
		t.Errorf("a slug organisation loaded as %+v", cfg)
	}
}

// The id binds every secret's AAD as written, so one pasted in capitals is
// stored the way the server spells it.
func TestAnOrganisationIdIsStoredInCanonicalCase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)
	if err := os.WriteFile(path, []byte("organization: \" "+strings.ToUpper(acmeID)+" \"\nproject: web\nenvironment: dev\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Organization != acmeID {
		t.Errorf("organization = %q, want %q", cfg.Organization, acmeID)
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
