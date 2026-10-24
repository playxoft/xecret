package references

import (
	"fmt"
	"sort"
	"strings"
)

// Inheritance and reference resolution, as one traversal shared by every party.
//
// ── The resolution order, written down (P19 §1) ──
//
//  1. **An environment's view** is its own secrets laid over its parent's view,
//     recursively: a child's value overrides, a name the child does not set
//     falls through to the nearest ancestor that does. The chain is at most
//     [MaxInheritanceDepth] ancestors long and may not loop.
//  2. **A non-template secret** resolves to its value, verbatim.
//  3. **A template** resolves to its text with every reference replaced:
//     - `${KEY}` by KEY in the view of the environment **being read** — so a
//     template inherited from `base` sees the child's overrides, which is the
//     point of putting a template in a parent;
//     - `${env.KEY}` and `${project.env.KEY}` by KEY in the view of that
//     environment, resolved as if that environment were being read.
//  4. **References nest** up to [MaxReferenceDepth] hops, and a loop is an
//     error, never an infinite expansion.
//
// The server walks the same algorithm over metadata — names and the references
// each template declared — to refuse a cycle or a dangling reference before it
// is stored. This copy runs over decrypted values to produce what `xecret run`
// injects, and for it a cycle is the backstop for a state the server should
// never have allowed: reported as an error rather than resolved partially,
// because a partial environment injected into a process is worse than none.

// DeclaredReference is a reference as a writer declared it: the text it wrote,
// and where the server resolved that text to.
//
// An empty EnvironmentID is an unqualified `${KEY}` — the wire's `null`. It
// means "the environment being read", which is only known at resolution time
// and is exactly why it is not stored as an id.
type DeclaredReference struct {
	Reference
	EnvironmentID string
}

// Secret is what the traversal needs to know about one secret, with its value
// already in hand.
type Secret struct {
	ID string
	// Template is whether the value's text is read for references. Anything
	// else is literal, for ever — see the package header.
	Template bool
	// References is what the writer declared. Empty for a non-template.
	References []DeclaredReference
	Value      string
}

// Environment is one environment of the graph.
type Environment struct {
	ID string
	// ParentID is empty for an environment that inherits from nothing.
	ParentID string
	// Secrets is the environment's own secrets, by name. Inherited ones are not
	// repeated here.
	Secrets map[string]*Secret
}

// Graph is every environment a resolution may touch, by id.
type Graph map[string]*Environment

// ErrorKind says what kind of resolution failure an error is. The strings are
// the TypeScript's, verbatim, because the shared fixtures name them.
type ErrorKind string

const (
	// KindInheritanceCycle: an environment's parent chain returns to itself.
	KindInheritanceCycle ErrorKind = "inheritanceCycle"
	// KindInheritanceTooDeep: more than MaxInheritanceDepth ancestors.
	KindInheritanceTooDeep ErrorKind = "inheritanceTooDeep"
	// KindMissingEnvironment: a chain or a reference names an environment this
	// graph does not hold.
	KindMissingEnvironment ErrorKind = "missingEnvironment"
	// KindUnresolved: a reference names a secret the target view does not hold.
	KindUnresolved ErrorKind = "unresolved"
	// KindCycle: following references returns to a secret already being
	// resolved.
	KindCycle ErrorKind = "cycle"
	// KindTooDeep: more than MaxReferenceDepth hops.
	KindTooDeep ErrorKind = "tooDeep"
	// KindUndeclared: a template's text holds a reference its declaration does
	// not, or the reverse.
	KindUndeclared ErrorKind = "undeclared"
	// KindSyntax: a template's text is not valid template syntax.
	KindSyntax ErrorKind = "syntax"
)

// ResolutionError is why a resolution failed.
//
// It carries reference keys and secret names — identifiers the caller can
// already list — and never a value. Path is the chain of `environmentId:NAME`
// nodes that led here, so a cycle report can name every hop.
type ResolutionError struct {
	Kind    ErrorKind
	Message string
	Path    []string
	// MissingEnvironmentID is, for KindMissingEnvironment, the environment the
	// graph did not hold.
	MissingEnvironmentID string
}

func (e *ResolutionError) Error() string { return e.Message }

// VisitedSecret is one node of a resolution: a name, as one environment sees
// it.
type VisitedSecret struct {
	// ContextID is the environment whose view the name was looked up in.
	ContextID string
	Name      string
	// DefinedIn is the environment whose own secret it turned out to be.
	DefinedIn string
	SecretID  string
}

