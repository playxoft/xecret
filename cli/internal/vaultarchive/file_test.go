package vaultarchive

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// The container rules the shared vectors do not reach: what a desktop tool's
// re-zip looks like, and the size bounds checked before anything is inflated.

// singleArchiveJSON is the document inside the shared single-part vector.
func singleArchiveJSON(t *testing.T) []byte {
	t.Helper()
	file := loadVectors(t)
	for _, v := range file.Vectors {
		if v.ID == "vault-archive/file/single" {
			var expected struct {
				ArchiveJSON string `json:"archiveJson"`
			}
			if err := json.Unmarshal(v.Expected, &expected); err != nil {
				t.Fatal(err)
			}
			return []byte(expected.ArchiveJSON)
		}
	}
	t.Fatal("no single-part vector")
	return nil
}

// rezip writes entries the way a desktop tool would: deflated, with extras.
func rezip(t *testing.T, entries map[string][]byte, method uint16) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, name := range []string{"__MACOSX/._archive.json", "README.txt", "archive.json"} {
		data, present := entries[name]
		if !present {
			continue
		}
		w, err := writer.CreateHeader(&zip.FileHeader{Name: name, Method: method})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestReadsADeflatedRezipWithExtraEntries(t *testing.T) {
	document := singleArchiveJSON(t)
	data := rezip(t, map[string][]byte{
		"__MACOSX/._archive.json": []byte("resource fork"),
		"README.txt":              []byte("read me"),
		"archive.json":            document,
	}, zip.Deflate)

	fromZip, err := ReadFile(data)
	if err != nil {
		t.Fatalf("a deflated re-zip must open: %v", err)
	}
	fromJSON, err := Parse(document)
	if err != nil {
		t.Fatal(err)
	}
	if fromZip.ArchiveID != fromJSON.ArchiveID || len(fromZip.Environments) != len(fromJSON.Environments) {
		t.Error("the re-zipped document differs from the original")
	}
}

func TestRefusesAZipWithoutTheDocument(t *testing.T) {
	data := rezip(t, map[string][]byte{"README.txt": []byte("read me")}, zip.Store)
	if _, err := ReadFile(data); !errors.Is(err, ErrFormat) || !strings.Contains(err.Error(), "no archive.json") {
		t.Errorf("got %v", err)
	}
}

func TestRefusesAnOversizedBareDocumentBeforeParsing(t *testing.T) {
	huge := make([]byte, MaxDocumentBytes+1)
	huge[0] = '{'
	if _, err := ReadFile(huge); !errors.Is(err, ErrFormat) || !strings.Contains(err.Error(), "larger than any archive") {
		t.Errorf("got %v", err)
	}
}

func TestRefusesAZip64Locator(t *testing.T) {
	data := rezip(t, map[string][]byte{"archive.json": []byte("{}")}, zip.Store)
	// Splice a ZIP64 end-of-central-directory locator in front of the end
	// record, which is all the reader looks for.
	end := len(data) - 22
	locator := make([]byte, 20)
	binary.LittleEndian.PutUint32(locator, zip64LocatorSignature)
	spliced := append(append(append([]byte{}, data[:end]...), locator...), data[end:]...)
	if _, err := ReadFile(spliced); !errors.Is(err, ErrFormat) || !strings.Contains(err.Error(), "ZIP64") {
		t.Errorf("got %v", err)
	}
}

func TestDamagedReportsOnlyDamage(t *testing.T) {
	clean := &Opened{Environments: []OpenedEnvironment{{Secrets: []OpenedSecret{{Outcome: OutcomeOK}, {Outcome: OutcomeNoKey}}}}}
	if clean.Damaged() {
		t.Error("no-key is a gap, not damage")
	}
	damaged := &Opened{Environments: []OpenedEnvironment{{Secrets: []OpenedSecret{{Outcome: OutcomeDamaged}}}}}
	if !damaged.Damaged() {
		t.Error("a damaged value must be reported")
	}
}

func TestParseRefusesWhatTheSpecDoesNotDefine(t *testing.T) {
	document := string(singleArchiveJSON(t))
	cases := map[string]string{
		"not json":            "{",
		"not an object":       "[]",
		"another format":      `{"format":"other"}`,
		"future version":      strings.Replace(document, `"formatVersion": 1`, `"formatVersion": 3`, 1),
		"fractional version":  strings.Replace(document, `"formatVersion": 1`, `"formatVersion": 1.5`, 1),
		"part beyond parts":   strings.Replace(document, `"part": 1`, `"part": 2`, 1),
		"another reason":      strings.Replace(document, `"reason": "vault-reset"`, `"reason": "export"`, 1),
		"uppercase uuid":      strings.Replace(document, `"archiveId": "0192f0a1`, `"archiveId": "0192F0A1`, 1),
		"impossible date":     strings.Replace(document, `"createdAt": "2026-10-12T09:30:00.000Z"`, `"createdAt": "2026-02-30T09:30:00.000Z"`, 1),
		"invalid utf-8":       document[:20] + "\xff" + document[20:],
		"production as text":  strings.Replace(document, `"isProduction": true`, `"isProduction": "true"`, 1),
		"name too long":       strings.Replace(document, `"orgName": "Acme Corp"`, `"orgName": "`+strings.Repeat("é", 257)+`"`, 1),
		"invalid secret name": strings.Replace(document, `"name": "DATABASE_URL"`, `"name": "1DATABASE_URL"`, 1),
		"invalid value type":  strings.Replace(document, `"valueType": "url"`, `"valueType": "URL"`, 1),
	}
	for name, text := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(text)); !errors.Is(err, ErrFormat) {
				t.Errorf("got %v, want a format error", err)
			}
		})
	}

	// And 1.0 is the integer 1, as a JavaScript reader reads it.
	if _, err := Parse([]byte(strings.Replace(document, `"formatVersion": 1`, `"formatVersion": 1.0`, 1))); err != nil {
		t.Errorf("1.0 must read as 1: %v", err)
	}
	// A 256-character name counts characters, not bytes.
	long := strings.Replace(document, `"orgName": "Acme Corp"`, `"orgName": "`+strings.Repeat("é", 256)+`"`, 1)
	if _, err := Parse([]byte(long)); err != nil {
		t.Errorf("a 256-character name must be accepted: %v", err)
	}
}

