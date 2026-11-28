package ids

import "testing"

func TestUUIDv7IsCanonical(t *testing.T) {
	id, err := UUIDv7()
	if err != nil {
		t.Fatal(err)
	}
	if canonical, ok := Canonical(id); !ok || canonical != id {
		t.Fatalf("Canonical(%q) = %q, %v", id, canonical, ok)
	}
}

func TestCanonicalTellsAnIdFromASlug(t *testing.T) {
	for input, want := range map[string]string{
		"0192f0a1-0000-7000-8000-00000000a001": "0192f0a1-0000-7000-8000-00000000a001",
		"0192F0A1-0000-7000-8000-00000000A001": "0192f0a1-0000-7000-8000-00000000a001",
	} {
		if got, ok := Canonical(input); !ok || got != want {
			t.Errorf("Canonical(%q) = %q, %v; want %q", input, got, ok, want)
		}
	}
	for _, input := range []string{
		"",
		"acme",
		"payments-api",
		"0192f0a1000070008000000000000a001",
		"0192f0a1-0000-7000-8000-00000000a00g",
		"0192f0a1-0000-7000-8000-00000000a0011",
		"{0192f0a1-0000-7000-8000-00000000a001}",
		" 0192f0a1-0000-7000-8000-00000000a001",
	} {
		if _, ok := Canonical(input); ok {
			t.Errorf("Canonical(%q) accepted a non-UUID", input)
		}
	}
}
