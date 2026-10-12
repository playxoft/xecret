// Package vaultarchive reads and opens a vault escape archive, offline.
//
// An archive is what an account keeps after a vault reset: every ciphertext and
// wrap the server stored for that vault, still sealed, in a file the master
// passphrase or a recovery code opens with no account, no network, and no
// version of the service still running. This package is the Go reading of
// docs/security/e2ee-crypto-spec.md §14, written against that text rather than
// against the TypeScript in packages/core/src/vault-archive — and checked
// against the same vector file, so a disagreement is a bug in one of them or an
// ambiguity in the spec.
//
// It composes the primitives in internal/e2ee and adds nothing cryptographic of
// its own: an archive is a container of existing blob types, opened by existing
// constructions.
package vaultarchive

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/playxoft/xecret/cli/internal/e2ee"
)

// Format, FormatVersion and Reason are the three fixed values of §14.4.
const (
	Format        = "xecret.vault-archive"
	FormatVersion = 1
	Reason        = "vault-reset"

	// MaxParts is the most parts one archive may be split into.
	MaxParts = 64
	// MaxDocumentBytes is the largest archive.json this reader will inflate or parse.
	MaxDocumentBytes = 64 * 1024 * 1024
	// MaxRecoveryWraps is the most recovery wraps an archive may carry.
	MaxRecoveryWraps = 16

	maxNameLength = 256
)

// ErrFormat marks a file that is not a well-formed archive of the version this
// reader understands — spec §5.2's format class. A message wrapping it names
// where in the document the problem is and never the value found there.
var ErrFormat = errors.New("not a valid vault archive")

func formatErr(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrFormat, fmt.Sprintf(format, args...))
}

// RecoveryWrap is one unused recovery code's wrap of the User Key.
type RecoveryWrap struct {
	LookupHashHex string
	WrapBlob      string
}

// Vault is the account's key material, as stored.
type Vault struct {
	CreatedAt          string
	KdfSaltB64URL      string
	KdfParams          json.RawMessage
	PassphraseWrapBlob string
	RecoveryWraps      []RecoveryWrap
	EncPublicKeyB64URL string
	EncPrivateKeyBlob  string
}

// Key is one EDK/EHK grant the account held for an environment.
type Key struct {
	EnvDataKeyID  string
	EDKVersion    int
	EDKSealedBlob string
	EHKSealedBlob string
}

// Secret is one secret's latest value, sealed.
type Secret struct {
	SecretID     string
	Name         string
	ValueType    string
	Version      int
	EnvDataKeyID string
	ValueBlob    string
	// NoteBlob is empty when the secret has no note.
	NoteBlob  string
	HasNote   bool
	UpdatedAt string
}

// Environment is one end-to-end-encrypted environment the account could read.
type Environment struct {
	OrgID           string
	OrgName         string
	OrgSlug         string
	ProjectID       string
	ProjectName     string
	ProjectSlug     string
	EnvironmentID   string
	EnvironmentName string
	EnvironmentSlug string
	IsProduction    bool
	Keys            []Key
	Secrets         []Secret
}

// Document is a validated archive.json.
type Document struct {
	ArchiveID    string
	Part         int
	Parts        int
	CreatedAt    string
	UserID       string
	Vault        Vault
	Environments []Environment
}

