package vaultarchive

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/playxoft/xecret/cli/internal/e2ee"
)

// The vault archive's cross-implementation contract, from the Go side.
//
// Every value in vault-archive-vectors.json was produced by the TypeScript
// writer in packages/core/src/vault-archive. This reader was written against
// docs/security/e2ee-crypto-spec.md §14, not against that TypeScript, and must
// open every archive in the file to exactly the plaintexts the fixture
// encrypted, and refuse every rejection vector in the error class it names.
const vectorsPath = "../../../packages/core/src/vault-archive/vectors/vault-archive-vectors.json"

type vectorFile struct {
	SpecVersion   string   `json:"specVersion"`
	Passphrase    string   `json:"passphrase"`
	RecoveryCodes []string `json:"recoveryCodes"`
	Vectors       []vector `json:"vectors"`
}

type vector struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	Description string          `json:"description"`
	Input       json.RawMessage `json:"input"`
	Expected    json.RawMessage `json:"expected"`
}

type vectorInput struct {
	FileVector   string            `json:"fileVector"`
	FileHex      string            `json:"fileHex"`
	JSONText     *string           `json:"jsonText"`
	Credential   *vectorCredential `json:"credential"`
	MaxPartBytes int               `json:"maxPartBytes"`
	PartsHex     []string          `json:"partsHex"`
}

type vectorCredential struct {
	Kind       string `json:"kind"`
	Passphrase string `json:"passphrase"`
	Code       string `json:"code"`
}

func (c vectorCredential) credential() Credential {
	if c.Kind == "passphrase" {
		return Credential{Kind: CredentialPassphrase, Secret: c.Passphrase}
	}
	return Credential{Kind: CredentialRecoveryCode, Secret: c.Code}
}

// expectedSecret and expectedEnvironment are the shape the vectors pin. Value
// and Note are pointers because the file distinguishes null from "".
type expectedSecret struct {
	Name            string  `json:"name"`
	Outcome         string  `json:"outcome"`
	Value           *string `json:"value"`
	Note            *string `json:"note"`
	NoteUnavailable bool    `json:"noteUnavailable"`
}

