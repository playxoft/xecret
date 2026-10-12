package vaultarchive

import (
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"sort"

	"github.com/playxoft/xecret/cli/internal/e2ee"
)

// CredentialKind is which secret the person holds.
type CredentialKind string

const (
	// CredentialPassphrase is the vault's master passphrase.
	CredentialPassphrase CredentialKind = "passphrase"
	// CredentialRecoveryCode is one of the vault's unused recovery codes.
	CredentialRecoveryCode CredentialKind = "recovery-code"
)

// Credential opens an archive. Secret is the passphrase or the code as typed.
type Credential struct {
	Kind   CredentialKind
	Secret string
}

// Outcome is what became of one value (§14.5 step 4).
type Outcome string

const (
	// OutcomeOK means the value opened.
	OutcomeOK Outcome = "ok"
	// OutcomeNoKey means the account never held the key version it was written under.
	OutcomeNoKey Outcome = "no-key"
	// OutcomeDamaged means it should have opened and did not.
	OutcomeDamaged Outcome = "damaged"
)

// OpenedSecret is one secret after opening.
type OpenedSecret struct {
	SecretID  string
	Name      string
	ValueType string
	Version   int
	UpdatedAt string
	Outcome   Outcome
	// Value is the plaintext when Outcome is OutcomeOK.
	Value string
	// Note is the note when HasNote; NoteUnavailable when one exists and no key opened it.
	Note            string
	HasNote         bool
	NoteUnavailable bool
}

// OpenedEnvironment is one environment after opening.
type OpenedEnvironment struct {
	OrgID, OrgName, OrgSlug                         string
	ProjectID, ProjectName, ProjectSlug             string
	EnvironmentID, EnvironmentName, EnvironmentSlug string
	IsProduction                                    bool
	DamagedKeyVersions                              []int
	Secrets                                         []OpenedSecret
}

// Opened is a whole archive part after opening.
type Opened struct {
	ArchiveID    string
	Part, Parts  int
	CreatedAt    string
	UserID       string
	Environments []OpenedEnvironment
}

// Damaged reports whether any value in the archive came out damaged — the
// condition a command-line reader exits non-zero on (§14.5).
func (o *Opened) Damaged() bool {
	for _, environment := range o.Environments {
		for _, secret := range environment.Secrets {
			if secret.Outcome == OutcomeDamaged {
				return true
			}
		}
	}
	return false
}

// Open opens every value in a validated archive with one credential (§14.5).
//
// A credential that does not open the vault is e2ee.ErrDecrypt, uniform and
// detail-free: a wrong passphrase, a wrong code, and a code that matches no
// wrap in this file are one outcome. A mistyped code is e2ee.ErrRecoveryFormat
// or e2ee.ErrRecoveryChecksum from the parser — a typo, not a wrong code. An
// archive whose private key does not belong to its public key is ErrFormat.
//
// After the User Key opens nothing stops at the first failure: every value is
// reported ok, no-key or damaged. Every key is zeroised before Open returns.
func Open(doc *Document, credential Credential) (*Opened, error) {
	userKey, err := openUserKey(doc, credential)
	if err != nil {
		return nil, err
	}
	encPrivateKey, err := e2ee.UnwrapPrivateKey(userKey, doc.Vault.EncPrivateKeyBlob, doc.UserID, e2ee.PurposeEncryption)
	e2ee.ZeroizeKey(userKey)
	if err != nil {
		return nil, err
	}
	defer e2ee.ZeroizeKey(encPrivateKey)

	// §14.5 step 2: a private key that does not belong to the public key every
	// grant was sealed to would report every grant as damaged, for a reason that
	// has nothing to do with them.
	derived, err := e2ee.EncryptionPublicKey(encPrivateKey)
	if err != nil {
		return nil, err
	}
	stated, err := strictBase64URL.DecodeString(doc.Vault.EncPublicKeyB64URL)
	if err != nil || subtle.ConstantTimeCompare(derived, stated) != 1 {
		return nil, formatErr("this archive is inconsistent: its private key does not match its public key")
	}

	opened := &Opened{
		ArchiveID: doc.ArchiveID,
		Part:      doc.Part,
		Parts:     doc.Parts,
		CreatedAt: doc.CreatedAt,
		UserID:    doc.UserID,
	}
	for _, environment := range doc.Environments {
		result, err := openEnvironment(environment, doc.UserID, encPrivateKey)
		if err != nil {
			return nil, err
		}
		opened.Environments = append(opened.Environments, result)
	}
	return opened, nil
}