// Parse validates archive.json under every rule of spec §14.4.
//
// Strict about the document: a missing field, a wrong type, or a field the spec
// does not define is a format error at every level. format and formatVersion
// are checked first, so a document from another version is told that rather
// than that some nested field is missing.
func Parse(text []byte) (*Document, error) {
	if !utf8.Valid(text) {
		return nil, formatErr("archive.json is not valid UTF-8")
	}

	var top map[string]json.RawMessage
	if err := json.Unmarshal(text, &top); err != nil || top == nil {
		var probe any
		if json.Unmarshal(text, &probe) != nil {
			return nil, formatErr("archive.json is not valid JSON")
		}
		return nil, formatErr("archive.json must hold a JSON object")
	}

	if format, err := jsonString(top["format"]); err != nil || format != Format {
		return nil, formatErr("this file is not an xecret vault archive")
	}
	version, err := jsonNumber(top["formatVersion"])
	if err != nil || version != math.Trunc(version) {
		return nil, formatErr("formatVersion must be an integer")
	}
	if version != FormatVersion {
		return nil, formatErr("this is a version %d vault archive, and this reader understands version %d only", int64(version), FormatVersion)
	}

	if err := exactFields(top, "", "format", "formatVersion", "archiveId", "part", "parts",
		"createdAt", "reason", "account", "vault", "environments"); err != nil {
		return nil, err
	}

	doc := &Document{}
	if doc.Parts, err = integer(top["parts"], "parts", 1, MaxParts); err != nil {
		return nil, err
	}
	if doc.Part, err = integer(top["part"], "part", 1, doc.Parts); err != nil {
		return nil, err
	}
	if reason, err := jsonString(top["reason"]); err != nil || reason != Reason {
		return nil, formatErr(`reason must be "vault-reset"`)
	}

	account, err := object(top["account"], "account", "userId")
	if err != nil {
		return nil, err
	}

	rawEnvironments, err := array(top["environments"], "environments")
	if err != nil {
		return nil, err
	}
	for index, raw := range rawEnvironments {
		environment, err := parseEnvironment(raw, fmt.Sprintf("environments[%d]", index))
		if err != nil {
			return nil, err
		}
		doc.Environments = append(doc.Environments, environment)
	}

	if doc.ArchiveID, err = uuid(top["archiveId"], "archiveId"); err != nil {
		return nil, err
	}
	if doc.CreatedAt, err = timestamp(top["createdAt"], "createdAt"); err != nil {
		return nil, err
	}
	if doc.UserID, err = uuid(account["userId"], "account.userId"); err != nil {
		return nil, err
	}
	if doc.Vault, err = parseVault(top["vault"]); err != nil {
		return nil, err
	}
	return doc, nil
}

func parseVault(raw json.RawMessage) (Vault, error) {
	fields, err := object(raw, "vault", "createdAt", "kdfSaltB64Url", "kdfParams",
		"passphraseWrapBlob", "recoveryWraps", "encPublicKeyB64Url", "encPrivateKeyBlob")
	if err != nil {
		return Vault{}, err
	}

	// §3.1's ranges, applied to a file exactly as to a server response: an
	// unvalidated m is a memory allocation chosen by whoever wrote the file.
	if _, err := e2ee.ParseKdfParams(fields["kdfParams"]); err != nil {
		return Vault{}, formatErr("vault.kdfParams is not acceptable: %v", err)
	}

	wraps, err := array(fields["recoveryWraps"], "vault.recoveryWraps")
	if err != nil {
		return Vault{}, err
	}
	if len(wraps) > MaxRecoveryWraps {
		return Vault{}, formatErr("vault.recoveryWraps has more entries than an archive may carry")
	}

	vault := Vault{KdfParams: fields["kdfParams"]}
	seen := map[string]bool{}
	for index, rawWrap := range wraps {
		path := fmt.Sprintf("vault.recoveryWraps[%d]", index)
		wrap, err := object(rawWrap, path, "lookupHashHex", "wrapBlob")
		if err != nil {
			return Vault{}, err
		}
		lookup, err := hexString(wrap["lookupHashHex"], path+".lookupHashHex", 32)
		if err != nil {
			return Vault{}, err
		}
		blob, err := blobString(wrap["wrapBlob"], path+".wrapBlob", e2ee.AlgGCM, 0)
		if err != nil {
			return Vault{}, err
		}
		if seen[lookup] {
			return Vault{}, formatErr("vault.recoveryWraps repeats a lookupHashHex")
		}
		seen[lookup] = true
		vault.RecoveryWraps = append(vault.RecoveryWraps, RecoveryWrap{LookupHashHex: lookup, WrapBlob: blob})
	}

	if vault.CreatedAt, err = timestamp(fields["createdAt"], "vault.createdAt"); err != nil {
		return Vault{}, err
	}
	if vault.KdfSaltB64URL, err = base64URL(fields["kdfSaltB64Url"], "vault.kdfSaltB64Url", 16); err != nil {
		return Vault{}, err
	}
	if vault.PassphraseWrapBlob, err = blobString(fields["passphraseWrapBlob"], "vault.passphraseWrapBlob", e2ee.AlgGCM, 0); err != nil {
		return Vault{}, err
	}
	if vault.EncPublicKeyB64URL, err = base64URL(fields["encPublicKeyB64Url"], "vault.encPublicKeyB64Url", 32); err != nil {
		return Vault{}, err
	}
	if vault.EncPrivateKeyBlob, err = blobString(fields["encPrivateKeyBlob"], "vault.encPrivateKeyBlob", e2ee.AlgGCM, 0); err != nil {
		return Vault{}, err
	}
	return vault, nil
}

