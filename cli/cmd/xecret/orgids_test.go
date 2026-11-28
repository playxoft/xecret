package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cache"
	"github.com/playxoft/xecret/cli/internal/config"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/envkeys"
	"github.com/playxoft/xecret/cli/internal/keyring"
	"github.com/playxoft/xecret/cli/internal/output"
)

// Organisations are named by id. Their slugs still exist, unseen, and
// everything that addressed an organisation by one keeps working: credentials
// that hold nothing else, `.xecret.yaml` files written before the organisation
// was recorded, and the pins and offline copies slug-keyed builds left behind.

const (
	acmeOrgID = "0192f0a1-0000-7000-8000-00000000a001"
	sideOrgID = "0192f0a1-0000-7000-8000-00000000a002"
)

var (
	acmeMembership = api.Organization{ID: acmeOrgID, Name: "Acme Corp", Slug: "acme", Role: "owner"}
	sideMembership = api.Organization{ID: sideOrgID, Name: "Side Project", Slug: "side", Role: "member"}
)

// signedIn makes this machine a login holding exactly these credentials, in an
// isolated home with a file keyring.
func signedIn(t *testing.T, credentials cred.Credentials) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XECRET_KEYRING", "file")
	t.Setenv("XECRET_TOKEN", "")
	t.Setenv("XECRET_API_URL", "")
	if err := cred.Save(keyring.Open(output.New(false).Warnf), credentials); err != nil {
		t.Skipf("this platform's file keyring is not writable under a temporary HOME: %v", err)
	}
}

// stored reads back what the keyring holds now.
func stored(t *testing.T) *cred.Credentials {
	t.Helper()
	credentials, err := cred.Load(keyring.Open(output.New(false).Warnf))
	if err != nil {
		t.Fatalf("loading the stored login: %v", err)
	}
	return credentials
}

// meReply is GET /api/auth/me for worldUserID, a member of organizations.
func meReply(organizations ...api.Organization) map[string]any {
	return map[string]any{
		"user":          map[string]any{"id": worldUserID, "email": "ada@example.com"},
		"credential":    map[string]any{"kind": "cli", "name": "laptop"},
		"organizations": organizations,
	}
}

