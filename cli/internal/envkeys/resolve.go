package envkeys

import (
	"errors"
	"fmt"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/references"
)

// ── Version 2: an environment that reads from others ──
//
// An environment that inherits from a parent, or holds a template, is served as
// a version 2 bundle: its own `keys` and `secrets` exactly as version 1 carries
// them, plus a `layers` entry for every other environment the resolution
// touches — each with the caller's own grant for *that* environment, because
// every ciphertext is bound by its AAD to the environment that holds it and
// opens only under that environment's key. Nothing is re-encrypted into the
// reader's environment, and nothing could be: the server holds no key to do it
// with.
//
// So opening one is three steps, in an order that matters:
//
//  1. **Open every layer** under its own grant, and decrypt every row in it.
//     Every row is attempted and every failure is reported together, across all
//     layers, exactly as [BundleError] reports them for one.
//  2. **Build the graph** — environments, parent pointers, and each template's
//     declared references with the target the server resolved.
//  3. **Resolve** the environment being read, with `internal/references`, which
//     is the same algorithm the dashboard previews with.
//
// Only a complete answer comes back. A row that will not open, or a reference
// that will not resolve, fails the whole read: a partial environment injected
// into a child process is worse than none.

// ResolutionError is a version 2 bundle whose rows all opened and whose
// references do not resolve.
//
// It names the environment being read and carries the resolver's own sentence,
// which names secrets and references and never a value. `errors.As` reaches the
// [references.ResolutionError] beneath it, so a caller can branch on the kind.
type ResolutionError struct {
	Project     string
	Environment string
	Err         error
}

func (e *ResolutionError) Error() string {
	return fmt.Sprintf("%s/%s cannot be resolved: %v", e.Project, e.Environment, e.Err)
}

func (e *ResolutionError) Unwrap() error { return e.Err }

// decryptResolvedBundle is [DecryptBundle] for a version 2 bundle.
//
// ── What is checked before anything is believed ──
//
// The environment ids. The graph is built from the bundle's `environment.id`
// and each layer's `environmentId`, while the ciphertext is authenticated
// against the environment id in its own `keys` — the one the grant's AAD binds.
// Were the two allowed to differ, a server could hand over one environment's
// rows, correctly sealed and opening perfectly, filed in the graph under
// another environment's id: a qualified `${prod.DB_URL}` resolved from staging,
// with nothing in any decryption to say so. Requiring each pair to agree makes
// the graph's ids exactly the ones the cryptography vouched for.
//
// What is not checked is that a reference's resolved target carries the slug
// the template text names. Slugs are renameable and the declaration keeps the
// text as it was written; comparing the two would fail every template that
// outlived a rename, and the TypeScript does not compare them either.
func decryptResolvedBundle(bundle *api.EnvironmentBundle, principal *Principal) (map[string]string, error) {
	reading := bundle.Environment
	if reading == nil || reading.ID == "" {
		return nil, errors.New(
			"the server sent a version 2 bundle that does not say which environment it is; upgrade the server")
	}
	label := reading.ProjectSlug + "/" + reading.Slug
	if reading.ID != bundle.Keys.EnvironmentID {
		return nil, fmt.Errorf(
			"the bundle for %s names one environment and carries the key of another, so it was not read", label)
	}

	own, err := Open(bundle.Keys, principal)
	if err != nil {
		return nil, err
	}
	defer own.Close()

	opened := &openedGraph{graph: references.Graph{}}
	opened.decrypt(opened.environment(reading.ID, reading.ParentEnvironmentID), own, bundle.Secrets, "")

	for _, layer := range bundle.Layers {
		environment := opened.environment(layer.EnvironmentID, layer.ParentEnvironmentID)
		if len(layer.Secrets) == 0 {
			// A layer that contributes nothing needs no key — it is there so the
			// chain can be walked — and asking for one would refuse the read to a
			// principal nobody was ever going to share it with.
			continue
		}

		source := layer.ProjectSlug + "/" + layer.EnvironmentSlug
		if layer.Keys == nil {
			return nil, fmt.Errorf(
				"the bundle for %s carries secrets from %s with no key to open them, so it was not read", label, source)
		}
		if layer.Keys.EnvironmentID != layer.EnvironmentID {
			return nil, fmt.Errorf(
				"the bundle for %s files %s under one environment and its key under another, so it was not read",
				label, source)
		}

		material, err := Open(*layer.Keys, principal)
		if err != nil {
			return nil, fmt.Errorf("opening the key of %s, which %s reads from: %w", source, label, err)
		}
		opened.decrypt(environment, material, layer.Secrets, source)
		material.Close()
	}

	if len(opened.failures) > 0 {
		return nil, &BundleError{Failures: opened.failures, Total: opened.total}
	}

	resolved, err := references.ResolveEnvironment(opened.graph, reading.ID)
	if err != nil {
		return nil, &ResolutionError{Project: reading.ProjectSlug, Environment: reading.Slug, Err: err}
	}
	return resolved, nil
}

// openedGraph accumulates a version 2 bundle as its layers are opened.
type openedGraph struct {
	graph    references.Graph
	failures []RowFailure
	total    int
}

// environment returns the graph's node for an id, creating it the first time.
//
// The first sighting decides the parent. An environment can legitimately
// arrive twice — the one being read is also a layer when a sibling that
// inherits from it is the target of a reference — and the rows are the same
// rows either time; a second, different parent pointer would be the server
// contradicting itself, and the first answer is the one the reader's own
// `environment` block gave.
func (o *openedGraph) environment(id string, parent *string) *references.Environment {
	if existing, ok := o.graph[id]; ok {
		return existing
	}
	parentID := ""
	if parent != nil {
		parentID = *parent
	}
	environment := &references.Environment{ID: id, ParentID: parentID, Secrets: map[string]*references.Secret{}}
	o.graph[id] = environment
	return environment
}

// decrypt opens one layer's rows into its node. A failure is collected, never
// returned, so the report at the end is the whole list.
func (o *openedGraph) decrypt(
	environment *references.Environment,
	material *Material,
	rows []api.ClientSecret,
	source string,
) {
	for _, row := range rows {
		o.total++
		value, err := material.decryptRow(row)
		if err != nil {
			name := row.Name
			if source != "" {
				// Inherited and referenced rows say where they came from, because
				// "DATABASE_URL could not be decrypted" in a staging run that
				// inherits it from base is a sentence about the wrong environment.
				name = fmt.Sprintf("%s (from %s)", row.Name, source)
			}
			o.failures = append(o.failures, RowFailure{Name: name, Err: err})
			continue
		}
		if _, seen := environment.Secrets[row.Name]; seen {
			continue
		}
		environment.Secrets[row.Name] = graphSecret(row, value)
	}
}

// graphSecret is one decrypted row as the resolver reads it.
func graphSecret(row api.ClientSecret, value string) *references.Secret {
	declared := make([]references.DeclaredReference, 0, len(row.References))
	for _, reference := range row.References {
		target := ""
		if reference.EnvironmentID != nil {
			target = *reference.EnvironmentID
		}
		declared = append(declared, references.DeclaredReference{
			Reference: references.Reference{
				Project:     reference.Project,
				Environment: reference.Environment,
				Name:        reference.Name,
			},
			EnvironmentID: target,
		})
	}
	return &references.Secret{
		ID:         row.ID,
		Template:   row.Template,
		References: declared,
		Value:      value,
	}
}