func parseEnvironment(raw json.RawMessage, path string) (Environment, error) {
	fields, err := object(raw, path, "orgId", "orgName", "orgSlug", "projectId", "projectName",
		"projectSlug", "environmentId", "environmentName", "environmentSlug", "isProduction", "keys", "secrets")
	if err != nil {
		return Environment{}, err
	}

	rawKeys, err := array(fields["keys"], path+".keys")
	if err != nil {
		return Environment{}, err
	}
	if len(rawKeys) == 0 {
		return Environment{}, formatErr("%s.keys must hold at least one key", path)
	}

	var environment Environment
	keyIDs, versions := map[string]bool{}, map[int]bool{}
	for index, rawKey := range rawKeys {
		keyPath := fmt.Sprintf("%s.keys[%d]", path, index)
		key, err := parseKey(rawKey, keyPath)
		if err != nil {
			return Environment{}, err
		}
		if keyIDs[key.EnvDataKeyID] {
			return Environment{}, formatErr("%s.keys repeats a envDataKeyId", path)
		}
		if versions[key.EDKVersion] {
			return Environment{}, formatErr("%s.keys repeats a edkVersion", path)
		}
		keyIDs[key.EnvDataKeyID], versions[key.EDKVersion] = true, true
		environment.Keys = append(environment.Keys, key)
	}

	rawSecrets, err := array(fields["secrets"], path+".secrets")
	if err != nil {
		return Environment{}, err
	}
	secretIDs, names := map[string]bool{}, map[string]bool{}
	for index, rawSecret := range rawSecrets {
		secret, err := parseSecret(rawSecret, fmt.Sprintf("%s.secrets[%d]", path, index))
		if err != nil {
			return Environment{}, err
		}
		if secretIDs[secret.SecretID] {
			return Environment{}, formatErr("%s.secrets repeats a secretId", path)
		}
		if names[secret.Name] {
			return Environment{}, formatErr("%s.secrets repeats a name", path)
		}
		secretIDs[secret.SecretID], names[secret.Name] = true, true
		environment.Secrets = append(environment.Secrets, secret)
	}

	for _, field := range []struct {
		target *string
		name   string
		check  func(json.RawMessage, string) (string, error)
	}{
		{&environment.OrgID, "orgId", uuid},
		{&environment.OrgName, "orgName", label},
		{&environment.OrgSlug, "orgSlug", label},
		{&environment.ProjectID, "projectId", uuid},
		{&environment.ProjectName, "projectName", label},
		{&environment.ProjectSlug, "projectSlug", label},
		{&environment.EnvironmentID, "environmentId", uuid},
		{&environment.EnvironmentName, "environmentName", label},
		{&environment.EnvironmentSlug, "environmentSlug", label},
	} {
		if *field.target, err = field.check(fields[field.name], path+"."+field.name); err != nil {
			return Environment{}, err
		}
	}
	if err := json.Unmarshal(fields["isProduction"], &environment.IsProduction); err != nil || !isJSONBool(fields["isProduction"]) {
		return Environment{}, formatErr("%s.isProduction must be true or false", path)
	}
	return environment, nil
}