// inDirectory runs the rest of the test in a fresh directory holding the given
// .xecret.yaml, or none when content is empty.
func inDirectory(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	if content != "" {
		if err := os.WriteFile(filepath.Join(dir, config.Filename), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(dir)
	return dir
}

// ── Credentials ─────────────────────────────────────────────────────────────

// A credential written before organisation ids holds a slug and nothing else.
// It keeps addressing the API by that slug, and the first command that hears
// the id from the server records it; every path after that uses the id.
func TestASlugOnlyCredentialIsAddressedBySlugUntilItsIdIsRecorded(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{APIURL: fake.URL(), Token: "xct_live_old", Email: "ada@example.com", OrgSlug: "acme"})
	fake.reply(http.MethodGet, "/projects", http.StatusOK, map[string]any{"projects": []any{}})
	fake.reply(http.MethodGet, "/api/auth/me", http.StatusOK, meReply(sideMembership, acmeMembership))
	inDirectory(t, "")

	if _, _, err := captured(t, func() error { return projectsList(nil) }); err != nil {
		t.Fatalf("projects list: %v", err)
	}
	if got := fake.sent(http.MethodGet, "/projects"); len(got) != 1 || got[0].path != "/api/orgs/acme/projects" {
		t.Fatalf("requests = %+v, want the slug path", got)
	}

	stdout, _, err := captured(t, func() error { return cmdWhoami(nil) })
	if err != nil {
		t.Fatalf("whoami: %v", err)
	}
	if !strings.Contains(stdout, "Organisation   Acme Corp ("+acmeOrgID+")") {
		t.Errorf("whoami does not name the organisation by name and id:\n%s", stdout)
	}
	if strings.Contains(stdout, "acme") {
		t.Errorf("whoami printed the slug:\n%s", stdout)
	}

	after := stored(t)
	if after.OrgID != acmeOrgID || after.OrgName != "Acme Corp" || after.UserID != worldUserID {
		t.Fatalf("the id was not recorded: %+v", after)
	}
	if after.OrgSlug != "acme" {
		t.Fatalf("the slug alias was dropped: %+v", after)
	}

	if _, _, err := captured(t, func() error { return projectsList(nil) }); err != nil {
		t.Fatalf("projects list: %v", err)
	}
	if got := fake.sent(http.MethodGet, "/projects"); len(got) != 2 || got[1].path != "/api/orgs/"+acmeOrgID+"/projects" {
		t.Fatalf("requests = %+v, want the id path once the id is known", got)
	}
}

// The end-to-end path is the other one that records the id: it cannot bind a
// slug into an AAD. Until then nothing is asked that only the AAD needs.
func TestAnEndToEndPathRecordsTheIdOfASlugOnlyCredential(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{APIURL: fake.URL(), Token: "xct_live_old", Email: "ada@example.com", OrgSlug: "acme"})
	fake.reply(http.MethodGet, "/api/auth/me", http.StatusOK, meReply(sideMembership, acmeMembership))
	inDirectory(t, "")

	a, _ := testApp(t)
	credentials := stored(t)
	client := api.New(fake.URL(), credentials.Token, userAgent())
	resolved, err := a.resolveScope(credentials, "web", "dev")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Org != "acme" {
		t.Fatalf("org = %q, want the slug until the id is known", resolved.Org)
	}

	// The pin's key is what the machine holds: no request is made for it.
	if key := a.cacheScope(context.Background(), client, credentials, resolved); key.Org != "acme" {
		t.Fatalf("key = %+v", key)
	}
	if len(fake.sent(http.MethodGet, "/api/auth/me")) != 0 {
		t.Fatal("keying a pin asked the server for an id it did not need")
	}

	id, _, err := a.orgIdentity(context.Background(), client, credentials, resolved, true)
	if err != nil || id != acmeOrgID {
		t.Fatalf("orgIdentity = %q, %v", id, err)
	}
	if after := stored(t); after.OrgID != acmeOrgID || after.OrgSlug != "acme" {
		t.Fatalf("the id was not persisted: %+v", after)
	}

	// From here on the key is the id, carrying the slug the earlier pins are under.
	key := a.cacheScope(context.Background(), nil, stored(t), resolved)
	if key.Org != acmeOrgID || !containsString(key.LegacyOrgs, "acme") {
		t.Fatalf("key = %+v, want the id carrying the slug", key)
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// ── Login ───────────────────────────────────────────────────────────────────

func loginResult(id string) *api.LoginResult {
	result := &api.LoginResult{Token: "xct_live_new"}
	result.User.Email = "ada@example.com"
	result.Organization.ID = id
	result.Organization.Name = "Acme Corp"
	result.Organization.Slug = "acme"
	return result
}

// The token response names the organisation by id; the login stores the id,
// the name for output, and the slug as the hidden alias. No extra request.
func TestALoginStoresTheOrganisationsIdAndName(t *testing.T) {
	fake := newFakeAPI(t) // no routes: any request fails the test

	credentials := loginCredentials(context.Background(), fake.URL(), loginResult(acmeOrgID))
	if credentials.OrgID != acmeOrgID || credentials.OrgName != "Acme Corp" || credentials.OrgSlug != "acme" {
		t.Fatalf("credentials = %+v", credentials)
	}
	if credentials.OrgRef() != acmeOrgID || credentials.OrgLabel() != "Acme Corp" {
		t.Fatalf("ref %q, label %q", credentials.OrgRef(), credentials.OrgLabel())
	}
}

// An older server sends the slug and name alone. The id comes from GET
// /api/auth/me, matched by that slug.
func TestALoginAgainstAnOlderServerLearnsTheIdFromMe(t *testing.T) {
	fake := newFakeAPI(t)
	fake.reply(http.MethodGet, "/api/auth/me", http.StatusOK, meReply(sideMembership, acmeMembership))

	credentials := loginCredentials(context.Background(), fake.URL(), loginResult(""))
	if credentials.OrgID != acmeOrgID || credentials.OrgSlug != "acme" || credentials.UserID != worldUserID {
		t.Fatalf("credentials = %+v", credentials)
	}
}

// And when even that fails, the login is not lost: it addresses the API by the
// slug, which the server accepts, until a later command learns the id.
func TestALoginWhoseIdLookupFailsStillWorksBySlug(t *testing.T) {
	fake := newFakeAPI(t)
	fake.refuse(http.MethodGet, "/api/auth/me", http.StatusInternalServerError, "internal", "boom")

	credentials := loginCredentials(context.Background(), fake.URL(), loginResult(""))
	if credentials.OrgID != "" || credentials.OrgRef() != "acme" || credentials.Token != "xct_live_new" {
		t.Fatalf("credentials = %+v", credentials)
	}
}

// ── Output ──────────────────────────────────────────────────────────────────

// `organization` stays an identifier, the id, so a script that builds a path
// from it keeps working; the name, which is free text, is beside it.
func TestWhoamiJSONNamesTheOrganisationByIdAndName(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
		OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme", UserID: worldUserID,
	})
	fake.reply(http.MethodGet, "/api/auth/me", http.StatusOK, meReply(acmeMembership))

	stdout, _, err := captured(t, func() error { return cmdWhoami([]string{"--json"}) })
	if err != nil {
		t.Fatal(err)
	}
	var answer map[string]any
	if err := json.Unmarshal([]byte(stdout), &answer); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, stdout)
	}
	if answer["organization"] != acmeOrgID || answer["organizationName"] != "Acme Corp" {
		t.Fatalf("whoami --json = %v", answer)
	}
	if _, ok := answer["organizationId"]; ok {
		t.Fatalf("whoami --json carries a second id field: %v", answer)
	}
	if strings.Contains(stdout, `"acme"`) {
		t.Fatalf("whoami --json printed the slug: %s", stdout)
	}
}