func TestLoneSurrogateEscapesAreFoundAndPairsAreNot(t *testing.T) {
	cases := map[string]bool{
		`{"a":"\ud800"}`:              true,
		`{"a":"\udc00"}`:              true,
		`{"a":"\ud800x"}`:             true,
		`{"a":"\ud800A"}`:             true,
		`{"a":"😀"}`:                   false, // a valid pair: an emoji
		`{"a":"\\ud800"}`:             false, // an escaped backslash, then text
		`{"a":"\"😀\\"}`:               false,
		`{"a":"plain é text"}`:        false,
		`{"\ud800":"key, not value"}`: true,
	}
	for text, want := range cases {
		if got := hasLoneSurrogateEscape([]byte(text)); got != want {
			t.Errorf("hasLoneSurrogateEscape(%s) = %v, want %v", text, got, want)
		}
	}
}

func TestSlugPatternsAreTheProducts(t *testing.T) {
	// The same strings packages/core/src/validation/slug.ts accepts and refuses.
	for slug, ok := range map[string]bool{"acme": true, "payments-api": true, "a-b-c": true, "-a": false, "a--b": false, "Acme": false, "a_b": false} {
		if slugPattern.MatchString(slug) != ok {
			t.Errorf("slugPattern(%q) = %v, want %v", slug, !ok, ok)
		}
	}
	for slug, ok := range map[string]bool{"production": true, "dev_eu": true, "dev-eu": true, "_dev": false, "dev__eu": false} {
		if environmentSlugPattern.MatchString(slug) != ok {
			t.Errorf("environmentSlugPattern(%q) = %v, want %v", slug, !ok, ok)
		}
	}
}