func parseKey(raw json.RawMessage, path string) (Key, error) {
	fields, err := object(raw, path, "envDataKeyId", "edkVersion", "edkSealedBlob", "ehkSealedBlob")
	if err != nil {
		return Key{}, err
	}
	var key Key
	if key.EnvDataKeyID, err = uuid(fields["envDataKeyId"], path+".envDataKeyId"); err != nil {
		return Key{}, err
	}
	if key.EDKVersion, err = integer(fields["edkVersion"], path+".edkVersion", 1, math.MaxInt32); err != nil {
		return Key{}, err
	}
	if key.EDKSealedBlob, err = blobString(fields["edkSealedBlob"], path+".edkSealedBlob", e2ee.AlgX25519, 0); err != nil {
		return Key{}, err
	}
	if key.EHKSealedBlob, err = blobString(fields["ehkSealedBlob"], path+".ehkSealedBlob", e2ee.AlgX25519, 0); err != nil {
		return Key{}, err
	}
	return key, nil
}

var (
	secretNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	valueTypePattern  = regexp.MustCompile(`^[a-z0-9]{1,32}$`)
)

func parseSecret(raw json.RawMessage, path string) (Secret, error) {
	fields, err := object(raw, path, "secretId", "name", "valueType", "version", "envDataKeyId",
		"valueBlob", "noteBlob", "updatedAt")
	if err != nil {
		return Secret{}, err
	}

	var secret Secret
	if secret.Name, err = jsonString(fields["name"]); err != nil {
		return Secret{}, formatErr("%s.name must be a string", path)
	}
	if len(secret.Name) > maxNameLength || !secretNamePattern.MatchString(secret.Name) {
		return Secret{}, formatErr("%s.name is not a valid secret name", path)
	}
	if secret.ValueType, err = jsonString(fields["valueType"]); err != nil {
		return Secret{}, formatErr("%s.valueType must be a string", path)
	}
	if !valueTypePattern.MatchString(secret.ValueType) {
		return Secret{}, formatErr("%s.valueType is not a valid value type", path)
	}
	if secret.SecretID, err = uuid(fields["secretId"], path+".secretId"); err != nil {
		return Secret{}, err
	}
	if secret.Version, err = integer(fields["version"], path+".version", 1, math.MaxInt32); err != nil {
		return Secret{}, err
	}
	if secret.EnvDataKeyID, err = uuid(fields["envDataKeyId"], path+".envDataKeyId"); err != nil {
		return Secret{}, err
	}
	if secret.ValueBlob, err = blobString(fields["valueBlob"], path+".valueBlob", e2ee.AlgGCM, e2ee.MaxSecretBlobLength); err != nil {
		return Secret{}, err
	}
	if !bytes.Equal(bytes.TrimSpace(fields["noteBlob"]), []byte("null")) {
		if secret.NoteBlob, err = blobString(fields["noteBlob"], path+".noteBlob", e2ee.AlgGCM, e2ee.MaxSecretBlobLength); err != nil {
			return Secret{}, err
		}
		secret.HasNote = true
	}
	if secret.UpdatedAt, err = timestamp(fields["updatedAt"], path+".updatedAt"); err != nil {
		return Secret{}, err
	}
	return secret, nil
}

/* ─────────────────────────────── field checks ─────────────────────────────── */

// object decodes the object at path and requires exactly these keys.
func object(raw json.RawMessage, path string, keys ...string) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, formatErr("%s must be an object", path)
	}
	if err := exactFields(fields, path, keys...); err != nil {
		return nil, err
	}
	return fields, nil
}

func exactFields(fields map[string]json.RawMessage, path string, keys ...string) error {
	where := path
	if where == "" {
		where = "archive.json"
	}
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	for key := range fields {
		if !allowed[key] {
			return formatErr("%s has a field this reader does not understand", where)
		}
	}
	for _, key := range keys {
		if _, present := fields[key]; !present {
			if path == "" {
				return formatErr("%s is missing", key)
			}
			return formatErr("%s.%s is missing", path, key)
		}
	}
	return nil
}

