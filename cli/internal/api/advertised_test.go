package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The headers are read off an ordinary reply, without a request of their own.
//
// The request count is the assertion that matters: the whole justification for
// this mechanism is that it adds no traffic. A future refactor that "helpfully"
// fetched the version would keep every other assertion here green.
func TestAdvertisedIsReadFromAnOrdinaryResponse(t *testing.T) {
	ForgetAdvertised()
	t.Cleanup(ForgetAdvertised)

	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("x-xecret-cli-latest", "9.9.9")
		w.Header().Set("x-xecret-cli-headline", "Reads e2ee environments.")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"organizations":[]}`))
	}))
	defer server.Close()

	if _, err := New(server.URL, "xct_live_abc", "xecret-cli/0.1.2").
		Organizations(context.Background()); err != nil {
		t.Fatal(err)
	}

	if requests != 1 {
		t.Errorf("the version was learned in %d requests, want 1 — it must cost none of its own", requests)
	}

	latest := Advertised()
	if latest == nil {
		t.Fatal("nothing was recorded from a response that advertised a release")
	}
	if latest.Version != "9.9.9" || latest.Headline != "Reads e2ee environments." {
		t.Errorf("recorded %+v", latest)
	}
}

// A refusal still teaches the CLI which release the server expects. An old
// binary is disproportionately likely to be the one being refused, which is
// exactly when the notice is worth showing.
func TestAdvertisedIsReadFromAnErrorResponse(t *testing.T) {
	ForgetAdvertised()
	t.Cleanup(ForgetAdvertised)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-xecret-cli-latest", "9.9.9")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"forbidden","message":"no"}}`))
	}))
	defer server.Close()

	if _, err := New(server.URL, "xct_live_abc", "xecret-cli/0.1.2").
		Organizations(context.Background()); err == nil {
		t.Fatal("the 403 was not reported")
	}

	if latest := Advertised(); latest == nil || latest.Version != "9.9.9" {
		t.Errorf("a refusal taught this process nothing: %+v", latest)
	}
}

// A server that says nothing leaves nothing recorded — the silence an older
// deployment and a self-hoster who would rather not both depend on.
func TestASilentServerAdvertisesNothing(t *testing.T) {
	ForgetAdvertised()
	t.Cleanup(ForgetAdvertised)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"organizations":[]}`))
	}))
	defer server.Close()

	if _, err := New(server.URL, "xct_live_abc", "xecret-cli/0.1.2").
		Organizations(context.Background()); err != nil {
		t.Fatal(err)
	}

	if latest := Advertised(); latest != nil {
		t.Errorf("a silent server produced %+v", latest)
	}
}

// A headline without a version cannot produce a notice, because there would be
// nothing to recommend.
func TestAHeadlineWithoutAVersionIsIgnored(t *testing.T) {
	ForgetAdvertised()
	t.Cleanup(ForgetAdvertised)

	noteAdvertised("", "a reason with no release attached")

	if latest := Advertised(); latest != nil {
		t.Errorf("recorded %+v from a headline alone", latest)
	}
}