// InheritanceChain is the parent chain of an environment, nearest first and
// including itself.
//
// It refuses a loop and a chain past the depth limit rather than truncating it:
// a truncated chain is a view with names silently missing.
func InheritanceChain(graph Graph, environmentID string) ([]*Environment, error) {
	var chain []*Environment
	seen := map[string]bool{}
	current := environmentID

	for current != "" {
		if seen[current] {
			return nil, &ResolutionError{
				Kind:    KindInheritanceCycle,
				Message: "This environment inherits from itself through its parents.",
				Path:    chainIDs(chain),
			}
		}
		seen[current] = true

		environment, ok := graph[current]
		if !ok {
			return nil, &ResolutionError{
				Kind:                 KindMissingEnvironment,
				Message:              "An environment in this inheritance chain is not available.",
				Path:                 []string{current},
				MissingEnvironmentID: current,
			}
		}

		chain = append(chain, environment)
		// More than MaxInheritanceDepth *ancestors*: the environment itself is
		// the first entry, so the chain may be one longer than the limit.
		if len(chain) > MaxInheritanceDepth+1 {
			return nil, &ResolutionError{
				Kind:    KindInheritanceTooDeep,
				Message: fmt.Sprintf("An environment may inherit through at most %d parents.", MaxInheritanceDepth),
				Path:    chainIDs(chain),
			}
		}
		current = environment.ParentID
	}

	return chain, nil
}

func chainIDs(chain []*Environment) []string {
	ids := make([]string, len(chain))
	for i, environment := range chain {
		ids[i] = environment.ID
	}
	return ids
}

// LookupInView is a name as an environment sees it, or a nil secret when no
// layer of its chain sets it.
//
// The whole chain is walked — and so checked — before the answer is read, as
// the TypeScript does: a name found in the first layer of a chain that loops
// further up is still a lookup in a broken view.
func LookupInView(graph Graph, contextID, name string) (*Environment, *Secret, error) {
	chain, err := InheritanceChain(graph, contextID)
	if err != nil {
		return nil, nil, err
	}
	for _, environment := range chain {
		if secret, ok := environment.Secrets[name]; ok {
			return environment, secret, nil
		}
	}
	return nil, nil, nil
}

// EnvironmentView is every name an environment sees, in name order — by byte,
// which for the ASCII names this product allows is the code-unit order the
// TypeScript sorts by, so two runs of the same resolution produce the same
// document.
//
// The nearest layer wins, which is the "child overrides parent" half of the
// resolution order.
func EnvironmentView(graph Graph, contextID string) ([]string, error) {
	chain, err := InheritanceChain(graph, contextID)
	if err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	var names []string
	for _, environment := range chain {
		for name := range environment.Secrets {
			if !seen[name] {
				seen[name] = true
				names = append(names, name)
			}
		}
	}
	sort.Strings(names)
	return names, nil
}

func nodeKey(contextID, name string) string { return contextID + ":" + name }

// describeNode turns `environmentId:NAME` into `NAME` for a message; the id is
// in Path for whoever needs it.
func describeNode(key string) string {
	if separator := strings.LastIndexByte(key, ':'); separator >= 0 {
		return key[separator+1:]
	}
	return key
}

// with is append that never writes into the caller's backing array. The
// TypeScript builds a fresh array at every hop (`[...stack, key]`); sharing one
// here would let a sibling branch overwrite the path a deeper one is still
// reading.
func with(stack []string, key string) []string {
	next := make([]string, len(stack), len(stack)+1)
	copy(next, stack)
	return append(next, key)
}

// Visitor is called once per node, after its references have been walked — so
// a renderer can build a node from nodes already built.
type Visitor func(node VisitedSecret, secret *Secret) error

// WalkReferences walks every reference reachable from one name, as one
// environment sees it.
//
// memo is shared across calls so that a diamond — two templates referring to
// the same third — walks the third once, and so that resolving a whole
// environment is linear in the number of edges rather than in the number of
// paths. It records each finished node's *height* — the longest chain of hops
// beneath it — because a node first finished at depth 1 may be reached again
// at depth 4, and skipping it then without asking how deep its subtree goes
// would let a chain past the limit through by the back door.
func WalkReferences(graph Graph, contextID, name string, visit Visitor, memo map[string]int) error {
	if memo == nil {
		memo = map[string]int{}
	}
	_, err := walk(graph, contextID, name, 0, nil, memo, visit)
	return err
}

func tooDeep(name string, path []string) *ResolutionError {
	return &ResolutionError{
		Kind:    KindTooDeep,
		Message: fmt.Sprintf("References may nest at most %d deep, and %s is past that.", MaxReferenceDepth, name),
		Path:    path,
	}
}

