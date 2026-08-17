package api

import (
	"context"
	"fmt"
	"net/url"
)

// The typed endpoints the CLI uses. Response structs mirror the server's
// serialisers field-for-field; anything absent here is deliberately not read.

// Me is GET /api/auth/me.
type Me struct {
	User struct {
		Email       string  `json:"email"`
		DisplayName *string `json:"displayName"`
	} `json:"user"`
	Credential struct {
		Kind string  `json:"kind"`
		Name *string `json:"name"`
	} `json:"credential"`
	Organizations []Organization `json:"organizations"`
}

type Organization struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
	Role string `json:"role"`
}

type Project struct {
	Name             string  `json:"name"`
	Slug             string  `json:"slug"`
	Description      *string `json:"description"`
	EnvironmentCount int     `json:"environmentCount"`
}

type Environment struct {
	Name         string `json:"name"`
	Slug         string `json:"slug"`
	IsProduction bool   `json:"isProduction"`
}

type SecretListItem struct {
	Name      string  `json:"name"`
	Note      *string `json:"note"`
	ValueType string  `json:"valueType"`
	Version   int     `json:"version"`
	UpdatedAt string  `json:"updatedAt"`
}

// RevealedSecret is the one response type in this package that carries a
// plaintext value. It is produced for `secrets get --plain` and nowhere else.
type RevealedSecret struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	ValueType string `json:"valueType"`
	Version   int    `json:"version"`
}

type WriteResult struct {
	Name    string `json:"name"`
	Version int    `json:"version"`
	// Status is "created", "changed" or "unchanged" depending on the path.
	Status string `json:"status"`
}

// LoginResult is POST /api/cli/token — the one response carrying the bearer
// token. It is written to the OS keychain by the caller and never printed.
type LoginResult struct {
	Token       string `json:"token"`
	TokenPrefix string `json:"tokenPrefix"`
	User        struct {
		Email       string  `json:"email"`
		DisplayName *string `json:"displayName"`
	} `json:"user"`
	Organization struct {
		Slug string `json:"slug"`
		Name string `json:"name"`
	} `json:"organization"`
}

type ImportItem struct {
	SourceKey string  `json:"sourceKey"`
	Name      string  `json:"name"`
	Status    string  `json:"status"`
	Note      *string `json:"note"`
}

type ImportResult struct {
	DryRun   bool           `json:"dryRun"`
	Format   string         `json:"format"`
	Strategy string         `json:"strategy"`
	Counts   map[string]int `json:"counts"`
	Items    []ImportItem   `json:"items"`
	Warnings []string       `json:"warnings"`
}

// ImportRequest is the body of POST …/import.
type ImportRequest struct {
	Content  string `json:"content"`
	Format   string `json:"format,omitempty"`
	Filename string `json:"filename,omitempty"`
	Strategy string `json:"strategy"`
	DryRun   bool   `json:"dryRun"`
}