// The service-token answer has the same shape, from the token's own pin.
func TestWhoamiUnderAServiceTokenNamesItsOrganisationByNameAndId(t *testing.T) {
	fake := newFakeAPI(t)
	fake.reply(http.MethodGet, "/api/tokens/self", http.StatusOK, map[string]any{
		"token":        map[string]any{"id": worldTokenID, "name": "deploy", "accessLevel": "read"},
		"organization": map[string]any{"id": acmeOrgID, "name": "Acme Corp", "slug": "acme"},
		"project":      map[string]any{"name": "Web", "slug": "web"},
		"environment":  map[string]any{"name": "Production", "slug": "production"},
	})
	t.Setenv("XECRET_TOKEN", "xst_live_abc")
	t.Setenv("XECRET_API_URL", fake.URL())

	for _, args := range [][]string{nil, {"--json"}} {
		stdout, _, err := captured(t, func() error { return cmdWhoami(args) })
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(stdout, "Acme Corp") || !strings.Contains(stdout, acmeOrgID) {
			t.Errorf("whoami %v does not name the organisation:\n%s", args, stdout)
		}
		if strings.Contains(stdout, "acme") {
			t.Errorf("whoami %v printed the slug:\n%s", args, stdout)
		}
		if args != nil {
			var answer map[string]any
			if err := json.Unmarshal([]byte(stdout), &answer); err != nil {
				t.Fatalf("not JSON: %v\n%s", err, stdout)
			}
			if answer["organization"] != acmeOrgID || answer["organizationName"] != "Acme Corp" {
				t.Errorf("whoami --json = %v", answer)
			}
		}
	}
}

