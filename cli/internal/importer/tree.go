package importer

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// JSON and YAML: two formats describing a tree, and one flattening rule.
//
// Environment variables are flat, so `{"database": {"url": "…"}}` becomes
// `database_url`, which the planner then normalises to `DATABASE_URL`. Keeping
// the flattening in one place — rather than once per format — is what stops a
// JSON import and the equivalent YAML import producing different names.

// documentLine is where tree-format entries are anchored. Neither parser keeps
// source positions per key, and the position a JSON decoder reports on failure
// is worded differently in every implementation, so entries are identified by
// key rather than by line.
const documentLine = 1

// maxDepth: nesting deeper than this is not a config file, it is either a
// mistake or an attempt to exhaust the stack with a small payload. Sixteen
// levels is far past anything a human writes.
const maxDepth = 16

// maxAliasCount bounds YAML alias expansion — the "billion laughs" attack, where
// a few hundred bytes of nested aliases expand to gigabytes and take the process
// with them.
const maxAliasCount = 100

// treeNode is a decoded document with object key order preserved.
//
// Order matters and Go maps do not have it. The planner's first-seen-wins rule
// for two keys that normalise to one name, and the order the preview lists
// entries in, both depend on the order the source wrote them.
type treeNode struct {
	kind   treeKind
	pairs  []treePair
	items  []treeNode
	text   string
	isNull bool
}

type treeKind int

const (
	treeScalar treeKind = iota
	treeObject
	treeArray
	// treeUnsupported is a value with no textual meaning at all, which the
	// caller reports rather than guessing at.
	treeUnsupported
)

type treePair struct {
	key   string
	value treeNode
}

// ParseJSON reads a JSON config file.
func ParseJSON(content string) Result {
	decoder := json.NewDecoder(strings.NewReader(content))
	decoder.UseNumber()

	root, err := decodeJSONValue(decoder, 0)
	if err == nil {
		// Trailing content is malformed input, not a second document.
		if _, extra := decoder.Token(); !errors.Is(extra, io.EOF) {
			err = errors.New("unexpected trailing content")
		}
	}
	if err != nil {
		return Result{
			Entries: []Entry{},
			Warnings: []Warning{{
				Line:    documentLine,
				Message: fmt.Sprintf("The file is not valid JSON: %s", err.Error()),
			}},
		}
	}

	return flattenTree(root)
}

func decodeJSONValue(decoder *json.Decoder, depth int) (treeNode, error) {
	if depth > maxDepth+1 {
		return treeNode{}, errors.New("the document is nested too deeply")
	}

	token, err := decoder.Token()
	if err != nil {
		return treeNode{}, err
	}

	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			node := treeNode{kind: treeObject}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return treeNode{}, keyErr
				}
				key, ok := keyToken.(string)
				if !ok {
					return treeNode{}, errors.New("an object key is not a string")
				}
				child, childErr := decodeJSONValue(decoder, depth+1)
				if childErr != nil {
					return treeNode{}, childErr
				}
				node.pairs = append(node.pairs, treePair{key: key, value: child})
			}
			_, err = decoder.Token() // closing brace
			return node, err

		case '[':
			node := treeNode{kind: treeArray}
			for decoder.More() {
				child, childErr := decodeJSONValue(decoder, depth+1)
				if childErr != nil {
					return treeNode{}, childErr
				}
				node.items = append(node.items, child)
			}
			_, err = decoder.Token() // closing bracket
			return node, err
		}
		return treeNode{}, errors.New("unexpected delimiter")

	case string:
		return treeNode{kind: treeScalar, text: value}, nil
	case json.Number:
		return treeNode{kind: treeScalar, text: value.String()}, nil
	case bool:
		return treeNode{kind: treeScalar, text: strconv.FormatBool(value)}, nil
	case nil:
		// `null` becomes the empty string rather than the text "null". In both
		// formats — and especially in YAML, where a bare `PASSWORD:` parses as
		// null — an absent value means "nothing here"; storing the four
		// characters `null` as somebody's password is never what was meant.
		return treeNode{kind: treeScalar, text: "", isNull: true}, nil
	}

	return treeNode{kind: treeUnsupported}, nil
}

