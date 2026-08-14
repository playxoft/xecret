package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestGetDecodesAndAttachesBearer(t *testing.T) {
	var authHeader atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader.Store(r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"environments":[{"name":"Dev","slug":"development","isProduction":false}]}`))
	}))
	defer server.Close()

	client := New(server.URL, "xct_live_abc", "test-agent")
	environments, err := client.Environments(context.Background(), "acme", "web")
	if err != nil {
		t.Fatal(err)
	}
	if len(environments) != 1 || environments[0].Slug != "development" {
		t.Errorf("decoded %+v", environments)
	}
	if got := authHeader.Load(); got != "Bearer xct_live_abc" {
		t.Errorf("Authorization = %q", got)
	}
}

func TestErrorEnvelopeIsDecoded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"Not found.","requestId":"req-1"}}`))
	}))
	defer server.Close()

	client := New(server.URL, "", "test-agent")
	_, err := client.FetchMe(context.Background())

	apiErr, ok := AsError(err)
	if !ok {
		t.Fatalf("want *Error, got %T: %v", err, err)
	}
	if apiErr.Code != "not_found" || apiErr.Status != 404 || apiErr.RequestID != "req-1" {
		t.Errorf("decoded %+v", apiErr)
	}
	if apiErr.Hint() == "" {
		t.Error("not_found should carry a hint about slugs")
	}
}

func TestGetRetriesOn503(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"environments":[]}`))
	}))
	defer server.Close()

	client := New(server.URL, "", "test-agent")
	if _, err := client.Environments(context.Background(), "acme", "web"); err != nil {
		t.Fatalf("expected the third attempt to succeed, got %v", err)
	}
	if calls.Load() != 3 {
		t.Errorf("server saw %d calls, want 3", calls.Load())
	}
}

func TestPostIsNeverRetried(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	client := New(server.URL, "", "test-agent")
	_, err := client.ExchangeCode(context.Background(), "code", "verifier")
	if err == nil {
		t.Fatal("expected an error")
	}
	if calls.Load() != 1 {
		t.Errorf("a mutation was retried: server saw %d calls", calls.Load())
	}
}

func TestNetworkErrorClassification(t *testing.T) {
	// A server that is not listening produces the Status==0 network case.
	client := New("http://127.0.0.1:1", "", "test-agent")
	_, err := client.FetchMe(context.Background())
	if !IsNetworkError(err) {
		t.Fatalf("an unreachable server must classify as a network error, got %v", err)
	}

	// A 401 must NOT: falling back to cache on it would bypass revocation.
	if IsNetworkError(&Error{Status: 401, Code: "unauthenticated"}) {
		t.Fatal("401 must never count as a network error")
	}
	if !IsNetworkError(&Error{Status: 503, Code: "unavailable"}) {
		t.Fatal("503 is unavailability and may fall back")
	}
}

func TestNetworkErrorNeverQuotesTheURL(t *testing.T) {
	client := New("http://127.0.0.1:1/base?token=oops", "", "test-agent")
	_, err := client.FetchMe(context.Background())
	if err == nil {
		t.Fatal("expected an error")
	}
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("want *Error, got %T", err)
	}
	if got := apiErr.Error(); len(got) > 0 && (strings.Contains(got, "?token=") || strings.Contains(got, "/base")) {
		t.Errorf("error text leaked URL parts: %q", got)
	}
}

func TestSecretPathIsEscaped(t *testing.T) {
	var path atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path.Store(r.URL.EscapedPath())
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"Not found.","requestId":"r"}}`))
	}))
	defer server.Close()

	client := New(server.URL, "", "test-agent")
	_, _ = client.Reveal(context.Background(), "a/b", "p", "e", "NAME")
	if got, _ := path.Load().(string); !strings.Contains(got, "a%2Fb") {
		t.Errorf("org slug was not path-escaped: %q", got)
	}
}