// ExchangeCode redeems a consent-screen code plus the PKCE verifier for a CLI
// token. Unauthenticated by design — the result *is* the credential.
func (c *Client) ExchangeCode(ctx context.Context, code, verifier string) (*LoginResult, error) {
	var result LoginResult
	err := c.Post(ctx, "/api/cli/token", map[string]string{
		"code":         code,
		"codeVerifier": verifier,
	}, &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// ServerVersion is GET /api/version — what a deployment is running. The only
// unauthenticated GET in the API, which is what makes it the right probe for
// "can this machine reach the server at all?".
type ServerVersion struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Commit  string `json:"commit"`
	BuiltAt string `json:"builtAt"`
}

// ServerVersion asks what is deployed. Needs no credential.
func (c *Client) ServerVersion(ctx context.Context) (*ServerVersion, error) {
	var version ServerVersion
	if err := c.Get(ctx, "/api/version", &version); err != nil {
		return nil, err
	}
	return &version, nil
}

// RevokeSelf revokes the token this client holds. `xecret logout`.
func (c *Client) RevokeSelf(ctx context.Context) error {
	return c.Delete(ctx, "/api/cli/token", nil, nil)
}

// FetchMe is GET /api/auth/me — `xecret whoami`.
func (c *Client) FetchMe(ctx context.Context) (*Me, error) {
	var me Me
	if err := c.Get(ctx, "/api/auth/me", &me); err != nil {
		return nil, err
	}
	return &me, nil
}

// NamedSlug is a resource as the introspection endpoint names it.
type NamedSlug struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// TokenSelf is what GET /api/tokens/self says about a service token: its own
// name and level, and the organisation, project and environment it is pinned
// to. The answer derives from the credential row alone — there is no
// parameter in the request for anything to lie in.
type TokenSelf struct {
	Token struct {
		Name        string `json:"name"`
		AccessLevel string `json:"accessLevel"`
	} `json:"token"`
	Organization NamedSlug `json:"organization"`
	Project      NamedSlug `json:"project"`
	Environment  struct {
		Name         string `json:"name"`
		Slug         string `json:"slug"`
		IsProduction bool   `json:"isProduction"`
	} `json:"environment"`
}

// TokenSelf is GET /api/tokens/self — service-token introspection. Rejected
// with 403 for every other credential kind.
func (c *Client) TokenSelf(ctx context.Context) (*TokenSelf, error) {
	var self TokenSelf
	if err := c.Get(ctx, "/api/tokens/self", &self); err != nil {
		return nil, err
	}
	return &self, nil
}

// pageLimit bounds pagination loops. At the server's page sizes this is
// thousands of rows — hitting it means something is wrong, not something big.
const pageLimit = 50

// Projects lists every project in the organisation, walking pagination.
func (c *Client) Projects(ctx context.Context, org string) ([]Project, error) {
	var all []Project
	for page := 1; page <= pageLimit; page++ {
		var response struct {
			Projects []Project `json:"projects"`
			HasMore  bool      `json:"hasMore"`
		}
		path := fmt.Sprintf("%s/projects?page=%d", orgPath(org), page)
		if err := c.Get(ctx, path, &response); err != nil {
			return nil, err
		}
		all = append(all, response.Projects...)
		if !response.HasMore {
			return all, nil
		}
	}
	return all, fmt.Errorf("too many pages of projects; refine on the dashboard")
}

// Environments lists a project's environments, in the server's display order.
func (c *Client) Environments(ctx context.Context, org, project string) ([]Environment, error) {
	var response struct {
		Environments []Environment `json:"environments"`
	}
	if err := c.Get(ctx, projectPath(org, project)+"/environments", &response); err != nil {
		return nil, err
	}
	return response.Environments, nil
}

// Secrets lists an environment's secrets — masked, walking pagination.
func (c *Client) Secrets(ctx context.Context, org, project, env string) ([]SecretListItem, error) {
	var all []SecretListItem
	cursor := ""
	for page := 0; page < pageLimit; page++ {
		path := envPath(org, project, env) + "/secrets?limit=200"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		var response struct {
			Data       []SecretListItem `json:"data"`
			NextCursor *string          `json:"nextCursor"`
		}
		if err := c.Get(ctx, path, &response); err != nil {
			return nil, err
		}
		all = append(all, response.Data...)
		if response.NextCursor == nil {
			return all, nil
		}
		cursor = *response.NextCursor
	}
	return all, fmt.Errorf("too many pages of secrets; refine on the dashboard")
}

// Reveal decrypts one secret. Audited server-side as `secret.revealed`.
func (c *Client) Reveal(ctx context.Context, org, project, env, name string) (*RevealedSecret, error) {
	var response struct {
		Secret RevealedSecret `json:"secret"`
	}
	if err := c.Get(ctx, secretPath(org, project, env, name), &response); err != nil {
		return nil, err
	}
	return &response.Secret, nil
}

// CreateSecret creates name with value. 409 means it already exists.
func (c *Client) CreateSecret(
	ctx context.Context,
	org, project, env, name, value, valueType, note string,
) (*WriteResult, error) {
	body := map[string]any{"name": name, "value": value}
	if valueType != "" {
		body["valueType"] = valueType
	}
	if note != "" {
		body["note"] = note
	}
	var response struct {
		Secret WriteResult `json:"secret"`
	}
	if err := c.Post(ctx, envPath(org, project, env)+"/secrets", body, &response); err != nil {
		return nil, err
	}
	response.Secret.Status = "created"
	return &response.Secret, nil
}

// UpdateSecret appends a new version. An identical value is a server-side
// no-op reported as "unchanged".
func (c *Client) UpdateSecret(
	ctx context.Context,
	org, project, env, name, value, valueType string,
) (*WriteResult, error) {
	body := map[string]any{"value": value}
	if valueType != "" {
		body["valueType"] = valueType
	}
	var response struct {
		Secret WriteResult `json:"secret"`
	}
	if err := c.Patch(ctx, secretPath(org, project, env, name), body, &response); err != nil {
		return nil, err
	}
	return &response.Secret, nil
}

// DeleteSecret soft-deletes one secret.
func (c *Client) DeleteSecret(ctx context.Context, org, project, env, name string) error {
	return c.Delete(ctx, secretPath(org, project, env, name), nil, nil)
}

// Import sends a configuration file for server-side parsing and planning.
func (c *Client) Import(
	ctx context.Context,
	org, project, env string,
	request ImportRequest,
) (*ImportResult, error) {
	var result ImportResult
	if err := c.Post(ctx, envPath(org, project, env)+"/import", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Pull fetches every current secret in one document. The caller decides where
// the bytes go; this function does not look at them.
func (c *Client) Pull(ctx context.Context, org, project, env, format string) ([]byte, error) {
	return c.GetRaw(ctx, envPath(org, project, env)+"/pull?format="+url.QueryEscape(format))
}

// Export fetches the same document as Pull, through the endpoint the server
// audits as a deliberate download rather than as a process's bulk read. The
// two are separate endpoints server-side and stay separate here: the request
// path is what distinguishes "a build read its configuration" from "somebody
// took a copy" in the audit record.
func (c *Client) Export(ctx context.Context, org, project, env, format string) ([]byte, error) {
	return c.GetRaw(ctx, envPath(org, project, env)+"/export?format="+url.QueryEscape(format))
}

// SecretVersion is one row of a secret's history. Metadata only — the server
// selects no ciphertext column for this listing, and this struct has nowhere
// to put a value if it did. Recovering an old value is Restore or
// RevealVersion, both of which are audited.
type SecretVersion struct {
	Version   int    `json:"version"`
	Algorithm string `json:"algorithm"`
	// EnvKeyID names the data key a version was written under. Opaque, and
	// confers nothing: the key itself never leaves the database unwrapped.
	EnvKeyID                string  `json:"envKeyId"`
	CreatedAt               string  `json:"createdAt"`
	CreatedBy               *string `json:"createdBy"`
	CreatedByServiceTokenID *string `json:"createdByServiceTokenId"`
	Current                 bool    `json:"current"`
}

// RevealedVersion is one historical value. The second of the two response
// types in this package that carry a plaintext.
type RevealedVersion struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	Version   int    `json:"version"`
	Current   bool   `json:"current"`
	CreatedAt string `json:"createdAt"`
}

// RestoreResult reports the new version an old value was re-appended as.
type RestoreResult struct {
	Name         string `json:"name"`
	Version      int    `json:"version"`
	Status       string `json:"status"`
	RestoredFrom int    `json:"restoredFrom"`
}

// SecretMetadata is what PUT …/secrets/{name} returns: what is said *about* a
// secret, with no version appended and no key unwrapped.
type SecretMetadata struct {
	Name      string  `json:"name"`
	Note      *string `json:"note"`
	ValueType string  `json:"valueType"`
}

// SecretVersions walks a secret's history, newest first as the server orders
// it.
func (c *Client) SecretVersions(ctx context.Context, org, project, env, name string) ([]SecretVersion, error) {
	var all []SecretVersion
	cursor := ""
	for page := 0; page < pageLimit; page++ {
		path := secretPath(org, project, env, name) + "/versions?limit=200"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		var response struct {
			Data       []SecretVersion `json:"data"`
			NextCursor *string         `json:"nextCursor"`
		}
		if err := c.Get(ctx, path, &response); err != nil {
			return nil, err
		}
		all = append(all, response.Data...)
		if response.NextCursor == nil {
			return all, nil
		}
		cursor = *response.NextCursor
	}
	return all, fmt.Errorf("too many pages of versions; narrow the question on the dashboard")
}

// RevealVersion decrypts one historical version. Audited as `secret.revealed`
// with the version recorded, exactly like revealing the current one.
func (c *Client) RevealVersion(
	ctx context.Context,
	org, project, env, name string,
	version int,
) (*RevealedVersion, error) {
	var response struct {
		Secret RevealedVersion `json:"secret"`
	}
	path := fmt.Sprintf("%s/versions/%d", secretPath(org, project, env, name), version)
	if err := c.Get(ctx, path, &response); err != nil {
		return nil, err
	}
	return &response.Secret, nil
}

// RestoreSecret re-appends an earlier value as a new current version. History
// is never rewritten server-side; the old row stays where it is.
func (c *Client) RestoreSecret(
	ctx context.Context,
	org, project, env, name string,
	version int,
) (*RestoreResult, error) {
	var response struct {
		Secret RestoreResult `json:"secret"`
	}
	body := map[string]any{"version": version}
	if err := c.Post(ctx, secretPath(org, project, env, name)+"/restore", body, &response); err != nil {
		return nil, err
	}
	return &response.Secret, nil
}

// MetadataUpdate is the set of things that can be said about a secret without
// touching what it holds. A nil field is "leave it alone"; a non-nil Note
// pointing at "" clears the note.
type MetadataUpdate struct {
	Name      *string
	Note      *string
	ValueType *string
}

// UpdateMetadata is the PUT that appends no version. Declaring a type is not a
// rotation and neither is a rename, so neither may bump the number that
// answers "when did this credential last actually change?".
func (c *Client) UpdateMetadata(
	ctx context.Context,
	org, project, env, name string,
	update MetadataUpdate,
) (*SecretMetadata, error) {
	body := map[string]any{}
	if update.Name != nil {
		body["name"] = *update.Name
	}
	if update.Note != nil {
		// An empty string clears it: the server's schema is nullish, and null
		// is the only way to say "remove this" rather than "set it to nothing".
		if *update.Note == "" {
			body["note"] = nil
		} else {
			body["note"] = *update.Note
		}
	}
	if update.ValueType != nil {
		body["valueType"] = *update.ValueType
	}

	var response struct {
		Secret SecretMetadata `json:"secret"`
	}
	if err := c.Put(ctx, secretPath(org, project, env, name), body, &response); err != nil {
		return nil, err
	}
	return &response.Secret, nil
}

// Organizations lists the memberships behind this credential. Refused for a
// service token, which is pinned to one organisation and does not get to ask.
func (c *Client) Organizations(ctx context.Context) ([]Organization, error) {
	var response struct {
		Organizations []Organization `json:"organizations"`
	}
	if err := c.Get(ctx, "/api/orgs", &response); err != nil {
		return nil, err
	}
	return response.Organizations, nil
}

// CreatedProject is what POST …/projects returns: the project and the default
// environments created with it, in one transaction.
type CreatedProject struct {
	Project      Project       `json:"project"`
	Environments []Environment `json:"environments"`
}

// CreateProject creates a project and its default environments.
func (c *Client) CreateProject(
	ctx context.Context,
	org, name, slug, description string,
) (*CreatedProject, error) {
	body := map[string]any{"name": name}
	if slug != "" {
		body["slug"] = slug
	}
	if description != "" {
		body["description"] = description
	}
	var created CreatedProject
	if err := c.Post(ctx, orgPath(org)+"/projects", body, &created); err != nil {
		return nil, err
	}
	return &created, nil
}

// DeleteProject soft-deletes a project. `confirm` carries the slug, which the
// server requires when the project holds a production environment; sending it
// unconditionally costs nothing and removes a retry the user would not
// understand.
func (c *Client) DeleteProject(ctx context.Context, org, project, confirm string) error {
	return c.Delete(ctx, projectPath(org, project), map[string]any{"confirm": confirm}, nil)
}

// CreateEnvironment creates an environment together with its data key — one
// server-side transaction, because an environment without a key silently
// rejects every write it will ever receive.
func (c *Client) CreateEnvironment(
	ctx context.Context,
	org, project, name, slug string,
	isProduction bool,
) (*Environment, error) {
	body := map[string]any{"name": name}
	if slug != "" {
		body["slug"] = slug
	}
	if isProduction {
		body["isProduction"] = true
	}
	var response struct {
		Environment Environment `json:"environment"`
	}
	if err := c.Post(ctx, projectPath(org, project)+"/environments", body, &response); err != nil {
		return nil, err
	}
	return &response.Environment, nil
}

// DeleteEnvironment soft-deletes an environment. As for DeleteProject, the
// confirmation is always sent.
func (c *Client) DeleteEnvironment(ctx context.Context, org, project, env, confirm string) error {
	return c.Delete(ctx, envPath(org, project, env), map[string]any{"confirm": confirm}, nil)
}

// ServiceToken is one CI credential as the listing describes it. No hash, and
// no value: a token's value appears in the creation response and nowhere else,
// ever again.
type ServiceToken struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	TokenPrefix     string   `json:"tokenPrefix"`
	ProjectSlug     string   `json:"projectSlug"`
	EnvironmentSlug string   `json:"environmentSlug"`
	AccessLevel     string   `json:"accessLevel"`
	IPAllowlist     []string `json:"ipAllowlist"`
	CreatedAt       string   `json:"createdAt"`
	ExpiresAt       *string  `json:"expiresAt"`
	LastUsedAt      *string  `json:"lastUsedAt"`
	RevokedAt       *string  `json:"revokedAt"`
}

// CliToken is one device. The listing is the caller's own devices only.
type CliToken struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	TokenPrefix string  `json:"tokenPrefix"`
	CreatedAt   string  `json:"createdAt"`
	ExpiresAt   *string `json:"expiresAt"`
	LastUsedAt  *string `json:"lastUsedAt"`
	RevokedAt   *string `json:"revokedAt"`
	IsCurrent   bool    `json:"isCurrent"`
}

