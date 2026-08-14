// Package api is the CLI's HTTP client for the xecret API.
//
// Contract: docs/architecture/api.md. Three rules hold everywhere here:
//
//  1. The bearer token is attached in exactly one place and never logged,
//     printed, or embedded in an error.
//  2. A response body is never quoted into an error message — in this product
//     a body can carry a decrypted secret. Errors are built from the fixed
//     fields of the documented error envelope, nothing else.
//  3. Retries happen only where they are safe: idempotent requests, and only
//     on failures that mean "the server never processed this" — network
//     errors and 502/503/504.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// MaxResponseBytes bounds how much of any response this client will read.
// The largest legitimate response is a full environment pull, and the server
// caps request bodies at 1 MB; 8 MB of headroom means a misbehaving proxy
// cannot make the CLI buffer without limit.
const MaxResponseBytes = 8 << 20

// Client talks to one xecret deployment as at most one credential.
type Client struct {
	// BaseURL is the deployment's origin, e.g. https://xecret.playxoft.com —
	// no trailing slash, no /api suffix.
	BaseURL string
	// Token is the bearer credential, or "" before login.
	Token     string
	UserAgent string
	// HTTP defaults to a client with a 30 s timeout.
	HTTP *http.Client
}

// New builds a client for base, holding token (which may be empty).
func New(base, token, userAgent string) *Client {
	return &Client{
		BaseURL:   strings.TrimRight(base, "/"),
		Token:     token,
		UserAgent: userAgent,
		HTTP:      &http.Client{Timeout: 30 * time.Second},
	}
}

// Error is the server's documented error envelope, plus the transport cases
// the server can never send.
type Error struct {
	// Status is the HTTP status, or 0 when the request never got a response.
	Status    int
	Code      string
	Message   string
	RequestID string
}

func (e *Error) Error() string {
	if e.Status == 0 {
		return e.Message
	}
	if e.RequestID != "" {
		return fmt.Sprintf("%s (request %s)", e.Message, e.RequestID)
	}
	return e.Message
}

// Hint says what to do next, which is the half of an error message that
// matters at a terminal. Empty when there is nothing actionable to add.
func (e *Error) Hint() string {
	switch e.Code {
	case "unauthenticated":
		return "Run 'xecret login' to authenticate this device."
	case "session_locked":
		// Cannot happen for a bearer credential; kept because a wrong hint is
		// worse than a defensive one.
		return "Unlock your session in the dashboard, then retry."
	case "forbidden":
		return "Ask an organisation admin to review your access."
	case "not_found":
		return "Check the organisation, project and environment slugs in .xecret.yaml."
	case "rate_limited":
		return "Wait a moment, then retry."
	case "network_error":
		return "Check your connection, or retry with --offline where supported."
	case "unavailable":
		return "The server is misconfigured or down. Retry shortly."
	}
	return ""
}

// IsNetworkError reports whether err means the server was never reached or
// never processed the request — the only failures `xecret run` may answer
// from the offline cache. A 4xx is deliberately excluded: a revoked token
// falling back to cached secrets would turn the cache into a revocation
// bypass.
func IsNetworkError(err error) bool {
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.Status == 0 || apiErr.Status == 502 || apiErr.Status == 503 || apiErr.Status == 504
}

// AsError returns err as an *Error when it is one.
func AsError(err error) (*Error, bool) {
	var apiErr *Error
	ok := errors.As(err, &apiErr)
	return apiErr, ok
}