func TestOrgsListsByNameAndIdAndMarksTheCurrentOne(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
		OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme",
	})
	fake.reply(http.MethodGet, "/api/orgs", http.StatusOK,
		map[string]any{"organizations": []api.Organization{acmeMembership, sideMembership}})

	stdout, _, err := captured(t, func() error { return orgsList(nil) })
	if err != nil {
		t.Fatal(err)
	}
	header := strings.Fields(strings.ToLower(strings.SplitN(stdout, "\n", 2)[0]))
	if len(header) < 3 || header[0] != "name" || header[1] != "id" || header[2] != "role" {
		t.Errorf("columns = %v, want name, id, role", header)
	}
	for _, line := range strings.Split(stdout, "\n") {
		if strings.Contains(line, acmeOrgID) && !strings.Contains(line, "current") {
			t.Errorf("the current organisation is not marked: %q", line)
		}
		if strings.Contains(line, sideOrgID) && strings.Contains(line, "current") {
			t.Errorf("another organisation is marked current: %q", line)
		}
	}
	if strings.Contains(stdout, "acme") || strings.Contains(stdout, "side") {
		t.Errorf("orgs printed a slug:\n%s", stdout)
	}

	stdout, _, err = captured(t, func() error { return orgsList([]string{"--json"}) })
	if err != nil {
		t.Fatal(err)
	}
	var listed []map[string]any
	if err := json.Unmarshal([]byte(stdout), &listed); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, stdout)
	}
	if len(listed) != 2 || listed[0]["id"] != acmeOrgID || listed[0]["name"] != "Acme Corp" ||
		listed[0]["current"] != true || listed[1]["current"] != false {
		t.Fatalf("orgs --json = %v", listed)
	}
	if _, has := listed[0]["slug"]; has {
		t.Fatalf("orgs --json still carries the slug: %v", listed[0])
	}
}

// `orgs use` takes the id; a name when exactly one membership has it,
// ignoring case; and, quietly, the legacy slug a script written before ids
// passes, in any case because slugs are citext. Whichever it was given, it
// stores the id, the name and the alias.
func TestOrgsUseAcceptsAnIdANameOrALegacySlug(t *testing.T) {
	for _, ref := range []string{sideOrgID, strings.ToUpper(sideOrgID), "Side Project", "side project", "side", "SIDE"} {
		t.Run(ref, func(t *testing.T) {
			fake := newFakeAPI(t)
			signedIn(t, cred.Credentials{
				APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
				OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme",
			})
			fake.reply(http.MethodGet, "/api/orgs", http.StatusOK,
				map[string]any{"organizations": []api.Organization{acmeMembership, sideMembership}})

			_, stderr, err := captured(t, func() error { return orgsUse([]string{ref}) })
			if err != nil {
				t.Fatalf("orgs use %q: %v", ref, err)
			}
			if !strings.Contains(stderr, "Now using Side Project (member).") {
				t.Errorf("confirmation:\n%s", stderr)
			}
			for _, line := range strings.Split(stderr, "\n") {
				if strings.Contains(line, "Now using") && strings.Contains(line, "side") {
					t.Errorf("the confirmation printed the slug: %q", line)
				}
			}
			after := stored(t)
			if after.OrgID != sideOrgID || after.OrgName != "Side Project" || after.OrgSlug != "side" {
				t.Fatalf("stored = %+v", after)
			}
		})
	}
}

// Names are not unique. One two memberships share is not guessed between: the
// refusal lists each with its id, and nothing is changed.
func TestOrgsUseRefusesANameTwoOrganisationsShare(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
		OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme",
	})
	twin := api.Organization{ID: "0192f0a1-0000-7000-8000-00000000a003", Name: "Side Project", Slug: "side-2", Role: "admin"}
	fake.reply(http.MethodGet, "/api/orgs", http.StatusOK,
		map[string]any{"organizations": []api.Organization{acmeMembership, sideMembership, twin}})

	_, _, err := captured(t, func() error { return orgsUse([]string{"side project"}) })
	if err == nil {
		t.Fatal("an ambiguous name was guessed between")
	}
	for _, want := range []string{sideOrgID, twin.ID, "with the id"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal lacks %q: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "side-2") {
		t.Errorf("the refusal printed a slug: %v", err)
	}
	if after := stored(t); after.OrgID != acmeOrgID {
		t.Fatalf("an ambiguous name changed the organisation: %+v", after)
	}

	_, _, err = captured(t, func() error { return orgsUse([]string{"Nobody Inc"}) })
	if err == nil || !strings.Contains(err.Error(), "not a member") {
		t.Fatalf("an unknown organisation: %v", err)
	}
}