// ServiceTokens lists the organisation's CI credentials.
func (c *Client) ServiceTokens(ctx context.Context, org string) ([]ServiceToken, error) {
	var response struct {
		Data []ServiceToken `json:"data"`
	}
	if err := c.Get(ctx, orgPath(org)+"/tokens/service", &response); err != nil {
		return nil, err
	}
	return response.Data, nil
}

// CliTokens lists this account's devices in the organisation, revoked ones
// included — "did signing out that laptop work?" deserves an answer.
func (c *Client) CliTokens(ctx context.Context, org string) ([]CliToken, error) {
	var response struct {
		Data []CliToken `json:"data"`
	}
	if err := c.Get(ctx, orgPath(org)+"/tokens/cli", &response); err != nil {
		return nil, err
	}
	return response.Data, nil
}

// RevokeToken kills one credential. `kind` is "cli" or "service"; the server
// decides who may pull which switch.
func (c *Client) RevokeToken(ctx context.Context, org, kind, tokenID string) error {
	path := fmt.Sprintf("%s/tokens/%s/%s", orgPath(org), url.PathEscape(kind), url.PathEscape(tokenID))
	return c.Delete(ctx, path, nil, nil)
}

// Member is one row of the organisation's member listing.
type Member struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	DisplayName *string `json:"displayName"`
	Role        string  `json:"role"`
	Status      string  `json:"status"`
	JoinedAt    string  `json:"joinedAt"`
	IsYou       bool    `json:"isYou"`
}

