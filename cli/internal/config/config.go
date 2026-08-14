// Package config reads and writes .xecret.yaml — the file that pins a
// directory to a project and an environment.
//
// The file holds identifiers only, never secrets, which is what makes it safe
// to commit. That property is structural: the Config struct has two fields,
// and nothing in this package will serialise anything else.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Filename is fixed. A dotfile, at the project root, next to the lockfiles —
// where CI checkouts and teammates' clones will all find it.
const Filename = ".xecret.yaml"

// ErrNotFound means no .xecret.yaml exists here or in any parent directory.
var ErrNotFound = errors.New(
	"no " + Filename + " found — run 'xecret init' in your project, or pass --project and --environment",
)

// Config is the entire file. Project and environment are slugs, exactly as
// they appear in the dashboard's URLs.
type Config struct {
	Project     string `yaml:"project"`
	Environment string `yaml:"environment"`
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

	cfg.Project = strings.TrimSpace(cfg.Project)
	cfg.Environment = strings.TrimSpace(cfg.Environment)

	if cfg.Project == "" || cfg.Environment == "" {
		return nil, fmt.Errorf(
			"%s must name both a project and an environment — run 'xecret init' to rewrite it",
			path,
		)
	}
	return &cfg, nil
}

// Write creates the file with a header that says what it is and what it will
// never contain. The values are written through the YAML encoder, not the
// template, so a slug that needs quoting gets it.
func Write(path string, cfg Config) error {
	encoded, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}

	content := "# xecret configuration — safe to commit. Secrets never live in this file.\n" +
		"# Slugs match the dashboard; change them with 'xecret init'.\n" +
		string(encoded)

	// 0644 on purpose: this file is meant to be read, shared and committed.
	return os.WriteFile(path, []byte(content), 0o644)
}