// doctor names the organisation by name and id, and the directory's by its id,
// in both of its outputs.
func TestDoctorNamesOrganisationsWithoutTheirSlugs(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
		OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme", UserID: worldUserID,
	})
	fake.reply(http.MethodGet, "/api/version", http.StatusOK, map[string]any{"name": "xecret", "version": "1.0.0", "commit": "abc"})
	fake.reply(http.MethodGet, "/api/auth/me", http.StatusOK, meReply(acmeMembership))
	inDirectory(t, "organization: "+sideOrgID+"\nproject: web\nenvironment: dev\n")

	stdout, _, _ := captured(t, func() error { return cmdDoctor(nil) })
	if !strings.Contains(stdout, "organisation Acme Corp ("+acmeOrgID+")") {
		t.Errorf("doctor does not name the signed-in organisation:\n%s", stdout)
	}
	// The directory is for another organisation, which every command here
	// refuses; doctor says so, and how to choose it on purpose.
	if !strings.Contains(stdout, "is for the organisation "+sideOrgID+", not the one you are using") ||
		!strings.Contains(stdout, "xecret orgs use "+sideOrgID) {
		t.Errorf("doctor does not warn about the directory's organisation:\n%s", stdout)
	}
	if strings.Contains(stdout, "acme") {
		t.Errorf("doctor printed the slug:\n%s", stdout)
	}

	stdout, _, _ = captured(t, func() error { return cmdDoctor([]string{"--json"}) })
	var report map[string]any
	if err := json.Unmarshal([]byte(stdout), &report); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, stdout)
	}
	if report["organization"] != acmeOrgID || report["organizationName"] != "Acme Corp" ||
		report["configOrganizationId"] != sideOrgID {
		t.Errorf("doctor --json = %v", report)
	}
	if strings.Contains(stdout, `"acme"`) {
		t.Errorf("doctor --json printed the slug:\n%s", stdout)
	}
}

// ── init ────────────────────────────────────────────────────────────────────

func initRoutes(fake *fakeAPI) {
	fake.reply(http.MethodGet, "/projects", http.StatusOK,
		map[string]any{"projects": []map[string]any{{"name": "Web", "slug": "web", "environmentCount": 1}}})
	fake.reply(http.MethodGet, "/environments", http.StatusOK,
		map[string]any{"environments": []map[string]any{{"name": "Development", "slug": "dev"}}})
}

// init records the organisation it browsed, by id, and says which one by name.
func TestInitPinsTheOrganisationById(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
		OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme", UserID: worldUserID,
	})
	initRoutes(fake)
	dir := inDirectory(t, "")

	stdout, stderr, err := captured(t, func() error {
		return cmdInit([]string{"--project", "web", "--environment", "dev"})
	})
	if err != nil {
		t.Fatalf("init: %v\n%s", err, stderr)
	}

	content, err := os.ReadFile(filepath.Join(dir, config.Filename))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "organization: "+acmeOrgID+"\n") {
		t.Fatalf("the file does not pin the organisation:\n%s", content)
	}
	if strings.Contains(string(content), "acme") {
		t.Fatalf("the file names the organisation by slug:\n%s", content)
	}
	if !strings.Contains(stderr, "organisation Acme Corp") {
		t.Errorf("init does not say which organisation:\n%s", stderr)
	}
	if strings.Contains(stdout+stderr, "acme") {
		t.Errorf("init printed the slug:\n%s%s", stdout, stderr)
	}
	if got := fake.sent(http.MethodGet, "/projects"); len(got) != 1 || !strings.HasPrefix(got[0].path, "/api/orgs/"+acmeOrgID+"/") {
		t.Fatalf("init browsed %+v, want the id path", got)
	}
}

