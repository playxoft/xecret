package importer

import (
	"fmt"
	"regexp"
	"strings"
)

// Secret names become environment variables in the user's process, so they must
// be valid POSIX-ish identifiers. The database enforces the same pattern as a
// CHECK constraint; this is the client-side half of that pair.

// SecretNamePattern is what a stored name must match.
var SecretNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// SecretNameMaxLength matches the column.
const SecretNameMaxLength = 256

// reservedNames would shadow something the child process needs.
//
// `LD_PRELOAD` and friends are read by the loader of every process a secret is
// injected into. Importing one would let anybody with write access to an
// environment turn `xecret run` into arbitrary code execution on every machine
// that uses it.
var reservedNames = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "SHELL": true, "PWD": true,
	"OLDPWD": true, "IFS": true, "LD_PRELOAD": true, "LD_LIBRARY_PATH": true,
	"DYLD_INSERT_LIBRARIES": true, "DYLD_LIBRARY_PATH": true,
}

// IsReservedSecretName reports whether a name is one of them.
func IsReservedSecretName(name string) bool { return reservedNames[strings.ToUpper(name)] }

var (
	acronymBoundary = regexp.MustCompile(`([A-Z]+)([A-Z][a-z])`)
	camelBoundary   = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	nonIdentifier   = regexp.MustCompile(`[^A-Za-z0-9_]+`)
	underscoreRun   = regexp.MustCompile(`_+`)
	leadingDigit    = regexp.MustCompile(`^[0-9]`)
)

// NormalizeSecretName converts an arbitrary key into a valid UPPER_SNAKE_CASE
// secret name, or "" when nothing usable can be derived.
//
// Source keys are often `database.url` or `my-api-key`. The two boundary passes
// run in this order on purpose: the acronym pass first, so `myAPIKey` becomes
// `myAPI_Key` and then `my_API_Key`, rather than the unreadable `MYAPIKEY`.
func NormalizeSecretName(input string) string {
	normalized := strings.TrimSpace(input)
	normalized = acronymBoundary.ReplaceAllString(normalized, "${1}_${2}")
	normalized = camelBoundary.ReplaceAllString(normalized, "${1}_${2}")
	normalized = nonIdentifier.ReplaceAllString(normalized, "_")
	normalized = underscoreRun.ReplaceAllString(normalized, "_")
	normalized = strings.Trim(normalized, "_")
	normalized = strings.ToUpper(normalized)

	if normalized == "" {
		return ""
	}
	// A leading digit is invalid; prefix rather than discard the character.
	if leadingDigit.MatchString(normalized) {
		return "_" + normalized
	}
	return normalized
}

// CheckSecretName validates a name, returning "" when it is usable.
func CheckSecretName(name string) string {
	switch {
	case name == "":
		return "Secret name cannot be empty."
	case len(name) > SecretNameMaxLength:
		return fmt.Sprintf("Secret name cannot be longer than %d characters.", SecretNameMaxLength)
	case IsReservedSecretName(name):
		return fmt.Sprintf(
			"%q is reserved by the operating system and cannot be used as a secret name.", name)
	case leadingDigit.MatchString(name):
		return "Secret name cannot start with a digit."
	case !SecretNamePattern.MatchString(name):
		return "Secret name may only contain letters, digits and underscores."
	}
	return ""
}