type expectedEnvironment struct {
	EnvironmentID      string           `json:"environmentId"`
	DamagedKeyVersions []int            `json:"damagedKeyVersions"`
	Secrets            []expectedSecret `json:"secrets"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	data, err := os.ReadFile(filepath.FromSlash(vectorsPath))
	if err != nil {
		t.Fatalf("reading the vector file: %v", err)
	}
	var file vectorFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parsing the vector file: %v", err)
	}
	if file.SpecVersion != "2.1" {
		t.Fatalf("vectors are for spec %q, this reader implements 2.1", file.SpecVersion)
	}
	return file
}

func of(t *testing.T, file vectorFile, kind string) []vector {
	t.Helper()
	var matching []vector
	for _, v := range file.Vectors {
		if v.Kind == kind {
			matching = append(matching, v)
		}
	}
	if len(matching) == 0 {
		t.Fatalf("the vector file has no %s vectors", kind)
	}
	return matching
}

func input(t *testing.T, v vector) vectorInput {
	t.Helper()
	var in vectorInput
	if err := json.Unmarshal(v.Input, &in); err != nil {
		t.Fatalf("%s: input: %v", v.ID, err)
	}
	return in
}

// fileBytes resolves a vector's input to file bytes: a referenced file vector,
// inline hex, or JSON text.
func fileBytes(t *testing.T, file vectorFile, in vectorInput) []byte {
	t.Helper()
	switch {
	case in.FileVector != "":
		for _, v := range file.Vectors {
			if v.ID != in.FileVector {
				continue
			}
			var expected struct {
				FileHex string `json:"fileHex"`
			}
			if err := json.Unmarshal(v.Expected, &expected); err != nil {
				t.Fatal(err)
			}
			return mustHex(t, expected.FileHex)
		}
		t.Fatalf("no vector %s", in.FileVector)
	case in.FileHex != "":
		return mustHex(t, in.FileHex)
	case in.JSONText != nil:
		return []byte(*in.JSONText)
	}
	t.Fatal("vector input names no file")
	return nil
}

func mustHex(t *testing.T, value string) []byte {
	t.Helper()
	data, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func summarise(opened *Opened) []expectedEnvironment {
	out := []expectedEnvironment{}
	for _, environment := range opened.Environments {
		summary := expectedEnvironment{
			EnvironmentID:      environment.EnvironmentID,
			DamagedKeyVersions: environment.DamagedKeyVersions,
			Secrets:            []expectedSecret{},
		}
		for _, secret := range environment.Secrets {
			s := expectedSecret{Name: secret.Name, Outcome: string(secret.Outcome), NoteUnavailable: secret.NoteUnavailable}
			if secret.Outcome == OutcomeOK {
				value := secret.Value
				s.Value = &value
			}
			if secret.HasNote {
				note := secret.Note
				s.Note = &note
			}
			summary.Secrets = append(summary.Secrets, s)
		}
		out = append(out, summary)
	}
	return out
}

func TestFileVectors(t *testing.T) {
	file := loadVectors(t)
	for _, v := range of(t, file, "vault-archive/file") {
		t.Run(v.ID, func(t *testing.T) {
			var expected struct {
				FileHex     string `json:"fileHex"`
				SHA256Hex   string `json:"sha256Hex"`
				ArchiveJSON string `json:"archiveJson"`
			}
			if err := json.Unmarshal(v.Expected, &expected); err != nil {
				t.Fatal(err)
			}
			data := mustHex(t, expected.FileHex)
			digest := sha256.Sum256(data)
			if got := hex.EncodeToString(digest[:]); got != expected.SHA256Hex {
				t.Errorf("sha256 = %s, want %s", got, expected.SHA256Hex)
			}

			fromZip, err := ReadFile(data)
			if err != nil {
				t.Fatalf("reading the ZIP: %v", err)
			}
			fromJSON, err := Parse([]byte(expected.ArchiveJSON))
			if err != nil {
				t.Fatalf("parsing archive.json: %v", err)
			}
			if !reflect.DeepEqual(fromZip, fromJSON) {
				t.Error("the ZIP's document differs from the archive.json the vector states")
			}
		})
	}
}

func TestOpenVectors(t *testing.T) {
	file := loadVectors(t)
	for _, v := range of(t, file, "vault-archive/open") {
		t.Run(v.ID, func(t *testing.T) {
			in := input(t, v)
			doc, err := ReadFile(fileBytes(t, file, in))
			if err != nil {
				t.Fatalf("reading: %v", err)
			}
			opened, err := Open(doc, in.Credential.credential())
			if err != nil {
				t.Fatalf("opening: %v", err)
			}

			var expected struct {
				Environments []expectedEnvironment `json:"environments"`
			}
			if err := json.Unmarshal(v.Expected, &expected); err != nil {
				t.Fatal(err)
			}
			got, want := summarise(opened), expected.Environments
			if !reflect.DeepEqual(got, want) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(want, "", "  ")
				t.Errorf("opened archive differs.\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func TestSplitVectors(t *testing.T) {
	file := loadVectors(t)
	whole, err := ReadFile(fileBytes(t, file, vectorInput{FileVector: "vault-archive/file/single"}))
	if err != nil {
		t.Fatal(err)
	}
	var all []string
	for _, environment := range whole.Environments {
		for _, secret := range environment.Secrets {
			all = append(all, environment.EnvironmentID+"/"+secret.Name)
		}
	}
	sort.Strings(all)

	for _, v := range of(t, file, "vault-archive/split") {
		t.Run(v.ID, func(t *testing.T) {
			in := input(t, v)
			var expected struct {
				Parts           int `json:"parts"`
				PartSecretNames [][]struct {
					EnvironmentID string   `json:"environmentId"`
					Names         []string `json:"names"`
				} `json:"partSecretNames"`
			}
			if err := json.Unmarshal(v.Expected, &expected); err != nil {
				t.Fatal(err)
			}
			if len(in.PartsHex) != expected.Parts {
				t.Fatalf("%d parts in the file, %d expected", len(in.PartsHex), expected.Parts)
			}

			var seen []string
			ids := map[string]bool{}
			for index, partHex := range in.PartsHex {
				data := mustHex(t, partHex)
				if len(data) > in.MaxPartBytes {
					t.Errorf("part %d is %d bytes, over the %d budget", index+1, len(data), in.MaxPartBytes)
				}
				doc, err := ReadFile(data)
				if err != nil {
					t.Fatalf("part %d: %v", index+1, err)
				}
				if doc.Part != index+1 || doc.Parts != expected.Parts {
					t.Errorf("part %d says it is %d of %d", index+1, doc.Part, doc.Parts)
				}
				ids[doc.ArchiveID] = true

				opened, err := Open(doc, in.Credential.credential())
				if err != nil {
					t.Fatalf("opening part %d: %v", index+1, err)
				}
				for envIndex, environment := range opened.Environments {
					want := expected.PartSecretNames[index][envIndex]
					var names []string
					for _, secret := range environment.Secrets {
						names = append(names, secret.Name)
						seen = append(seen, environment.EnvironmentID+"/"+secret.Name)
					}
					if environment.EnvironmentID != want.EnvironmentID || !reflect.DeepEqual(nonNil(names), nonNil(want.Names)) {
						t.Errorf("part %d environment %d: got %s %v, want %s %v", index+1, envIndex,
							environment.EnvironmentID, names, want.EnvironmentID, want.Names)
					}
				}
			}
			if len(ids) != 1 {
				t.Errorf("parts carry %d archive ids, want one", len(ids))
			}
			sort.Strings(seen)
			if !reflect.DeepEqual(seen, all) {
				t.Errorf("the parts together hold %v, the whole archive holds %v", seen, all)
			}
		})
	}
}

func nonNil(names []string) []string {
	if names == nil {
		return []string{}
	}
	return names
}

func TestRejectVectors(t *testing.T) {
	file := loadVectors(t)
	for _, v := range of(t, file, "vault-archive/reject") {
		t.Run(v.ID, func(t *testing.T) {
			in := input(t, v)
			var expected struct {
				ErrorClass string `json:"errorClass"`
			}
			if err := json.Unmarshal(v.Expected, &expected); err != nil {
				t.Fatal(err)
			}

			doc, err := ReadFile(fileBytes(t, file, in))
			if err == nil && in.Credential != nil {
				_, err = Open(doc, in.Credential.credential())
			}
			if err == nil {
				t.Fatal("the vector must be refused")
			}
			if got := errorClass(err); got != expected.ErrorClass {
				t.Errorf("refused as %q (%v), want %q", got, err, expected.ErrorClass)
			}
		})
	}
}

func errorClass(err error) string {
	switch {
	case errors.Is(err, ErrFormat):
		return "format"
	case errors.Is(err, e2ee.ErrDecrypt):
		return "decryption"
	case errors.Is(err, e2ee.ErrRecoveryFormat), errors.Is(err, e2ee.ErrRecoveryChecksum):
		return "recovery-code"
	}
	return "unexpected"
}

func TestThePassphraseIsOneNFCChanges(t *testing.T) {
	file := loadVectors(t)
	opened := 0
	for _, v := range of(t, file, "vault-archive/open") {
		if in := input(t, v); in.Credential.Kind == "passphrase" {
			if in.Credential.Passphrase != file.Passphrase {
				t.Errorf("%s uses a passphrase other than the fixture's", v.ID)
			}
			opened++
		}
	}
	if opened == 0 {
		t.Fatal("no vector opens with the passphrase")
	}
}