// A credential from before ids learns its id first, so the file still pins one.
func TestInitUnderASlugOnlyCredentialStillPinsTheId(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{APIURL: fake.URL(), Token: "xct_live_old", Email: "ada@example.com", OrgSlug: "acme"})
	fake.reply(http.MethodGet, "/api/auth/me", http.StatusOK, meReply(acmeMembership))
	initRoutes(fake)
	dir := inDirectory(t, "")

	if _, stderr, err := captured(t, func() error {
		return cmdInit([]string{"--project", "web", "--environment", "dev"})
	}); err != nil {
		t.Fatalf("init: %v\n%s", err, stderr)
	}
	cfg, err := config.Load(filepath.Join(dir, config.Filename))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Organization != acmeOrgID {
		t.Fatalf("organization = %q, want the learned id", cfg.Organization)
	}
}

// ── .xecret.yaml ────────────────────────────────────────────────────────────

// A .xecret.yaml names a project inside the organisation this credential has
// selected. Every shape that agrees with it resolves there: no organisation
// (every file written before init recorded one), the credential's own id, and
// its legacy slug in any case, because slugs are citext.
func TestAnXecretYamlForTheSelectedOrganisationResolves(t *testing.T) {
	credentials := &cred.Credentials{OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme"}
	for _, organization := range []string{"", acmeOrgID, strings.ToUpper(acmeOrgID), "acme", "ACME", "Acme"} {
		t.Run("organization="+organization, func(t *testing.T) {
			file := "project: web\nenvironment: dev\n"
			if organization != "" {
				file = "organization: " + organization + "\n" + file
			}
			inDirectory(t, file)
			t.Setenv("XECRET_TOKEN", "")

			a := &app{printer: output.New(false)}
			resolved, err := a.resolveScope(credentials, "", "")
			if err != nil {
				t.Fatal(err)
			}
			if resolved.Org != acmeOrgID || resolved.OrgID != acmeOrgID ||
				resolved.Project != "web" || resolved.Environment != "dev" {
				t.Fatalf("resolved = %+v", resolved)
			}
		})
	}
}

// The guarantee: a committed file cannot move a command into another
// organisation. A repository in one organisation that names another's id, or
// its slug, is refused before anything is read or written, for a member of
// both, and the refusal names both organisations and how to choose the other
// on purpose.
func TestAnXecretYamlForAnotherOrganisationIsRefused(t *testing.T) {
	for _, organization := range []string{sideOrgID, "side", "SIDE"} {
		t.Run("organization="+organization, func(t *testing.T) {
			fake := newFakeAPI(t)
			signedIn(t, cred.Credentials{
				APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
				OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme", UserID: worldUserID,
			})
			fake.reply(http.MethodGet, "/api/auth/me", http.StatusOK, meReply(acmeMembership, sideMembership))
			inDirectory(t, "organization: "+organization+"\nproject: web\nenvironment: dev\n")

			a, _ := testApp(t)
			_, err := a.resolveScope(stored(t), "", "")
			if err == nil {
				t.Fatal("a file naming another organisation was obeyed")
			}
			message := err.Error()
			for _, want := range []string{
				"Side Project (" + sideOrgID + ")",
				"Acme Corp (" + acmeOrgID + ")",
				"Nothing was read or written",
				"xecret orgs use " + sideOrgID,
			} {
				if !strings.Contains(message, want) {
					t.Errorf("the refusal does not say %q:\n%s", want, message)
				}
			}
		})
	}
}

// Every command that reads or writes secrets goes through resolveScope, so the
// refusal holds end to end: `xecret run` in such a directory reaches no
// organisation's secrets at all.
func TestRunRefusesADirectoryForAnotherOrganisation(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
		OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme", UserID: worldUserID,
	})
	fake.reply(http.MethodGet, "/api/auth/me", http.StatusOK, meReply(acmeMembership, sideMembership))
	inDirectory(t, "organization: "+sideOrgID+"\nproject: web\nenvironment: dev\n")

	_, _, err := captured(t, func() error { return cmdRun([]string{"--", "true"}) })
	if err == nil || !strings.Contains(err.Error(), "xecret orgs use "+sideOrgID) {
		t.Fatalf("run = %v, want the refusal", err)
	}
	for _, path := range []string{"/pull", "/secrets", "/keys"} {
		if sent := fake.sent(http.MethodGet, path); len(sent) != 0 {
			t.Fatalf("run reached %s: %+v", path, sent)
		}
	}
}

