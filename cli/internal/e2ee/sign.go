package e2ee

import (
	"crypto/ed25519"
	"fmt"
)

// GrantSignatureDomain is the domain separation tag. The same Ed25519 key will
// eventually sign other things, and without a tag naming this structure a
// signature produced for one purpose could be presented as a signature for
// another whose canonical encoding happened to collide.
const GrantSignatureDomain = "xecret.v2.grant-sig"

// GrantSignatureFields is everything a grant signature covers — exactly the
// env_key_grants row's own columns.
type GrantSignatureFields struct {
	EnvironmentID string
	EDKVersion    int
	RecipientKind RecipientKind
	RecipientID   string
	// RecipientPublicKey is the recipient's X25519 public key, 32 raw bytes.
	RecipientPublicKey []byte
	// EDKSealed is the full xk2.x25519.… string, as stored.
	EDKSealed string
	// EHKSealed is the full xk2.x25519.… string, as stored.
	EHKSealed string
}

// GrantSigningPayload builds the canonical byte string an Ed25519 grant
// signature covers (spec §6.1):
//
//	lp(x) := u32be(len(x)) ‖ x
//
//	lp("xecret.v2.grant-sig") ‖ lp(environmentId) ‖ lp(u32be(edkVersion))
//	  ‖ lp(recipientKind) ‖ lp(recipientId) ‖ lp(recipientPublicKey)
//	  ‖ lp(edkSealedBlob) ‖ lp(ehkSealedBlob)
//
// Exported in its own right because the test vectors carry it: Ed25519 is
// deterministic, so a signature mismatch says only that *something* upstream
// differs, while the payload bytes say which field the two implementations
// disagreed about — which is where every cross-implementation bug in a
// canonicalisation scheme actually lives.
//
// The full blob strings are signed, prefix included, not the decoded payloads.
// That covers the xk2.x25519. version tag, so a downgrade to a future weaker
// algorithm cannot reuse a signature. Both blobs are signed: signing only the
// EDK would leave the EHK unauthenticated in a row that claims otherwise.
func GrantSigningPayload(fields GrantSignatureFields) ([]byte, error) {
	if err := assertUUID(fields.EnvironmentID, "environmentId"); err != nil {
		return nil, err
	}
	if err := assertUUID(fields.RecipientID, "recipientId"); err != nil {
		return nil, err
	}
	if err := assertRecipientKind(fields.RecipientKind); err != nil {
		return nil, err
	}
	if err := assertVersion(fields.EDKVersion, "edkVersion"); err != nil {
		return nil, err
	}
	if len(fields.RecipientPublicKey) != PublicKeyBytes {
		return nil, fmt.Errorf("recipientPublicKey must be %d bytes", PublicKeyBytes)
	}

	// Parsed, not merely pattern-matched: a signature over a string that is not
	// a sealed box would authenticate something no reader can open.
	if _, err := ParseBlob(fields.EDKSealed, AlgX25519); err != nil {
		return nil, fmt.Errorf("edkSealed: %w", err)
	}
	if _, err := ParseBlob(fields.EHKSealed, AlgX25519); err != nil {
		return nil, fmt.Errorf("ehkSealed: %w", err)
	}

	payload := make([]byte, 0, 256)
	for _, field := range [][]byte{
		[]byte(GrantSignatureDomain),
		[]byte(fields.EnvironmentID),
		u32be(uint32(fields.EDKVersion)),
		[]byte(fields.RecipientKind),
		[]byte(fields.RecipientID),
		fields.RecipientPublicKey,
		[]byte(fields.EDKSealed),
		[]byte(fields.EHKSealed),
	} {
		payload = append(payload, lengthPrefixed(field)...)
	}
	return payload, nil
}

// SignGrant signs a grant, returning an xk2.ed25519. blob.
//
// signerPrivateSeed is the 32-byte Ed25519 seed, as stored wrapped under the
// User Key — not the 64-byte expanded form.
func SignGrant(signerPrivateSeed []byte, fields GrantSignatureFields) (string, error) {
	if len(signerPrivateSeed) != PrivateKeyBytes {
		return "", fmt.Errorf("a signer private seed is %d bytes", PrivateKeyBytes)
	}
	payload, err := GrantSigningPayload(fields)
	if err != nil {
		return "", err
	}
	return FormatBlob(AlgEd25519, ed25519.Sign(ed25519.NewKeyFromSeed(signerPrivateSeed), payload))
}

// VerifyGrantSignature verifies a grant signature.
//
// Returns false rather than an error for every negative outcome, including a
// malformed signature blob: a verifier that errors on some rejections and
// returns false on others invites a caller to handle one path and not the
// other, and "unverified" is the same answer in every case.
//
// Verification is deferred as a product decision (ADR 0009, trade-off 3: it
// needs a trust root for signer keys). It ships anyway, because a signature
// scheme with no verifier in the same commit is one nobody has ever checked
// round-trips.
func VerifyGrantSignature(signerPublicKey []byte, fields GrantSignatureFields, signature string) bool {
	if len(signerPublicKey) != PublicKeyBytes {
		return false
	}
	raw, err := ParseBlob(signature, AlgEd25519)
	if err != nil {
		return false
	}
	payload, err := GrantSigningPayload(fields)
	if err != nil {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(signerPublicKey), payload, raw)
}
