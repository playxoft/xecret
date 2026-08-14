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
