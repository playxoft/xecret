package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/e2ee"
)

// `secrets set` and `secrets restore` on an end-to-end encrypted environment:
// what a template's write declares, what a plain write must not, and the
// organisation's value rules, applied here because nothing else in the path of a
// CLI write holds the plaintext.

// writeWorld is a logged-in machine with an environment holding the given
// listing, and the write routes answered.
func writeWorld(t *testing.T, isProduction bool, listing ...api.SecretListItem) (*world, *fakeAPI) {
	t.Helper()
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.reply(http.MethodGet, "/keys", http.StatusOK, w.keyState(isProduction))
	if listing == nil {
		listing = []api.SecretListItem{}
	}
	fake.reply(http.MethodGet, "/secrets", http.StatusOK, map[string]any{"data": listing, "nextCursor": nil})
	fake.handle(http.MethodPost, "/secrets", func(rw http.ResponseWriter, _ *http.Request, body []byte) {
		var sent struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(body, &sent)
		writeJSON(rw, http.StatusCreated, map[string]any{"secret": map[string]any{"name": sent.Name, "version": 1}})
	})
	return w, fake
}

// withPolicy answers GET /policies with the given secret rules.
func withPolicy(fake *fakeAPI, secrets map[string]any) {
	fake.reply(http.MethodGet, "/policies", http.StatusOK, map[string]any{
		"tokens":  map[string]any{"requireIpAllowlist": false, "maxLifetimeDays": nil},
		"secrets": secrets,
	})
}

func forbidding(words ...string) map[string]any {
	return map[string]any{
		"enabled": true, "scope": "all", "namePattern": nil, "minValueEntropyBits": nil,
		"entropyAppliesTo": []string{}, "forbiddenSubstrings": words,
	}
}

func set(t *testing.T, args ...string) error {
	t.Helper()
	_, _, err := captured(t, func() error { return secretsSet(withScope(args...)) })
	return err
}

func onlyBody(t *testing.T, requests []recordedRequest) map[string]any {
	t.Helper()
	if len(requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(requests))
	}
	body := map[string]any{}
	if err := json.Unmarshal(requests[0].body, &body); err != nil {
		t.Fatal(err)
	}
	return body
}

// ── The value policy ──