// errorEnvelope mirrors §3 of the API contract.
type errorEnvelope struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"requestId"`
		Fields    []struct {
			Field   string `json:"field"`
			Message string `json:"message"`
		} `json:"fields"`
	} `json:"error"`
}

const (
	retryAttempts = 3
	retryBaseWait = 400 * time.Millisecond
)

// Get issues a GET and decodes the JSON response into out.
func (c *Client) Get(ctx context.Context, path string, out any) error {
	return c.doRetry(ctx, http.MethodGet, path, nil, out, nil)
}

// GetRaw issues a GET and returns the response body verbatim — for the pull
// and export documents, which are not JSON envelopes.
func (c *Client) GetRaw(ctx context.Context, path string) ([]byte, error) {
	var raw []byte
	err := c.doRetry(ctx, http.MethodGet, path, nil, nil, &raw)
	return raw, err
}

// Post issues a POST. Not retried: the server may have processed a request
// whose response was lost, and repeating a mutation is not this layer's call.
func (c *Client) Post(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out, nil)
}

// Patch issues a PATCH. Not retried, as for Post.
func (c *Client) Patch(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPatch, path, body, out, nil)
}

// Delete issues a DELETE. Not retried, as for Post.
func (c *Client) Delete(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodDelete, path, body, out, nil)
}

func (c *Client) doRetry(
	ctx context.Context,
	method, path string,
	body, out any,
	raw *[]byte,
) error {
	var lastErr error
	for attempt := 0; attempt < retryAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(retryBaseWait << (attempt - 1)):
			}
		}

		lastErr = c.do(ctx, method, path, body, out, raw)
		if lastErr == nil || !IsNetworkError(lastErr) {
			return lastErr
		}
	}
	return lastErr
}

func (c *Client) do(ctx context.Context, method, path string, body, out any, raw *[]byte) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encoding request: %w", err)
		}
		reader = bytes.NewReader(payload)
	}

	request, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if c.UserAgent != "" {
		request.Header.Set("User-Agent", c.UserAgent)
	}
	if c.Token != "" {
		request.Header.Set("Authorization", "Bearer "+c.Token)
	}

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	response, err := httpClient.Do(request)
	if err != nil {
		// The underlying error is not embedded: Go transport errors quote the
		// full URL, and error text routinely ends up in logs and bug reports.
		return &Error{
			Status:  0,
			Code:    "network_error",
			Message: "could not reach " + redactedHost(c.BaseURL),
		}
	}
	defer response.Body.Close()

	limited := io.LimitReader(response.Body, MaxResponseBytes)

	if response.StatusCode < 200 || response.StatusCode > 299 {
		return decodeError(response, limited)
	}

	if raw != nil {
		data, readErr := io.ReadAll(limited)
		if readErr != nil {
			return &Error{Status: 0, Code: "network_error", Message: "response was cut short"}
		}
		*raw = data
		return nil
	}

	if out == nil {
		// Drain so the connection can be reused.
		_, _ = io.Copy(io.Discard, limited)
		return nil
	}

	if err := json.NewDecoder(limited).Decode(out); err != nil {
		return &Error{
			Status:    response.StatusCode,
			Code:      "internal_error",
			Message:   "the server's response could not be read",
			RequestID: response.Header.Get("x-xecret-request-id"),
		}
	}
	return nil
}

func decodeError(response *http.Response, body io.Reader) error {
	apiErr := &Error{
		Status:    response.StatusCode,
		Code:      "internal_error",
		Message:   fmt.Sprintf("the server answered %d", response.StatusCode),
		RequestID: response.Header.Get("x-xecret-request-id"),
	}

	var envelope errorEnvelope
	if err := json.NewDecoder(body).Decode(&envelope); err == nil && envelope.Error.Code != "" {
		apiErr.Code = envelope.Error.Code
		if envelope.Error.Message != "" {
			apiErr.Message = envelope.Error.Message
		}
		if envelope.Error.RequestID != "" {
			apiErr.RequestID = envelope.Error.RequestID
		}
		// Field problems carry the rule that failed, never the value — safe
		// and genuinely useful at a terminal.
		if len(envelope.Error.Fields) > 0 {
			details := make([]string, 0, len(envelope.Error.Fields))
			for _, field := range envelope.Error.Fields {
				details = append(details, field.Field+": "+field.Message)
			}
			apiErr.Message += " (" + strings.Join(details, "; ") + ")"
		}
	}
	return apiErr
}

// redactedHost reduces a base URL to its host for error text.
func redactedHost(base string) string {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" {
		return "the xecret server"
	}
	return parsed.Host
}