// An organisation this account is not a member of is refused just the same,
// without naming it: there is nothing to name, and nothing to switch to.
func TestAnXecretYamlForAStrangersOrganisationIsRefused(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
		OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme", UserID: worldUserID,
	})
	fake.reply(http.MethodGet, "/api/auth/me", http.StatusOK, meReply(acmeMembership))
	inDirectory(t, "organization: "+sideOrgID+"\nproject: web\nenvironment: dev\n")

	a, _ := testApp(t)
	_, err := a.resolveScope(stored(t), "", "")
	if err == nil || !strings.Contains(err.Error(), "not one of yours") ||
		!strings.Contains(err.Error(), "Acme Corp") {
		t.Fatalf("resolveScope = %v", err)
	}
}

// A credential from before organisation ids holds only a slug, and cannot tell
// by itself whether a file's id is its own. It asks the server, records the id
// it hears, and resolves; when the id is somebody else's, it refuses.
func TestASlugOnlyCredentialConfirmsAFilesIdBeforeUsingIt(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com", OrgSlug: "acme",
	})
	fake.reply(http.MethodGet, "/api/auth/me", http.StatusOK, meReply(acmeMembership, sideMembership))

	inDirectory(t, "organization: "+acmeOrgID+"\nproject: web\nenvironment: dev\n")
	a, _ := testApp(t)
	credentials := stored(t)
	resolved, err := a.resolveScope(credentials, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Project != "web" || stored(t).OrgID != acmeOrgID {
		t.Fatalf("resolved = %+v, stored id = %q", resolved, stored(t).OrgID)
	}

	inDirectory(t, "organization: "+sideOrgID+"\nproject: web\nenvironment: dev\n")
	a, _ = testApp(t)
	if _, err := a.resolveScope(stored(t), "", ""); err == nil ||
		!strings.Contains(err.Error(), "xecret orgs use "+sideOrgID) {
		t.Fatalf("a slug-only credential obeyed another organisation's id: %v", err)
	}
}

// When the server cannot be asked, an id the credential cannot confirm is
// refused rather than trusted.
func TestAnUnconfirmableFileIdIsRefusedWhenTheServerCannotBeAsked(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com", OrgSlug: "acme",
	})
	fake.reply(http.MethodGet, "/api/auth/me", http.StatusServiceUnavailable, map[string]any{})
	inDirectory(t, "organization: "+acmeOrgID+"\nproject: web\nenvironment: dev\n")

	a, _ := testApp(t)
	if _, err := a.resolveScope(stored(t), "", ""); err == nil {
		t.Fatal("an id nothing could confirm was trusted")
	}
}

// A --project flag names a project in the credential's organisation, the one
// 'xecret projects' lists. The file is not consulted for the project, so its
// organisation does not stand in the way.
func TestAProjectFlagUsesTheCredentialsOrganisation(t *testing.T) {
	inDirectory(t, "organization: "+sideOrgID+"\nproject: web\nenvironment: dev\n")
	t.Setenv("XECRET_TOKEN", "")
	credentials := &cred.Credentials{OrgID: acmeOrgID, OrgSlug: "acme"}

	a := &app{printer: output.New(false)}
	resolved, err := a.resolveScope(credentials, "other", "")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Org != acmeOrgID || resolved.Project != "other" || resolved.Environment != "dev" {
		t.Fatalf("resolved = %+v", resolved)
	}
}