func TestSecretsSetRefusesAValueThePolicyForbids(t *testing.T) {
	_, fake := writeWorld(t, false)
	withPolicy(fake, forbidding("changeme"))

	const value = "please-CHANGEME-later"
	err := set(t, "API_KEY", "--from-file", valueFile(t, value))
	if err == nil {
		t.Fatal("a forbidden value was written")
	}
	if !strings.Contains(err.Error(), "forbidden words") || !strings.Contains(err.Error(), "API_KEY") {
		t.Errorf("the refusal does not say what and why: %v", err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "changeme") {
		t.Errorf("the refusal names the word, which is part of the value: %v", err)
	}
	// Refused before anything was encrypted or sent.
	if len(fake.sent(http.MethodPost, "/secrets"))+len(fake.sent(http.MethodPatch, "/secrets/API_KEY")) != 0 {
		t.Error("a refused value was written anyway")
	}
}

// The production scope is answered by the key state the write already read.
func TestThePolicyScopeIsAnsweredByTheKeyState(t *testing.T) {
	minimum := map[string]any{
		"enabled": true, "scope": "production", "namePattern": nil, "minValueEntropyBits": 64,
		"entropyAppliesTo": []string{}, "forbiddenSubstrings": []string{},
	}

	_, fake := writeWorld(t, false)
	withPolicy(fake, minimum)
	if err := set(t, "PORT", "--from-file", valueFile(t, "5432")); err != nil {
		t.Fatalf("a production-only rule refused a write outside production: %v", err)
	}

	_, fake = writeWorld(t, true)
	withPolicy(fake, minimum)
	err := set(t, "PORT", "--from-file", valueFile(t, "5432"))
	if err == nil || !strings.Contains(err.Error(), "64 bits of entropy") {
		t.Fatalf("err = %v, want the entropy rule in production", err)
	}
}

func TestSecretsSetSkipsThePolicyOnAnOlderServer(t *testing.T) {
	_, fake := writeWorld(t, true)
	fake.refuse(http.MethodGet, "/policies", http.StatusNotFound, "not_found", "Not found.")

	if err := set(t, "API_KEY", "--from-file", valueFile(t, "changeme")); err != nil {
		t.Fatalf("a server without policies refused the write: %v", err)
	}
	if len(fake.sent(http.MethodPost, "/secrets")) != 1 {
		t.Error("the write was not sent")
	}
}

func TestAPolicyThatCannotBeReadStopsTheWrite(t *testing.T) {
	_, fake := writeWorld(t, true)
	fake.refuse(http.MethodGet, "/policies", http.StatusInternalServerError, "internal_error", "boom")

	if err := set(t, "API_KEY", "--from-file", valueFile(t, "q8Z2xL0vR9sT4bW7nY1cK6mP3dF5gH0j")); err == nil {
		t.Fatal("a write went ahead under a policy nobody could read")
	}
	if len(fake.sent(http.MethodPost, "/secrets")) != 0 {
		t.Error("the write was sent")
	}
}

// ── Templates ──

func TestATemplateCreateDeclaresItsReferences(t *testing.T) {
	_, fake := writeWorld(t, false)
	withPolicy(fake, forbidding())

	err := set(t, "DATABASE_URL", "--type", "template",
		"--from-file", valueFile(t, "postgres://${DB_USER}@${shared.DB_HOST}/${core.prod.DB}?x=$${LITERAL}&u=${DB_USER}"))
	if err != nil {
		t.Fatalf("set: %v", err)
	}

	body := onlyBody(t, fake.sent(http.MethodPost, "/secrets"))
	if body["valueType"] != "template" {
		t.Errorf("valueType = %v", body["valueType"])
	}
	// Re-encoded through a map, so object keys come back sorted: the comparison
	// is about which parts each reference carries, and that no environmentId is
	// among them.
	raw, _ := json.Marshal(body["references"])
	const want = `[{"name":"DB_USER"},{"environment":"shared","name":"DB_HOST"},` +
		`{"environment":"prod","name":"DB","project":"core"}]`
	if string(raw) != want {
		t.Errorf("references\n got %s\nwant %s", raw, want)
	}
}

// `secrets set URL` on a secret that is already a template is a template write,
// and the server requires it to declare what it references — so the stored type
// decides when --type does not.
func TestAnExistingTemplateDeclaresWithoutBeingTold(t *testing.T) {
	_, fake := writeWorld(t, false, api.SecretListItem{
		ID: worldSecretID, Name: "URL", ValueType: "template", Version: 4,
	})
	withPolicy(fake, forbidding())
	fake.reply(http.MethodPatch, "/secrets/URL", http.StatusOK,
		map[string]any{"secret": map[string]any{"name": "URL", "version": 5, "status": "changed"}})

	if err := set(t, "URL", "--from-file", valueFile(t, "https://${HOST}/")); err != nil {
		t.Fatalf("set: %v", err)
	}
	body := onlyBody(t, fake.sent(http.MethodPatch, "/secrets/URL"))
	raw, _ := json.Marshal(body["references"])
	if string(raw) != `[{"name":"HOST"}]` {
		t.Errorf("references = %s", raw)
	}
	if body["expectedVersion"] != float64(5) {
		t.Errorf("expectedVersion = %v", body["expectedVersion"])
	}
}

// A template that references nothing still declares — an empty list, which is a
// different statement from no list at all.
func TestATemplateWithNoReferencesDeclaresAnEmptyList(t *testing.T) {
	_, fake := writeWorld(t, false)
	withPolicy(fake, forbidding())

	if err := set(t, "GREETING", "--type", "template", "--from-file", valueFile(t, "hello $${NAME}")); err != nil {
		t.Fatalf("set: %v", err)
	}
	body := onlyBody(t, fake.sent(http.MethodPost, "/secrets"))
	references, ok := body["references"].([]any)
	if !ok || len(references) != 0 {
		t.Errorf("references = %#v, want []", body["references"])
	}
}

// Any other value is literal text for ever, whatever `${…}` it contains, and its
// write declares nothing — the server refuses one that does.
func TestAPlainValueDeclaresNothing(t *testing.T) {
	_, fake := writeWorld(t, false, api.SecretListItem{
		ID: worldSecretID, Name: "SCRIPT", ValueType: "string", Version: 1,
	})
	withPolicy(fake, forbidding())
	fake.reply(http.MethodPatch, "/secrets/SCRIPT", http.StatusOK,
		map[string]any{"secret": map[string]any{"name": "SCRIPT", "version": 2, "status": "changed"}})

	if err := set(t, "SCRIPT", "--from-file", valueFile(t, "echo ${HOME} ${unclosed")); err != nil {
		t.Fatalf("a plain value was parsed as a template: %v", err)
	}
	if body := onlyBody(t, fake.sent(http.MethodPatch, "/secrets/SCRIPT")); body["references"] != nil {
		t.Errorf("a plain write declared references: %v", body["references"])
	}

	// And a create with no type at all.
	if err := set(t, "OTHER", "--from-file", valueFile(t, "${NOT_A_REFERENCE}")); err != nil {
		t.Fatal(err)
	}
	if _, present := onlyBody(t, fake.sent(http.MethodPost, "/secrets"))["references"]; present {
		t.Error("an untyped create declared references")
	}
}

// --type wins over the stored type: setting a template to a plain string sends
// no declaration, and the server turns it into text.
func TestAnExplicitTypeWinsOverTheStoredOne(t *testing.T) {
	_, fake := writeWorld(t, false, api.SecretListItem{
		ID: worldSecretID, Name: "URL", ValueType: "template", Version: 1,
	})
	withPolicy(fake, forbidding())
	fake.reply(http.MethodPatch, "/secrets/URL", http.StatusOK,
		map[string]any{"secret": map[string]any{"name": "URL", "version": 2, "status": "changed"}})

	if err := set(t, "URL", "--type", "string", "--from-file", valueFile(t, "${now literal")); err != nil {
		t.Fatalf("set: %v", err)
	}
	if _, present := onlyBody(t, fake.sent(http.MethodPatch, "/secrets/URL"))["references"]; present {
		t.Error("a write changing a template to a string declared references")
	}
}

func TestABrokenTemplateIsRefusedLocally(t *testing.T) {
	_, fake := writeWorld(t, false)
	withPolicy(fake, forbidding())

	const value = "postgres://admin:hunter2@db/${UNCLOSED"
	err := set(t, "DATABASE_URL", "--type", "template", "--from-file", valueFile(t, value))
	if err == nil {
		t.Fatal("a template that does not parse was written")
	}
	if strings.Contains(err.Error(), "hunter2") || strings.Contains(err.Error(), "UNCLOSED") {
		t.Errorf("the refusal carries the value: %v", err)
	}
	if len(fake.sent(http.MethodPost, "/secrets")) != 0 {
		t.Error("the broken template was sent")
	}
}

// A template's restore restores its text, and re-declares the references in it
// — re-parsed from the version decrypted, re-encrypted for the version it
// becomes.
func TestRestoreRedeclaresATemplatesReferences(t *testing.T) {
	w, fake := writeWorld(t, false, api.SecretListItem{
		ID: worldSecretID, Name: "URL", ValueType: "template", Version: 2,
	})
	const restored = "https://${HOST}:${staging.PORT}/"
	old := w.row(worldSecretID, "URL", restored, 1)
	fake.reply(http.MethodGet, "/secrets/URL/versions/1", http.StatusOK, map[string]any{"secret": map[string]any{
		"name": "URL", "value": nil, "id": old.ID, "ciphertext": old.Ciphertext,
		"envDataKeyId": old.EnvDataKeyID, "version": 1, "current": false,
	}})
	fake.reply(http.MethodPost, "/secrets/URL/restore", http.StatusOK, map[string]any{"secret": map[string]any{
		"name": "URL", "version": 3, "status": "changed", "restoredFrom": 1,
	}})

	_, _, err := captured(t, func() error { return secretsRestore(withScope("URL", "--version", "1")) })
	if err != nil {
		t.Fatalf("restore: %v", err)
	}

	body := onlyBody(t, fake.sent(http.MethodPost, "/secrets/URL/restore"))
	raw, _ := json.Marshal(body["references"])
	if string(raw) != `[{"name":"HOST"},{"environment":"staging","name":"PORT"}]` {
		t.Errorf("references = %s", raw)
	}

	// Re-encrypted for v3, never copied: the old ciphertext names v1 in its AAD.
	value := body["value"].(map[string]any)
	if value["ciphertext"] == old.Ciphertext {
		t.Fatal("the old ciphertext was copied forward")
	}
	opened, err := e2ee.DecryptSecret(w.keys.EDK, e2ee.SecretContext{
		Field: e2ee.FieldValue, OrgID: worldOrgID, EnvironmentID: worldEnvID, SecretID: worldSecretID, Version: 3,
	}, value["ciphertext"].(string))
	if err != nil || opened != restored {
		t.Fatalf("the restored ciphertext does not open as v3: %q, %v", opened, err)
	}
}

// ── The 409 hint ──

// "Run the command again" is the remedy for a race and for nothing else: over a
// refusal that will recur, it is advice that fails identically every time.
func TestTheRetryHintIsOnlyForAWriteRace(t *testing.T) {
	for message, race := range map[string]bool{
		`version_conflict: "URL" changed while you were editing it. Re-read it and try again.`:                 true,
		"This environment was rotated while you were editing. Re-read its keys and try again.":                 true,
		"This secret was changed by another request. Retry the update.":                                        true,
		`"URL" is a template. An import cannot rewrite one; set it on its own so its references are declared.`: false,
		"resolution_failed: this environment's references cannot be resolved — These references form a loop.":  false,
		"e2ee_required: templates and references need an end-to-end encrypted environment.":                    false,
	} {
		err := withWriteConflictHint(&api.Error{Status: 409, Code: "conflict", Message: message})
		hinted := strings.Contains(err.Error(), "Run the command again")
		if hinted != race {
			t.Errorf("%q: hinted = %v, want %v", message, hinted, race)
		}
		if !strings.Contains(err.Error(), message) {
			t.Errorf("the server's own words were lost: %v", err)
		}
	}
}

// ── A production template reading from elsewhere (review round 1, M3) ──

func noPolicy() map[string]any {
	return map[string]any{"enabled": false, "scope": "all", "namePattern": nil,
		"minValueEntropyBits": nil, "entropyAppliesTo": []string{}, "forbiddenSubstrings": []string{}}
}

// The server refuses an unconfirmed link with its own sentence; the CLI adds how
// to confirm, and sends the confirmation only under --confirm-link.
func TestSecretsSetConfirmsALinkThatCrossesProductionsProtection(t *testing.T) {
	// Built by hand rather than with writeWorld, whose write route answers 201.
	w := newWorld(t, e2ee.RecipientMember)
	fake := newFakeAPI(t)
	loggedIn(t, w, fake)
	fake.reply(http.MethodGet, "/keys", http.StatusOK, w.keyState(true))
	fake.reply(http.MethodGet, "/secrets", http.StatusOK,
		map[string]any{"data": []api.SecretListItem{}, "nextCursor": nil})
	withPolicy(fake, noPolicy())
	fake.refuse(http.MethodPost, "/secrets", http.StatusConflict, "conflict",
		"link_crosses_protection: This would make the production environment web/dev read values "+
			"through a template from web/staging, which is not production.")

	err := set(t, "URL", "--type", "template", "--from-file", valueFile(t, "https://${staging.HOST}/"))
	if err == nil || !strings.Contains(err.Error(), "--confirm-link") ||
		!strings.Contains(err.Error(), "web/staging") {
		t.Fatalf("err = %v, want the server's sentence and the flag that confirms it", err)
	}
	if _, sent := onlyBody(t, fake.sent(http.MethodPost, "/secrets"))["confirmCrossesProtection"]; sent {
		t.Error("an unconfirmed write sent the confirmation")
	}

	_, fake = writeWorld(t, true)
	withPolicy(fake, noPolicy())
	if err := set(t, "URL", "--type", "template", "--confirm-link",
		"--from-file", valueFile(t, "https://${staging.HOST}/")); err != nil {
		t.Fatalf("a confirmed write: %v", err)
	}
	if got := onlyBody(t, fake.sent(http.MethodPost, "/secrets"))["confirmCrossesProtection"]; got != true {
		t.Errorf("confirmCrossesProtection = %v, want true", got)
	}
}
