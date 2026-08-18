package cred

import (
	"errors"
	"testing"

	"github.com/playxoft/xecret/cli/internal/keyring"
)

type memoryStore map[string]string

func (m memoryStore) Set(key, value string) error { m[key] = value; return nil }
func (m memoryStore) Get(key string) (string, error) {
	value, ok := m[key]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return value, nil
}
func (m memoryStore) Delete(key string) error {
	if _, ok := m[key]; !ok {
		return keyring.ErrNotFound
	}
	delete(m, key)
	return nil
}

func TestSaveLoadRoundTrip(t *testing.T) {
	store := memoryStore{}
	saved := Credentials{
		APIURL:  "https://xecret.example",
		Token:   "xct_live_secret",
		OrgSlug: "acme",
		Email:   "dev@example.com",
	}
	if err := Save(store, saved); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load(store)
	if err != nil {
		t.Fatal(err)
	}
	if *loaded != saved {
		t.Errorf("round trip changed the credential: %+v", loaded)
	}
}

func TestLoadWithoutLogin(t *testing.T) {
	if _, err := Load(memoryStore{}); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("want ErrNotLoggedIn, got %v", err)
	}
}

func TestLoadRejectsCorruptPayload(t *testing.T) {
	store := memoryStore{"credentials": "{not json"}
	if _, err := Load(store); err == nil {
		t.Fatal("corrupt credentials must be an error, not a zero value")
	}
}

func TestLoadRejectsEmptyToken(t *testing.T) {
	store := memoryStore{"credentials": `{"apiUrl":"https://x","token":"","orgSlug":"a","email":"e"}`}
	if _, err := Load(store); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("an empty token is not a login; got %v", err)
	}
}

func TestClearIsIdempotent(t *testing.T) {
	store := memoryStore{}
	if err := Save(store, Credentials{APIURL: "https://x", Token: "t", OrgSlug: "o", Email: "e"}); err != nil {
		t.Fatal(err)
	}
	if err := Clear(store); err != nil {
		t.Fatal(err)
	}
	if err := Clear(store); err != nil {
		t.Fatalf("clearing an empty store must succeed, got %v", err)
	}
}
