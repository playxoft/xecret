// Package config reads and writes .xecret.yaml — the file that pins a
// directory to an organisation, a project and an environment.
//
// The file holds identifiers only, never secrets, which is what makes it safe
// to commit. That property is structural: the Config struct has three fields,
// and nothing in this package will serialise anything else.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/playxoft/xecret/cli/internal/ids"
)

// Filename is fixed. A dotfile, at the project root, next to the lockfiles —
// where CI checkouts and teammates' clones will all find it.
const Filename = ".xecret.yaml"

// ErrNotFound means no .xecret.yaml exists here or in any parent directory.
var ErrNotFound = errors.New(
	"no " + Filename + " found. Run 'xecret init' in your project, or pass --project and --environment",
)

// Config is the entire file.
type Config struct {
	// Organization is the organisation's id. Optional, because every file
	// written before `xecret init` recorded it has none, and such a file
	// resolves in whichever organisation the credential addresses, as it always
	// did. A legacy slug is accepted here too, as the API accepts one; an id is
	// stored in its canonical lowercase spelling, because it is bound into every
	// secret's AAD as written.
	Organization string `yaml:"organization,omitempty"`
	// Project is the Project ID the dashboard shows, e.g. payments-api, and
	// Environment the environment's slug, e.g. production.
	Project     string `yaml:"project"`
	Environment string `yaml:"environment"`
}

// OrganizationID is the organisation's id when the file names it by one, and
// "" when it names none or names it by a legacy slug.
func (c *Config) OrganizationID() string {
	id, ok := ids.Canonical(c.Organization)
	if !ok {
		return ""
	}
	return id
}

// Find walks from dir upward to the filesystem root looking for the config,
// the way git finds .git — so `xecret run` works from any subdirectory of the
// project.
func Find(dir string) (string, *Config, error) {
	current, err := filepath.Abs(dir)
	if err != nil {
		return "", nil, err
	}

	for {
		path := filepath.Join(current, Filename)
		if _, statErr := os.Stat(path); statErr == nil {
			cfg, loadErr := Load(path)
			if loadErr != nil {
				return path, nil, loadErr
			}
			return path, cfg, nil
		}

		parent := filepath.Dir(current)
		if parent == current {
			return "", nil, ErrNotFound
		}
		current = parent
	}
}

// Load reads and validates one config file.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("%s is not valid YAML: %w", path, err)
	}

	cfg.Organization = strings.TrimSpace(cfg.Organization)
	if id, ok := ids.Canonical(cfg.Organization); ok {
		cfg.Organization = id
	}
	cfg.Project = strings.TrimSpace(cfg.Project)
	cfg.Environment = strings.TrimSpace(cfg.Environment)

	if cfg.Project == "" || cfg.Environment == "" {
		return nil, fmt.Errorf(
			"%s must name both a project and an environment. Run 'xecret init' to rewrite it",
			path,
		)
	}
	return &cfg, nil
}

// Write creates the file with a header that says what it is and what it will
// never contain. The values are written through the YAML encoder, not the
// template, so an identifier that needs quoting gets it.
func Write(path string, cfg Config) error {
	encoded, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}

	content := "# xecret configuration: safe to commit. Secrets never live in this file.\n" +
		"# Identifiers only: the organisation's id, the Project ID and the environment.\n" +
		"# Change them with 'xecret init'.\n" +
		string(encoded)

	// 0644 on purpose: this file is meant to be read, shared and committed.
	return os.WriteFile(path, []byte(content), 0o644)
}