// flattenTree turns a decoded document into `key_subkey` entries.
func flattenTree(root treeNode) Result {
	entries := []Entry{}
	warnings := []Warning{}

	if root.kind != treeObject {
		message := "The document does not contain key/value pairs at the top level."
		if root.kind == treeArray {
			message = "The document is a list. Secrets are imported from key/value pairs, so the top level must be an object."
		}
		return Result{Entries: entries, Warnings: []Warning{{Line: documentLine, Message: message}}}
	}

	walkTree(root, nil, 0, &entries, &warnings)

	if len(entries) == 0 && len(warnings) == 0 {
		warnings = append(warnings, Warning{
			Line:    documentLine,
			Message: "The document contains no key/value pairs.",
		})
	}
	return Result{Entries: entries, Warnings: warnings}
}

func walkTree(node treeNode, prefix []string, depth int, entries *[]Entry, warnings *[]Warning) {
	for _, pair := range node.pairs {
		path := append(append([]string{}, prefix...), pair.key)
		name := strings.Join(path, "_")

		switch pair.value.kind {
		case treeArray:
			// Rendering the array as JSON is the tempting alternative, and it is
			// wrong: the user would get a secret whose value is `["a","b"]` and
			// no sign that nothing on the consuming side will ever parse it back.
			*warnings = append(*warnings, Warning{
				Line: documentLine,
				Message: fmt.Sprintf(
					"%q is a list, which has no environment variable equivalent. Flatten it into separate keys to import it.",
					name,
				),
			})

		case treeObject:
			if len(pair.value.pairs) == 0 {
				*warnings = append(*warnings, Warning{
					Line:    documentLine,
					Message: fmt.Sprintf("%q is empty and was skipped.", name),
				})
				continue
			}
			if depth+1 >= maxDepth {
				*warnings = append(*warnings, Warning{
					Line: documentLine,
					Message: fmt.Sprintf(
						"%q is nested more than %d levels deep and was skipped.", name, maxDepth),
				})
				continue
			}
			walkTree(pair.value, path, depth+1, entries, warnings)

		case treeUnsupported:
			*warnings = append(*warnings, Warning{
				Line: documentLine,
				Message: fmt.Sprintf(
					"%q has a type that cannot be stored as a secret and was skipped.", name),
			})

		default:
			// A non-string scalar becomes the text a program would see in its
			// environment: there is no such thing as a numeric environment
			// variable, so `{"port": 5432}` has to become "5432". Refusing it
			// would reject most real config files for no benefit.
			//
			// ── The one deliberate divergence from the TypeScript importer ──
			// It routes numbers through a double and warns when the digits
			// change; this keeps the literal exactly as written, so a Discord
			// snowflake or a long account number imports intact. The warning is
			// still emitted, because the *other* implementation would round it
			// and the two must not silently disagree about a password. Quoting
			// the number in the source makes both exact.
			if literal := pair.value.text; !pair.value.isNull && losesPrecisionAsDouble(literal) {
				*warnings = append(*warnings, Warning{
					Line: documentLine,
					Message: fmt.Sprintf(
						"%q is a number too large to represent exactly. Quote it in the source file to import the exact digits.",
						name,
					),
				})
			}
			*entries = append(*entries, Entry{Key: name, Value: pair.value.text, Line: documentLine})
		}
	}
}

// losesPrecisionAsDouble reports an integer literal that a 64-bit float cannot
// hold exactly — the case the sibling implementation rounds and this one does not.
func losesPrecisionAsDouble(literal string) bool {
	integer, err := strconv.ParseInt(literal, 10, 64)
	if err != nil {
		return false
	}
	const maxSafeInteger = 1<<53 - 1
	return integer > maxSafeInteger || integer < -maxSafeInteger
}

/* ────────────────────────────── YAML ────────────────────────────── */

// yamlProblem is a document-level failure with the line it happened on.
//
// The line matters: "map keys must be unique" pointing at line 1 of a
// forty-line file is not a diagnosis, and the sibling implementation reports the
// key's own line. Carried through the walk rather than reconstructed, because
// the only place that knows it is the node.
type yamlProblem struct {
	line    int
	message string
}

func (p yamlProblem) Error() string { return p.message }

