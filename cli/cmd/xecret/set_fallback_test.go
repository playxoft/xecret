package main

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/playxoft/xecret/cli/internal/api"
)

// Server-mode `xecret set` creates, and appends a version only when the server
// says the name is taken. Every other 409 a create can be answered with — a
// write that lost a race to a deadlock or a serialisation failure, or an
// environment upgraded to end-to-end encryption while the request was in
// flight — is reported as it is, because falling back would send the plaintext
// value to a second endpoint on a guess.

func TestServerModeSetAppendsOnlyWhenTheNameIsTaken(t *testing.T) {
	ctx := context.Background()
	resolved := scope{Org: "acme", Project: "api", Environment: "legacy"}
	created := map[string]any{"secret": map[string]any{"name": "URL", "version": 2, "status": "updated"}}

	fake := newFakeAPI(t)
	fake.refuse(http.MethodPost, "/environments/legacy/secrets", 409, "conflict", nameTakenMessage)
	fake.reply(http.MethodPatch, "/environments/legacy/secrets/URL", 200, created)
	client := api.New(fake.URL(), "xct_test", "xecret-test")

	appended, result, err := createOrAppendServerSecret(ctx, client, resolved, "URL", "v", "", "")
	if err != nil || !appended || result == nil || result.Version != 2 {
		t.Fatalf("a taken name did not become an append: appended=%v result=%v err=%v", appended, result, err)
	}
	if len(fake.sent(http.MethodPatch, "/secrets/URL")) != 1 {
		t.Fatal("the append was not sent")
	}
}

func TestServerModeSetReportsEveryOtherConflictWithoutAppending(t *testing.T) {
	ctx := context.Background()
	resolved := scope{Org: "acme", Project: "api", Environment: "legacy"}

	for message, hinted := range map[string]bool{
		// PostgreSQL broke a deadlock or a serialisation conflict.
		"This environment was changed by another request. Retry the write.": true,
		// The environment was upgraded while the request was in flight.
		"mode_changed: this environment was upgraded to end-to-end encryption while this request " +
			"was in flight. Nothing was written — reload it and try again.": true,
		// A conflict that will recur keeps the server's words, and no hint.
		"e2ee_required: templates and references need an end-to-end encrypted environment.": false,
	} {
		fake := newFakeAPI(t)
		fake.refuse(http.MethodPost, "/environments/legacy/secrets", 409, "conflict", message)
		fake.handle(http.MethodPatch, "/secrets/URL", func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			t.Errorf("%q fell back to an append", message)
			writeJSON(w, 500, map[string]any{})
		})
		client := api.New(fake.URL(), "xct_test", "xecret-test")

		appended, result, err := createOrAppendServerSecret(ctx, client, resolved, "URL", "v", "", "")
		if err == nil || appended || result != nil {
			t.Fatalf("%q: appended=%v result=%v err=%v", message, appended, result, err)
		}
		if !strings.Contains(err.Error(), message) {
			t.Errorf("the server's own words were lost: %v", err)
		}
		if got := strings.Contains(err.Error(), "Run the command again"); got != hinted {
			t.Errorf("%q: hinted = %v, want %v", message, got, hinted)
		}
		if len(fake.sent(http.MethodPatch, "/secrets/URL")) != 0 {
			t.Errorf("%q: a PATCH was sent", message)
		}
	}
}

func TestIsNameTakenMatchesOnlyTheServersOwnSentence(t *testing.T) {
	for _, candidate := range []*api.Error{
		{Status: 409, Code: "conflict", Message: "A secret with that name already exists in this environment"},
		{Status: 409, Code: "conflict", Message: "This environment was changed by another request. Retry the write."},
		{Status: 400, Code: "bad_request", Message: nameTakenMessage},
	} {
		if isNameTaken(candidate) {
			t.Errorf("%+v read as a taken name", candidate)
		}
	}
	if !isNameTaken(&api.Error{Status: 409, Code: "conflict", Message: nameTakenMessage}) {
		t.Error("the server's own refusal did not read as a taken name")
	}
}