func array(raw json.RawMessage, path string) ([]json.RawMessage, error) {
	var items []json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &items) != nil || items == nil && !bytes.Equal(bytes.TrimSpace(raw), []byte("[]")) {
		return nil, formatErr("%s must be an array", path)
	}
	return items, nil
}

func jsonString(raw json.RawMessage) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", errors.New("not a string")
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return "", err
	}
	return value, nil
}

// jsonNumber reads a JSON number as a float64, the reading a JavaScript reader
// gives it — so 1 and 1.0 are the same integer on both sides.
func jsonNumber(raw json.RawMessage) (float64, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || !(trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9')) {
		return 0, errors.New("not a number")
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, err
	}
	return value, nil
}

func isJSONBool(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return bytes.Equal(trimmed, []byte("true")) || bytes.Equal(trimmed, []byte("false"))
}

func integer(raw json.RawMessage, path string, min, max int) (int, error) {
	value, err := jsonNumber(raw)
	if err != nil || value != math.Trunc(value) || value < float64(min) || value > float64(max) {
		return 0, formatErr("%s must be an integer from %d to %d", path, min, max)
	}
	return int(value), nil
}

// label is a display name or slug: 1 to 256 characters, counted as code points.
func label(raw json.RawMessage, path string) (string, error) {
	value, err := jsonString(raw)
	if err != nil {
		return "", formatErr("%s must be a string", path)
	}
	if count := utf8.RuneCountInString(value); count == 0 || count > maxNameLength {
		return "", formatErr("%s must be 1 to %d characters", path, maxNameLength)
	}
	return value, nil
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func uuid(raw json.RawMessage, path string) (string, error) {
	value, err := jsonString(raw)
	if err != nil || !uuidPattern.MatchString(value) {
		return "", formatErr("%s must be a lowercase UUID", path)
	}
	return value, nil
}

const timestampLayout = "2006-01-02T15:04:05.000Z"

var timestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

func timestamp(raw json.RawMessage, path string) (string, error) {
	value, err := jsonString(raw)
	if err != nil || !timestampPattern.MatchString(value) {
		return "", formatErr("%s must be a UTC timestamp like 2026-10-12T09:30:00.000Z", path)
	}
	parsed, err := time.Parse(timestampLayout, value)
	if err != nil || parsed.UTC().Format(timestampLayout) != value {
		return "", formatErr("%s must be a UTC timestamp like 2026-10-12T09:30:00.000Z", path)
	}
	return value, nil
}

func hexString(raw json.RawMessage, path string, size int) (string, error) {
	value, err := jsonString(raw)
	if err != nil || !regexp.MustCompile(fmt.Sprintf(`^[0-9a-f]{%d}$`, size*2)).MatchString(value) {
		return "", formatErr("%s must be %d lowercase hex characters", path, size*2)
	}
	return value, nil
}

// strictBase64URL is RFC 4648 §5 without padding, refusing non-zero trailing
// bits — the same set of spellings the TypeScript reader refuses by
// re-encoding and comparing.
var strictBase64URL = base64.RawURLEncoding.Strict()

// base64URL requires canonical unpadded base64url of exactly size bytes.
func base64URL(raw json.RawMessage, path string, size int) (string, error) {
	value, err := jsonString(raw)
	if err != nil {
		return "", formatErr("%s must be unpadded base64url", path)
	}
	decoded, err := strictBase64URL.DecodeString(value)
	if err != nil {
		return "", formatErr("%s must be canonical unpadded base64url", path)
	}
	if len(decoded) != size {
		return "", formatErr("%s must encode exactly %d bytes", path, size)
	}
	return value, nil
}

func blobString(raw json.RawMessage, path string, algorithm e2ee.Algorithm, maxLength int) (string, error) {
	value, err := jsonString(raw)
	if err != nil {
		return "", formatErr("%s must be a string", path)
	}
	if maxLength > 0 && len(value) > maxLength {
		return "", formatErr("%s is longer than any blob of its kind", path)
	}
	if _, err := e2ee.ParseBlob(value, algorithm); err != nil {
		return "", formatErr("%s is not a well-formed xk2.%s blob", path, algorithm)
	}
	return value, nil
}
