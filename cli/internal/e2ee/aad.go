package e2ee

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

// AADPrefixV2 is the purpose prefix of every xk2 blob's Additional
// Authenticated Data.
//
// GCM authenticates AAD without encrypting it, so a ciphertext moved to a
// different row fails to decrypt rather than silently succeeding. The attack it
// defeats: an adversary with database write access but no key copies the
// ciphertext of DATABASE_URL from production into a development environment they
// are allowed to read, then reads the plaintext through the normal API.
//
// Spec §4.
const AADPrefixV2 = "xecret.aad.v2"

// RecipientKind is which principal a grant is sealed to. An env_key_grants row
// holds exactly one.
type RecipientKind string

const (
	// RecipientMember is a human member, keyed by env_key_grants.memberUserId.
	RecipientMember RecipientKind = "member"
	// RecipientToken is a service token, keyed by .serviceTokenId.
	RecipientToken RecipientKind = "token"
	// RecipientInvite is a pending invitation, keyed by .invitationId.
	RecipientInvite RecipientKind = "invite"
)

// WrapKind is which credential opens a User Key wrap. user_key_wraps.kind.
type WrapKind string

const (
	// WrapPassphrase is the master-passphrase wrap. There is only ever one.
	WrapPassphrase WrapKind = "passphrase"
	// WrapRecovery is one of the five recovery-code wraps.
	WrapRecovery WrapKind = "recovery"
	// WrapPRF is a passkey PRF wrap, one per credential.
	WrapPRF WrapKind = "prf"
)

var (
	uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

	// componentPattern is the delimiter invariant, and it is load-bearing: `|`
	// cannot appear inside a component, which is the whole reason the encoding
	// needs no length prefixes.
	componentPattern = regexp.MustCompile(`^[0-9a-zA-Z_-]+$`)

	// aadV2Pattern admits a well-formed v2 AAD as an HKDF info string.
	aadV2Pattern = regexp.MustCompile(`^xecret\.aad\.v2\.[a-z-]+(\|[0-9a-zA-Z_-]+)+$`)
)

// IsUUID reports whether a string is a canonical lowercase 36-character UUID.
//
// UUIDs enter xecret's cryptographic inputs in text form and never as 16 raw
// bytes: Go's uuid types are [16]byte and TypeScript's is a string, and
// converting between them introduces a byte-order convention that RFC 9562
// specifies but implementations get wrong often enough to be a known class of
// bug (spec §1.2, §6.2).
func IsUUID(value string) bool { return uuidPattern.MatchString(value) }

// IsAADv2 reports whether a string is a well-formed v2 AAD.
func IsAADv2(value string) bool { return aadV2Pattern.MatchString(value) }

// assertUUID and assertComponent never include the offending value in the
// error: these paths carry secret identifiers and credential ids, and error
// messages reach logs.
func assertUUID(value, label string) error {
	if !IsUUID(value) {
		return fmt.Errorf("AAD component %q must be a canonical lowercase UUID", label)
	}
	return nil
}

func assertComponent(value, label string) error {
	if !componentPattern.MatchString(value) {
		return fmt.Errorf("AAD component %q must match [0-9a-zA-Z_-]+", label)
	}
	return nil
}

func assertVersion(value int, label string) error {
	if value < 0 {
		return fmt.Errorf("AAD component %q must be a non-negative integer", label)
	}
	return nil
}

func assertRecipientKind(kind RecipientKind) error {
	switch kind {
	case RecipientMember, RecipientToken, RecipientInvite:
		return nil
	}
	return errors.New(`AAD component "recipientKind" must be member, token, or invite`)
}

// SecretValueAad binds a secret value ciphertext to its org, environment,
// secret, and version.
//
// orgId is redundant given environmentId and is included anyway, to match
// xecret.aad.v1.secret exactly: dropping it would make the migration's
// before/after comparison harder to reason about for no gain.
func SecretValueAad(orgID, environmentID, secretID string, version int) (string, error) {
	for _, field := range []struct{ value, label string }{
		{orgID, "orgId"}, {environmentID, "environmentId"}, {secretID, "secretId"},
	} {
		if err := assertUUID(field.value, field.label); err != nil {
			return "", err
		}
	}
	if err := assertVersion(version, "version"); err != nil {
		return "", err
	}
	return AADPrefixV2 + ".secret-value|" + orgID + "|" + environmentID + "|" + secretID + "|" +
		strconv.Itoa(version), nil
}

