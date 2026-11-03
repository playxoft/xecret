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

// server answers every request with status and body.
func (r *revokeRecorder) server(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.requests = append(r.requests, req.Method+" "+req.URL.Path+" "+req.Header.Get("Authorization"))
		r.mu.Unlock()
		if body != "" {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

const xecretUnauthenticated = `{"error":{"code":"unauthenticated","message":"Not signed in.","requestId":"req-1"}}`

func TestALoginRevokesTheCredentialItReplaces(t *testing.T) {
	recorder := &revokeRecorder{}
	server := recorder.server(t, http.StatusNoContent, "")

	previous := &cred.Credentials{APIURL: server.URL, Token: "xct_live_old"}
	if err := revokeReplaced(context.Background(), previous, "xct_live_new"); err != nil {
		t.Fatalf("revokeReplaced: %v", err)
	}

	want := "DELETE /api/cli/token Bearer xct_live_old"
	if len(recorder.requests) != 1 || recorder.requests[0] != want {
		t.Fatalf("requests = %q, want [%q]", recorder.requests, want)
	}
}

func TestNothingIsRevokedWithoutAReplacedCredential(t *testing.T) {
	recorder := &revokeRecorder{}
	server := recorder.server(t, http.StatusNoContent, "")

	for _, previous := range []*cred.Credentials{
		nil,
		{APIURL: server.URL, Token: ""},
		{APIURL: server.URL, Token: "xct_live_same"},
	} {
		if err := revokeReplaced(context.Background(), previous, "xct_live_same"); err != nil {
			t.Fatalf("revokeReplaced(%+v): %v", previous, err)
		}
	}
	if len(recorder.requests) != 0 {
		t.Fatalf("requests = %q, want none", recorder.requests)
	}
}

// A credential stored with no deployment is not presented anywhere: there is
// no deployment it provably belongs to, and sending it to the one this login
// used could hand one deployment's token to another.
func TestACredentialWithNoDeploymentIsNotSentAnywhere(t *testing.T) {
	previous := &cred.Credentials{APIURL: "", Token: "xct_live_old"}
	if err := revokeReplaced(context.Background(), previous, "xct_live_new"); err != nil {
		t.Fatalf("revokeReplaced: %v", err)
	}
}

func TestXecretsOwn401MeansTheCredentialIsAlreadyGone(t *testing.T) {
	recorder := &revokeRecorder{}
	server := recorder.server(t, http.StatusUnauthorized, xecretUnauthenticated)

	previous := &cred.Credentials{APIURL: server.URL, Token: "xct_live_old"}
	if err := revokeReplaced(context.Background(), previous, "xct_live_new"); err != nil {
		t.Fatalf("xecret's unauthenticated means it is already gone, want nil: %v", err)
	}
}

// A 401 that is not xecret's — a proxy, an access gateway in front of it —
// never reached the server that holds the credential, so it is not taken to
// mean the credential is gone.
func TestAnother401IsReportedLikeAnyFailure(t *testing.T) {
	for _, body := range []string{"", "Unauthorized", `{"error":{"code":"forbidden","message":"No."}}`} {
		recorder := &revokeRecorder{}
		server := recorder.server(t, http.StatusUnauthorized, body)

		previous := &cred.Credentials{APIURL: server.URL, Token: "xct_live_old"}
		if err := revokeReplaced(context.Background(), previous, "xct_live_new"); err == nil {
			t.Fatalf("a 401 with body %q is not xecret's; want it reported", body)
		}
	}
}

func TestAFailedRevocationIsReportedForTheCallerToWarnAbout(t *testing.T) {
	recorder := &revokeRecorder{}
	server := recorder.server(t, http.StatusForbidden, `{"error":{"code":"forbidden","message":"No."}}`)

	previous := &cred.Credentials{APIURL: server.URL, Token: "xct_live_old"}
	if err := revokeReplaced(context.Background(), previous, "xct_live_new"); err == nil {
		t.Fatal("want the refusal returned, so the login can warn about the stale device")
	}
}