func openUserKey(doc *Document, credential Credential) ([]byte, error) {
	switch credential.Kind {
	case CredentialPassphrase:
		salt, err := strictBase64URL.DecodeString(doc.Vault.KdfSaltB64URL)
		if err != nil {
			return nil, formatErr("vault.kdfSaltB64Url must be canonical unpadded base64url")
		}
		stretched, err := e2ee.DeriveStretchedKey(credential.Secret, salt, doc.Vault.KdfParams)
		if err != nil {
			return nil, formatErr("vault.kdfParams is not acceptable: %v", err)
		}
		wrapKey, err := e2ee.DerivePassphraseWrapKey(stretched)
		e2ee.ZeroizeKey(stretched)
		if err != nil {
			return nil, err
		}
		defer e2ee.ZeroizeKey(wrapKey)
		return e2ee.UnwrapUserKey(wrapKey, doc.Vault.PassphraseWrapBlob,
			e2ee.WrapContext{UserID: doc.UserID, Kind: e2ee.WrapPassphrase})

	case CredentialRecoveryCode:
		// A typo is ErrRecoveryFormat or ErrRecoveryChecksum and escapes as one.
		code, err := e2ee.ParseRecoveryCode(credential.Secret)
		if err != nil {
			return nil, err
		}
		defer e2ee.ZeroizeKey(code.CodeBytes)

		lookupHash, err := e2ee.RecoveryLookupHash(code.CodeBytes)
		if err != nil {
			return nil, err
		}
		lookupHex := hex.EncodeToString(lookupHash)

		for _, wrap := range doc.Vault.RecoveryWraps {
			if wrap.LookupHashHex != lookupHex {
				continue
			}
			recoveryKey, err := e2ee.DeriveRecoveryKey(code.CodeBytes)
			if err != nil {
				return nil, err
			}
			defer e2ee.ZeroizeKey(recoveryKey)
			return e2ee.UnwrapUserKey(recoveryKey, wrap.WrapBlob, e2ee.RecoveryWrapContext(doc.UserID, lookupHash))
		}
		// No matching wrap is the same answer as a wrap that does not open.
		return nil, e2ee.ErrDecrypt
	}
	return nil, errors.New("unknown credential kind")
}

type openedKey struct {
	version int
	edk     []byte
}

func openEnvironment(environment Environment, userID string, encPrivateKey []byte) (OpenedEnvironment, error) {
	result := OpenedEnvironment{
		OrgID: environment.OrgID, OrgName: environment.OrgName, OrgSlug: environment.OrgSlug,
		ProjectID: environment.ProjectID, ProjectName: environment.ProjectName, ProjectSlug: environment.ProjectSlug,
		EnvironmentID: environment.EnvironmentID, EnvironmentName: environment.EnvironmentName,
		EnvironmentSlug: environment.EnvironmentSlug, IsProduction: environment.IsProduction,
		DamagedKeyVersions: []int{},
		Secrets:            []OpenedSecret{},
	}

	opened := map[string]openedKey{}
	defer func() {
		for _, key := range opened {
			e2ee.ZeroizeKey(key.edk)
		}
	}()

	held := map[string]bool{}
	for _, key := range environment.Keys {
		held[key.EnvDataKeyID] = true
		keys, err := e2ee.OpenGrant(e2ee.GrantRecipient{
			EnvironmentID: environment.EnvironmentID,
			EDKVersion:    key.EDKVersion,
			RecipientKind: e2ee.RecipientMember,
			RecipientID:   userID,
		}, encPrivateKey, e2ee.SealedGrant{EDKSealed: key.EDKSealedBlob, EHKSealed: key.EHKSealedBlob})
		if err != nil {
			if !errors.Is(err, e2ee.ErrDecrypt) {
				return OpenedEnvironment{}, err
			}
			result.DamagedKeyVersions = append(result.DamagedKeyVersions, key.EDKVersion)
			continue
		}
		// The EHK keys valueHmac, which only a writer needs.
		e2ee.ZeroizeKey(keys.EHK)
		opened[key.EnvDataKeyID] = openedKey{version: key.EDKVersion, edk: keys.EDK}
	}

	// Highest version first: the note was most likely written under the newest key.
	byVersion := make([]openedKey, 0, len(opened))
	for _, key := range opened {
		byVersion = append(byVersion, key)
	}
	sort.Slice(byVersion, func(i, j int) bool { return byVersion[i].version > byVersion[j].version })

	for _, secret := range environment.Secrets {
		out := OpenedSecret{
			SecretID: secret.SecretID, Name: secret.Name, ValueType: secret.ValueType,
			Version: secret.Version, UpdatedAt: secret.UpdatedAt,
		}

		key, isOpen := opened[secret.EnvDataKeyID]
		switch {
		case !held[secret.EnvDataKeyID]:
			out.Outcome = OutcomeNoKey
		case !isOpen:
			out.Outcome = OutcomeDamaged
		default:
			value, err := e2ee.DecryptSecret(key.edk, e2ee.SecretContext{
				Field: e2ee.FieldValue, OrgID: environment.OrgID, EnvironmentID: environment.EnvironmentID,
				SecretID: secret.SecretID, Version: secret.Version,
			}, secret.ValueBlob)
			if err != nil {
				// A tag that did not verify, or plaintext that is not UTF-8.
				out.Outcome = OutcomeDamaged
			} else {
				out.Outcome, out.Value = OutcomeOK, value
			}
		}

		if secret.HasNote {
			for _, candidate := range byVersion {
				note, err := e2ee.DecryptSecret(candidate.edk, e2ee.SecretContext{
					Field: e2ee.FieldNote, OrgID: environment.OrgID, EnvironmentID: environment.EnvironmentID,
					SecretID: secret.SecretID,
				}, secret.NoteBlob)
				if err == nil {
					out.Note, out.HasNote = note, true
					break
				}
			}
			out.NoteUnavailable = !out.HasNote
		}

		result.Secrets = append(result.Secrets, out)
	}
	return result, nil
}
