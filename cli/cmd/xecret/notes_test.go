package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/keyring"
	"github.com/playxoft/xecret/cli/internal/output"
)

// Clearing a note on an end-to-end encrypted environment.
//
// A note is content, so on an `e2ee` environment it lives in `encNote` and the
// `note` column is not one the server will accept a write to. Removing one is
// still a null — but it has to be a null in the right field, and sending the
// wrong one is a 400 rather than a no-op, so the CLI could write a note onto an
// encrypted secret and never take it off again.

func noteHarness(t *testing.T, mode string, calls *[]string) (*app, *api.Client, *cred.Credentials, scope) {
	t.Helper()

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XECRET_KEYRING", "file")
	t.Setenv("XECRET_TOKEN", "")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls = append(*calls, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": map[string]any{
				"encryptionMode": mode,
				"environmentId":  "018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e52",
				"activeEdk":      map[string]any{"id": "k1", "version": 1},
			},
		})
	}))
	t.Cleanup(server.Close)

	printer := &output.Printer{Out: io.Discard, Err: &bytes.Buffer{}}
	a := &app{printer: printer, store: keyring.Open(printer.Warnf)}

	credentials := &cred.Credentials{APIURL: server.URL, Token: "xct_live_abc", OrgSlug: "acme"}
	return a, api.New(server.URL, credentials.Token, userAgent()), credentials,
		scope{Org: "acme", Project: "web", Environment: "dev"}
}

func TestClearingANoteMovesToEncNoteOnAnEncryptedEnvironment(t *testing.T) {
	var calls []string
	a, client, credentials, resolved := noteHarness(t, "e2ee", &calls)

	cleared := ""
	update := api.MetadataUpdate{Note: &cleared}
	if err := a.sealNote(context.Background(), client, credentials, resolved, "DATABASE_URL", &update); err != nil {
		t.Fatalf("sealNote: %v", err)
	}

	if update.Note != nil {
		t.Fatalf("note = %q, want it moved off the plaintext field", *update.Note)
	}
	if update.EncNote == nil || *update.EncNote != "" {
		t.Fatalf("encNote = %v, want the empty string that renders as null", update.EncNote)
	}

	// Only the key state was read. Clearing a note needs no key, and opening a
	// grant to do it would refuse the operation to somebody who has access but
	// no grant yet.
	for _, path := range calls {
		if !strings.HasSuffix(path, "/keys") {
			t.Errorf("clearing a note called %s", path)
		}
	}
}

// A server-mode environment keeps the plaintext null it has always used.
func TestClearingANoteStaysPlaintextOnAServerModeEnvironment(t *testing.T) {
	var calls []string
	a, client, credentials, resolved := noteHarness(t, "server", &calls)

	cleared := ""
	update := api.MetadataUpdate{Note: &cleared}
	if err := a.sealNote(context.Background(), client, credentials, resolved, "DATABASE_URL", &update); err != nil {
		t.Fatalf("sealNote: %v", err)
	}

	if update.Note == nil || *update.Note != "" {
		t.Fatalf("note = %v, want the empty string", update.Note)
	}
	if update.EncNote != nil {
		t.Fatalf("encNote = %q on a server-mode environment", *update.EncNote)
	}
}

// Omitting `--note` is a different request from `--note ""`, and it still costs
// nothing: no key state is read for a change that does not touch the note.
func TestAnAbsentNoteAsksTheServerNothing(t *testing.T) {
	var calls []string
	a, client, credentials, resolved := noteHarness(t, "e2ee", &calls)

	renamed := "NEW_NAME"
	update := api.MetadataUpdate{Name: &renamed}
	if err := a.sealNote(context.Background(), client, credentials, resolved, "DATABASE_URL", &update); err != nil {
		t.Fatalf("sealNote: %v", err)
	}
	if len(calls) != 0 {
		t.Fatalf("a rename read the key state: %v", calls)
	}
}

// The wire form the two branches above resolve to. `encNote: null` is what
// removes the row's note; anything else either stores a blob that decrypts to
// nothing or is refused.
func TestUpdateMetadataSendsANullEncNoteToClearIt(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"secret":{"name":"DATABASE_URL"}}`)
	}))
	defer server.Close()

	cleared := ""
	if _, err := api.New(server.URL, "xct_live_abc", "test-agent").UpdateMetadata(
		context.Background(), "acme", "web", "dev", "DATABASE_URL",
		api.MetadataUpdate{EncNote: &cleared},
	); err != nil {
		t.Fatalf("UpdateMetadata: %v", err)
	}

	value, present := body["encNote"]
	if !present {
		t.Fatalf("encNote was not sent: %v", body)
	}
	if value != nil {
		t.Fatalf("encNote = %v, want null", value)
	}
	if _, present := body["note"]; present {
		t.Fatalf("the plaintext note field was sent as well: %v", body)
	}
}