// yamlErrorLine digs the line number out of a parse error.
//
// The library reports syntax errors as `yaml: line N: …` and offers no
// structured position. Parsed rather than guessed at, so a malformed file points
// at the malformed line; a message that does not carry one falls back to the
// document.
var yamlErrorLinePattern = regexp.MustCompile(`line (\d+):`)

func yamlErrorLine(err error) int {
	if match := yamlErrorLinePattern.FindStringSubmatch(err.Error()); match != nil {
		if line, convErr := strconv.Atoi(match[1]); convErr == nil {
			return line
		}
	}
	return documentLine
}

var (
	yamlNullPattern  = regexp.MustCompile(`^(|~|null|Null|NULL)$`)
	yamlBoolPattern  = regexp.MustCompile(`^(true|True|TRUE|false|False|FALSE)$`)
	yamlIntPattern   = regexp.MustCompile(`^[-+]?([0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$`)
	yamlFloatPattern = regexp.MustCompile(`^([-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?|[-+]?\.(inf|Inf|INF)|\.(nan|NaN|NAN))$`)
)

// ParseYAML reads a YAML config file.
//
// The flattening and scalar coercion above are shared with JSON rather than
// reimplemented, so the same document in either format yields the same secrets.
// What is specific to YAML is getting the *parse* right, because YAML has more
// ways to surprise you than any other format here.
func ParseYAML(content string) Result {
	// A blank file is empty, not malformed. Without this the "no key/value
	// pairs" path would report a document that does not exist.
	if strings.TrimSpace(content) == "" {
		return Result{Entries: []Entry{}, Warnings: []Warning{}}
	}

	decoder := yaml.NewDecoder(strings.NewReader(content))
	var documents []yaml.Node
	for {
		var document yaml.Node
		err := decoder.Decode(&document)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return Result{
				Entries: []Entry{},
				Warnings: []Warning{{
					Line:    yamlErrorLine(err),
					Message: fmt.Sprintf("The file is not valid YAML: %s", err.Error()),
				}},
			}
		}
		documents = append(documents, document)
	}

	if len(documents) == 0 {
		return Result{
			Entries:  []Entry{},
			Warnings: []Warning{{Line: documentLine, Message: "The document is empty."}},
		}
	}

	warnings := []Warning{}
	if len(documents) > 1 {
		// Only the first document is imported, so say so. Parsing several
		// documents into one flat namespace would need a merge rule that YAML
		// does not define.
		warnings = append(warnings, Warning{
			Line: documentLine,
			Message: fmt.Sprintf(
				"The file contains %d YAML documents. Only the first was imported.", len(documents)),
		})
	}

	budget := maxAliasCount
	root, err := yamlToTree(&documents[0], 0, &budget)
	if err != nil {
		// A duplicate key is a YAML error, not a last-wins situation. `.env` has
		// a universal convention for duplicates; YAML has none, so picking one of
		// the two values would be a guess — and the wrong guess silently imports
		// the wrong password. The whole document is rejected so the user fixes it.
		line := documentLine
		var problem yamlProblem
		if errors.As(err, &problem) {
			line = problem.line
		}
		return Result{
			Entries:  []Entry{},
			Warnings: append(warnings, Warning{Line: line, Message: err.Error()}),
		}
	}

	flattened := flattenTree(root)
	return Result{Entries: flattened.Entries, Warnings: append(warnings, flattened.Warnings...)}
}

func yamlToTree(node *yaml.Node, depth int, budget *int) (treeNode, error) {
	if depth > maxDepth+2 {
		return treeNode{}, yamlProblem{line: node.Line, message: "The document is nested too deeply."}
	}

	switch node.Kind {
	case yaml.DocumentNode:
		if len(node.Content) == 0 {
			return treeNode{kind: treeScalar, text: "", isNull: true}, nil
		}
		return yamlToTree(node.Content[0], depth, budget)

	case yaml.AliasNode:
		if *budget <= 0 {
			return treeNode{}, yamlProblem{
				line:    node.Line,
				message: "The file expands too many aliases to import safely.",
			}
		}
		*budget--
		return yamlToTree(node.Alias, depth+1, budget)

	case yaml.SequenceNode:
		out := treeNode{kind: treeArray}
		for _, item := range node.Content {
			child, err := yamlToTree(item, depth+1, budget)
			if err != nil {
				return treeNode{}, err
			}
			out.items = append(out.items, child)
		}
		return out, nil

	case yaml.MappingNode:
		return yamlMappingToTree(node, depth, budget)

	default:
		return yamlScalarToTree(node), nil
	}
}