// SecretNoteAad binds a secret note ciphertext to its org, environment, and
// secret.
//
// No version: notes live on the secrets row, not on the append-only
// secret_versions row, so binding one would fabricate a component the two
// implementations would eventually disagree about.
func SecretNoteAad(orgID, environmentID, secretID string) (string, error) {
	for _, field := range []struct{ value, label string }{
		{orgID, "orgId"}, {environmentID, "environmentId"}, {secretID, "secretId"},
	} {
		if err := assertUUID(field.value, field.label); err != nil {
			return "", err
		}
	}
	return AADPrefixV2 + ".secret-note|" + orgID + "|" + environmentID + "|" + secretID, nil
}

// EDKGrantAad binds a sealed Environment Data Key to the environment, the EDK
// version, and the exact principal it was sealed to.
//
// The version is carried because rotation produces a new env_data_keys row: a
// grant for version 3 must not open as a grant for version 4.
func EDKGrantAad(environmentID string, edkVersion int, kind RecipientKind, recipientID string) (string, error) {
	if err := assertUUID(environmentID, "environmentId"); err != nil {
		return "", err
	}
	if err := assertVersion(edkVersion, "edkVersion"); err != nil {
		return "", err
	}
	if err := assertRecipientKind(kind); err != nil {
		return "", err
	}
	if err := assertUUID(recipientID, "recipientId"); err != nil {
		return "", err
	}
	return AADPrefixV2 + ".edk-grant|" + environmentID + "|" + strconv.Itoa(edkVersion) + "|" +
		string(kind) + "|" + recipientID, nil
}

// EHKGrantAad binds a sealed Environment HMAC Key to the environment and the
// principal.
//
// No version: the EHK is created once per environment and deliberately never
// rotated, which is what keeps valueHmac stable across EDK rotations.
func EHKGrantAad(environmentID string, kind RecipientKind, recipientID string) (string, error) {
	if err := assertUUID(environmentID, "environmentId"); err != nil {
		return "", err
	}
	if err := assertRecipientKind(kind); err != nil {
		return "", err
	}
	if err := assertUUID(recipientID, "recipientId"); err != nil {
		return "", err
	}
	return AADPrefixV2 + ".ehk-grant|" + environmentID + "|" + string(kind) + "|" + recipientID, nil
}

// UserKeyWrapAad binds one User Key wrap to its owner and to the credential
// that opens it.
//
// discriminator is the recovery code's lookup hash as lowercase hex, or a
// passkey's base64url credential id; it is empty for the passphrase wrap, which
// needs none because there is only ever one. All five recovery wraps hold the
// same UK, so without a discriminator a swapped row would go undetected.
func UserKeyWrapAad(userID string, kind WrapKind, discriminator string) (string, error) {
	if err := assertUUID(userID, "userId"); err != nil {
		return "", err
	}

	head := AADPrefixV2 + ".uk-wrap|" + userID + "|" + string(kind)

	switch kind {
	case WrapPassphrase:
		if discriminator != "" {
			return "", errors.New("the passphrase wrap AAD carries no discriminator")
		}
		return head, nil
	case WrapRecovery:
		if err := assertComponent(discriminator, "lookupHashHex"); err != nil {
			return "", err
		}
	case WrapPRF:
		if err := assertComponent(discriminator, "credentialIdB64Url"); err != nil {
			return "", err
		}
	default:
		return "", errors.New(`AAD component "wrapKind" must be passphrase, recovery, or prf`)
	}
	return head + "|" + discriminator, nil
}

// PrivateKeyEncAad binds a user's encrypted X25519 private key to its owner.
func PrivateKeyEncAad(userID string) (string, error) {
	if err := assertUUID(userID, "userId"); err != nil {
		return "", err
	}
	return AADPrefixV2 + ".privkey-enc|" + userID, nil
}

// PrivateKeySignAad binds a user's encrypted Ed25519 private key to its owner.
func PrivateKeySignAad(userID string) (string, error) {
	if err := assertUUID(userID, "userId"); err != nil {
		return "", err
	}
	return AADPrefixV2 + ".privkey-sign|" + userID, nil
}