// walk returns the node's height: 0 for a value, 1 + the tallest reference for
// a template.
func walk(
	graph Graph,
	contextID, name string,
	depth int,
	stack []string,
	memo map[string]int,
	visit Visitor,
) (int, error) {
	key := nodeKey(contextID, name)
	if finished, ok := memo[key]; ok {
		if depth+finished > MaxReferenceDepth {
			return 0, tooDeep(name, with(stack, key))
		}
		return finished, nil
	}

	for i, entry := range stack {
		if entry != key {
			continue
		}
		hops := make([]string, 0, len(stack)-i+1)
		for _, hop := range with(stack[i:], key) {
			hops = append(hops, describeNode(hop))
		}
		return 0, &ResolutionError{
			Kind:    KindCycle,
			Message: fmt.Sprintf("These references form a loop: %s.", strings.Join(hops, " → ")),
			Path:    with(stack, key),
		}
	}

	environment, secret, err := LookupInView(graph, contextID, name)
	if err != nil {
		return 0, err
	}
	if secret == nil {
		via := ""
		if len(stack) > 0 {
			via = fmt.Sprintf(" (referenced by %s)", describeNode(stack[len(stack)-1]))
		}
		return 0, &ResolutionError{
			Kind:    KindUnresolved,
			Message: fmt.Sprintf("The reference to %s cannot be resolved%s: no environment in its view sets it.", name, via),
			Path:    with(stack, key),
		}
	}

	height := 0
	if secret.Template && len(secret.References) > 0 {
		if depth >= MaxReferenceDepth {
			return 0, tooDeep(name, with(stack, key))
		}

		next := with(stack, key)
		for _, reference := range secret.References {
			target := contextID
			if reference.EnvironmentID != "" {
				if _, ok := graph[reference.EnvironmentID]; !ok {
					return 0, &ResolutionError{
						Kind: KindMissingEnvironment,
						Message: fmt.Sprintf("The reference %s in %s names an environment that is not available.",
							ReferenceKey(reference.Reference), name),
						Path:                 with(next, nodeKey(reference.EnvironmentID, reference.Name)),
						MissingEnvironmentID: reference.EnvironmentID,
					}
				}
				target = reference.EnvironmentID
			}

			below, err := walk(graph, target, reference.Name, depth+1, next, memo, visit)
			if err != nil {
				return 0, err
			}
			if 1+below > height {
				height = 1 + below
			}
		}
	}

	memo[key] = height
	if err := visit(VisitedSecret{
		ContextID: contextID, Name: name, DefinedIn: environment.ID, SecretID: secret.ID,
	}, secret); err != nil {
		return 0, err
	}
	return height, nil
}

// ResolveEnvironment resolves every name an environment sees to the value a
// process should get.
//
// The client half of the algorithm. Every template's text is parsed and checked
// against what its writer declared: a reference in the text that the
// declaration lacks — or one declared and absent — fails the whole resolution,
// because the server validated the declaration and nothing else, and resolving
// an undeclared reference would follow an edge no cycle check has ever seen.
func ResolveEnvironment(graph Graph, contextID string) (map[string]string, error) {
	values := map[string]string{}

	render := func(node VisitedSecret, secret *Secret) error {
		key := nodeKey(node.ContextID, node.Name)
		if !secret.Template {
			values[key] = secret.Value
			return nil
		}
		rendered, err := renderTemplate(secret, node, values)
		if err != nil {
			return err
		}
		values[key] = rendered
		return nil
	}

	names, err := EnvironmentView(graph, contextID)
	if err != nil {
		return nil, err
	}

	resolved := make(map[string]string, len(names))
	memo := map[string]int{}
	for _, name := range names {
		if err := WalkReferences(graph, contextID, name, render, memo); err != nil {
			return nil, err
		}
		value, ok := values[nodeKey(contextID, name)]
		if !ok {
			// Unreachable: the walk visits the root last, and render always sets it.
			return nil, &ResolutionError{Kind: KindUnresolved, Message: name + " could not be resolved."}
		}
		resolved[name] = value
	}
	return resolved, nil
}

func renderTemplate(secret *Secret, node VisitedSecret, values map[string]string) (string, error) {
	segments, err := ParseTemplate(secret.Value)
	if err != nil {
		// The parse error's own words are not repeated: they describe the value,
		// and this message is about the secret.
		return "", &ResolutionError{
			Kind:    KindSyntax,
			Message: node.Name + " is a template that cannot be parsed.",
			Path:    []string{nodeKey(node.ContextID, node.Name)},
		}
	}

	declared := make(map[string]DeclaredReference, len(secret.References))
	for _, reference := range secret.References {
		declared[ReferenceKey(reference.Reference)] = reference
	}
	used := map[string]bool{}

	var out strings.Builder
	for _, segment := range segments {
		if segment.Reference == nil {
			out.WriteString(segment.Text)
			continue
		}

		key := ReferenceKey(*segment.Reference)
		reference, ok := declared[key]
		if !ok {
			return "", &ResolutionError{
				Kind: KindUndeclared,
				Message: fmt.Sprintf(
					"%s contains ${%s}, which its writer did not declare. Save the template again to fix it.",
					node.Name, key),
				Path: []string{nodeKey(node.ContextID, node.Name)},
			}
		}
		used[key] = true

		target := node.ContextID
		if reference.EnvironmentID != "" {
			target = reference.EnvironmentID
		}
		value, ok := values[nodeKey(target, reference.Name)]
		if !ok {
			// Unreachable: the walk resolves every declared reference before the node.
			return "", &ResolutionError{
				Kind:    KindUnresolved,
				Message: fmt.Sprintf("The reference ${%s} could not be resolved.", key),
			}
		}
		out.WriteString(value)
	}

	if len(used) != len(declared) {
		return "", &ResolutionError{
			Kind:    KindUndeclared,
			Message: node.Name + " declares a reference its text does not contain. Save the template again to fix it.",
			Path:    []string{nodeKey(node.ContextID, node.Name)},
		}
	}
	return out.String(), nil
}