// Seats is the organisation's seat usage, returned beside the members.
type Seats struct {
	Used               int `json:"used"`
	PendingInvitations int `json:"pendingInvitations"`
	Limit              int `json:"limit"`
}

// Members lists the organisation's members, walking pagination.
func (c *Client) Members(ctx context.Context, org string) ([]Member, *Seats, error) {
	var all []Member
	var seats Seats
	cursor := ""
	for page := 0; page < pageLimit; page++ {
		path := orgPath(org) + "/members?limit=100"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		var response struct {
			Data       []Member `json:"data"`
			Seats      Seats    `json:"seats"`
			NextCursor *string  `json:"nextCursor"`
		}
		if err := c.Get(ctx, path, &response); err != nil {
			return nil, nil, err
		}
		all = append(all, response.Data...)
		seats = response.Seats
		if response.NextCursor == nil {
			return all, &seats, nil
		}
		cursor = *response.NextCursor
	}
	return all, &seats, fmt.Errorf("too many pages of members; narrow the question on the dashboard")
}

// AuditEvent is one row of the log. `metadata` is left as decoded JSON: the
// server has already sanitised and redacted it on the way in, and the shape
// varies by action — typing every variant here would mean this client had to
// be rebuilt whenever a new action was recorded.
type AuditEvent struct {
	ID           string         `json:"id"`
	ActorType    string         `json:"actorType"`
	ActorID      *string        `json:"actorId"`
	ActorLabel   *string        `json:"actorLabel"`
	Action       string         `json:"action"`
	ResourceType *string        `json:"resourceType"`
	Outcome      string         `json:"outcome"`
	IPAddress    *string        `json:"ipAddress"`
	RequestID    *string        `json:"requestId"`
	Metadata     map[string]any `json:"metadata"`
	CreatedAt    string         `json:"createdAt"`
}