// yamlMappingToTree builds an object, preserving both the order keys were
// assigned in and the precedence a merge key implies.
//
// The two are not the same thing, and getting the difference wrong changes which
// value lands under which name. A key first assigned by a `<<` merge keeps that
// position even when a later explicit key overrides its *value* — which is what
// the sibling implementation's object semantics produce, and what makes
// `<<: *defaults` followed by `port: 6543` read as host-then-port rather than
// port-then-host.
//
// Precedence is independent of position: an explicit key always wins over a
// merged one, whichever came first in the source, and an earlier merge source
// wins over a later one.
func yamlMappingToTree(node *yaml.Node, depth int, budget *int) (treeNode, error) {
	out := treeNode{kind: treeObject}
	position := map[string]int{}
	explicit := map[string]bool{}

	for i := 0; i+1 < len(node.Content); i += 2 {
		keyNode, valueNode := node.Content[i], node.Content[i+1]

		// Merge keys (`<<: *defaults`) are a YAML 1.1 feature and off by default
		// under 1.2, but they are ubiquitous in the CI and Compose files people
		// import from, and resolving one is what the author plainly meant.
		if keyNode.Tag == "!!merge" || keyNode.Value == "<<" {
			merged, err := yamlToTree(valueNode, depth+1, budget)
			if err != nil {
				return treeNode{}, err
			}

			sources := []treeNode{merged}
			if merged.kind == treeArray {
				sources = merged.items
			}
			for _, source := range sources {
				for _, pair := range source.pairs {
					if _, taken := position[pair.key]; taken {
						continue
					}
					position[pair.key] = len(out.pairs)
					out.pairs = append(out.pairs, pair)
				}
			}
			continue
		}

		key := keyNode.Value
		if explicit[key] {
			return treeNode{}, yamlProblem{
				line:    keyNode.Line,
				message: fmt.Sprintf("Map keys must be unique; %q is repeated.", key),
			}
		}
		explicit[key] = true

		child, err := yamlToTree(valueNode, depth+1, budget)
		if err != nil {
			return treeNode{}, err
		}

		if at, merged := position[key]; merged {
			// Assigned by a merge already: the explicit value replaces it where
			// it stands.
			out.pairs[at].value = child
			continue
		}
		position[key] = len(out.pairs)
		out.pairs = append(out.pairs, treePair{key: key, value: child})
	}

	return out, nil
}

// yamlScalarToTree applies the **YAML 1.2 core schema**, explicitly.
//
// Under 1.1 — still what much Python, Ruby and PHP tooling implements, and what
// this library resolves by default — the bare word `NO` is boolean false and
// `08` is an invalid octal. A file with `region: NO` would import the country
// Norway as `false`. Resolving the plain scalar here rather than trusting the
// library's tag is what keeps both as the strings they look like.
//
// A quoted, literal or folded scalar is always a string, whatever it spells.
func yamlScalarToTree(node *yaml.Node) treeNode {
	if node.Style != 0 {
		return treeNode{kind: treeScalar, text: node.Value}
	}
	// An explicit tag is the author overriding resolution, and `!!str "true"` is
	// a string however it looks.
	if node.Tag == "!!str" {
		return treeNode{kind: treeScalar, text: node.Value}
	}

	switch {
	case yamlNullPattern.MatchString(node.Value):
		return treeNode{kind: treeScalar, text: "", isNull: true}
	case yamlBoolPattern.MatchString(node.Value):
		return treeNode{kind: treeScalar, text: strconv.FormatBool(strings.EqualFold(node.Value, "true"))}
	case yamlIntPattern.MatchString(node.Value), yamlFloatPattern.MatchString(node.Value):
		return treeNode{kind: treeScalar, text: node.Value}
	}
	return treeNode{kind: treeScalar, text: node.Value}
}
