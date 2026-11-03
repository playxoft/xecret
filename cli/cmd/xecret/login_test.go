package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/playxoft/xecret/cli/internal/cred"
)

// A login replaces the stored credential. Left live on the server, each
// replaced one is a device nothing on this machine can use or revoke, and the
// plan's ceiling on CLI devices per person fills with them — so the login
// revokes it once the new one is saved, best effort.

type revokeRecorder struct {
	mu       sync.Mutex
	requests []string
}

func (r *revokeRecorder) server(t *testing.T, status int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.requests = append(r.requests, req.Method+" "+req.URL.Path+" "+req.Header.Get("Authorization"))
		r.mu.Unlock()
		w.WriteHeader(status)
		if status >= 400 {
			_, _ = w.Write([]byte(`{"error":{"code":"forbidden","message":"No.","requestId":"req-1"}}`))
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestALoginRevokesTheCredentialItReplaces(t *testing.T) {
	recorder := &revokeRecorder{}
	server := recorder.server(t, http.StatusNoContent)

	previous := &cred.Credentials{APIURL: server.URL, Token: "xct_live_old"}
	if err := revokeReplaced(context.Background(), previous, server.URL, "xct_live_new"); err != nil {
		t.Fatalf("revokeReplaced: %v", err)
	}

	want := "DELETE /api/cli/token Bearer xct_live_old"
	if len(recorder.requests) != 1 || recorder.requests[0] != want {
		t.Fatalf("requests = %q, want [%q]", recorder.requests, want)
	}
}

func TestReplacedCredentialIsRevokedWhereItBelongs(t *testing.T) {
	// A login to a different deployment revokes the old credential against the
	// deployment that issued it, never the new one.
	old := &revokeRecorder{}
	oldServer := old.server(t, http.StatusNoContent)
	current := &revokeRecorder{}
	currentServer := current.server(t, http.StatusNoContent)

	previous := &cred.Credentials{APIURL: oldServer.URL, Token: "xct_live_old"}
	if err := revokeReplaced(context.Background(), previous, currentServer.URL, "xct_live_new"); err != nil {
		t.Fatalf("revokeReplaced: %v", err)
	}
	if len(old.requests) != 1 || len(current.requests) != 0 {
		t.Fatalf("old saw %q, current saw %q", old.requests, current.requests)
	}
}

func TestNothingIsRevokedWithoutAReplacedCredential(t *testing.T) {
	recorder := &revokeRecorder{}
	server := recorder.server(t, http.StatusNoContent)

	for _, previous := range []*cred.Credentials{
		nil,
		{APIURL: server.URL, Token: ""},
		{APIURL: server.URL, Token: "xct_live_same"},
	} {
		if err := revokeReplaced(context.Background(), previous, server.URL, "xct_live_same"); err != nil {
			t.Fatalf("revokeReplaced(%+v): %v", previous, err)
		}
	}
	if len(recorder.requests) != 0 {
		t.Fatalf("requests = %q, want none", recorder.requests)
	}
}

func TestAnAlreadyRevokedCredentialIsNotAFailure(t *testing.T) {
	recorder := &revokeRecorder{}
	server := recorder.server(t, http.StatusUnauthorized)

	previous := &cred.Credentials{APIURL: server.URL, Token: "xct_live_old"}
	if err := revokeReplaced(context.Background(), previous, server.URL, "xct_live_new"); err != nil {
		t.Fatalf("a 401 means it is already gone, want nil: %v", err)
	}
}

func TestAFailedRevocationIsReportedForTheCallerToWarnAbout(t *testing.T) {
	recorder := &revokeRecorder{}
	server := recorder.server(t, http.StatusForbidden)

	previous := &cred.Credentials{APIURL: server.URL, Token: "xct_live_old"}
	if err := revokeReplaced(context.Background(), previous, server.URL, "xct_live_new"); err == nil {
		t.Fatal("want the refusal returned, so the login can warn about the stale device")
	}
}