// AuditFilter narrows the log. Empty fields are omitted from the query.
type AuditFilter struct {
	Action          string
	ProjectSlug     string
	EnvironmentSlug string
	Outcome         string
	// From and To are RFC 3339 timestamps. The server clamps the range to
	// ninety days and reports what it actually scanned.
	From  string
	To    string
	Limit int
}

// AuditPage is what one Audit call returned, plus the window the server says
// it really scanned — which is not always the one that was asked for.
type AuditPage struct {
	Events []AuditEvent `json:"events"`
	Window struct {
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"window"`
	// Truncated is true when the log held more rows than the limit allowed —
	// so a caller is never left believing it read everything.
	Truncated bool `json:"truncated"`
}

// Audit reads the log, following the keyset cursor until the requested number
// of events is in hand.
func (c *Client) Audit(ctx context.Context, org string, filter AuditFilter) (*AuditPage, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}

	result := &AuditPage{Events: []AuditEvent{}}
	cursor := ""

	for page := 0; page < pageLimit; page++ {
		query := url.Values{}
		// The server caps a page at 200; asking for exactly what is left keeps
		// the last request from over-reading.
		remaining := limit - len(result.Events)
		if remaining > 200 {
			remaining = 200
		}
		query.Set("limit", fmt.Sprint(remaining))
		for key, value := range map[string]string{
			"action":          filter.Action,
			"projectSlug":     filter.ProjectSlug,
			"environmentSlug": filter.EnvironmentSlug,
			"outcome":         filter.Outcome,
			"from":            filter.From,
			"to":              filter.To,
		} {
			if value != "" {
				query.Set(key, value)
			}
		}
		if cursor != "" {
			query.Set("cursor", cursor)
		}

		var response struct {
			Data       []AuditEvent `json:"data"`
			NextCursor *string      `json:"nextCursor"`
			Window     struct {
				From string `json:"from"`
				To   string `json:"to"`
			} `json:"window"`
		}
		if err := c.Get(ctx, orgPath(org)+"/audit?"+query.Encode(), &response); err != nil {
			return nil, err
		}

		result.Events = append(result.Events, response.Data...)
		result.Window = response.Window

		if response.NextCursor == nil {
			return result, nil
		}
		if len(result.Events) >= limit {
			result.Truncated = true
			return result, nil
		}
		cursor = *response.NextCursor
	}

	result.Truncated = true
	return result, nil
}

func orgPath(org string) string {
	return "/api/orgs/" + url.PathEscape(org)
}

func projectPath(org, project string) string {
	return orgPath(org) + "/projects/" + url.PathEscape(project)
}

func envPath(org, project, env string) string {
	return projectPath(org, project) + "/environments/" + url.PathEscape(env)
}

func secretPath(org, project, env, name string) string {
	return envPath(org, project, env) + "/secrets/" + url.PathEscape(name)
}