// Under XECRET_TOKEN the token's own organisation is used, as it always was,
// and a file naming another one is mentioned rather than obeyed.
func TestAServiceTokenKeepsItsOwnOrganisation(t *testing.T) {
	inDirectory(t, "organization: "+sideOrgID+"\nproject: web\nenvironment: dev\n")
	t.Setenv("XECRET_TOKEN", "xst_live_abc")

	a, warnings := testApp(t)
	a.tokenScope = &api.TokenSelf{Organization: api.NamedSlug{ID: acmeOrgID, Name: "Acme Corp", Slug: "acme"}}
	credentials := &cred.Credentials{OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme"}

	resolved, err := a.resolveScope(credentials, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Org != acmeOrgID || resolved.Project != "web" {
		t.Fatalf("resolved = %+v", resolved)
	}
	if !strings.Contains(warnings.String(), "XECRET_TOKEN is pinned to") {
		t.Fatalf("no warning about the mismatch: %q", warnings.String())
	}
}

// ── Mode pins and offline copies filed under the slug ────────────────────────

// An `e2ee` pin a slug-keyed build recorded refuses a later `server` answer,
// now that this build keys by id; and the next accepted answer records it
// under the id.
func TestASlugKeyedPinStillRefusesADowngradeAfterTheUpgrade(t *testing.T) {
	fake := newFakeAPI(t)
	signedIn(t, cred.Credentials{
		APIURL: fake.URL(), Token: "xct_live_abc", Email: "ada@example.com",
		OrgID: acmeOrgID, OrgName: "Acme Corp", OrgSlug: "acme", UserID: worldUserID,
	})
	slugKeyed := cache.Scope{Host: fake.URL(), Org: "acme", Project: "web", Environment: "dev"}
	if err := cache.PinMode(slugKeyed, "e2ee"); err != nil {
		t.Fatal(err)
	}
	fake.reply(http.MethodGet, "/pull", http.StatusOK, map[string]string{"DATABASE_URL": "postgres://plaintext"})
	inDirectory(t, "")

	a, _ := testApp(t)
	credentials := stored(t)
	client := api.New(fake.URL(), credentials.Token, userAgent())
	resolved, err := a.resolveScope(credentials, "web", "dev")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := fetchSecrets(a, client, credentials, resolved, cachePolicy{noCache: true}); !errors.Is(err, cache.ErrModeDowngrade) {
		t.Fatalf("err = %v, want the slug-keyed pin to refuse the downgrade", err)
	}

	if err := a.checkMode(context.Background(), client, credentials, resolved, "e2ee"); err != nil {
		t.Fatal(err)
	}
	idKeyed := cache.Scope{Host: fake.URL(), Org: acmeOrgID, Project: "web", Environment: "dev"}
	if got := cache.PinnedMode(idKeyed); got != "e2ee" {
		t.Fatalf("the carried pin was not recorded under the id: %q", got)
	}
}

// A copy a slug-keyed build wrote is served offline under the id-keyed scope.
func TestAnOfflineCopyFiledUnderTheSlugIsStillServed(t *testing.T) {
	fixture := newE2eeFixture(t)
	h := newOfflineHarness(t, fixture)
	if err := envkeys.StoreVaultWraps(h.app.store, fixture.material); err != nil {
		t.Fatal(err)
	}
	slugKeyed := h.encryptedScope()
	slugKeyed.Org = "acme"
	if err := cache.WriteBundle(h.app.store, slugKeyed, fixture.bundle, time.Now()); err != nil {
		t.Fatal(err)
	}

	// This build keys the scope by the id, carrying the slug.
	key := h.app.cacheScope(context.Background(), nil, h.credentials, h.resolved)
	if key.Org != fixture.orgID || !containsString(key.LegacyOrgs, "acme") {
		t.Fatalf("key = %+v", key)
	}

	secrets, err := h.fetch(cachePolicy{offline: true, maxAge: cache.DefaultMaxAge})
	if err != nil {
		t.Fatalf("--offline: %v", err)
	}
	if secrets["DATABASE_URL"] != fixture.values["DATABASE_URL"] {
		t.Fatalf("DATABASE_URL = %q", secrets["DATABASE_URL"])
	}
}
