// Package e2ee is the Go half of xecret's zero-knowledge crypto: the second
// independent implementation of docs/security/e2ee-crypto-spec.md.
//
// It is written against that document, not against the TypeScript in
// packages/core/src/crypto/client. That is the whole point. Two readings of one
// specification, checked against the same bytes, is what turns "the CLI and the
// browser agree" from an aspiration into a test — and the test is
// vectors_test.go, which loads
// packages/core/src/crypto/client/vectors/e2ee-vectors.json and reproduces
// every value in it. A blob written here opens in a browser because that file
// says so, not because both sides were written by the same hand.
//
// What lives here, in the order the hierarchy uses it:
//
//   - Argon2id (kdf.go) turns a master passphrase into the Stretched Key, under
//     parameters that arrive from the server and are therefore validated before
//     a byte is allocated.
//   - HKDF-SHA256 (hkdf.go) branches every key from every other, through a
//     closed registry of info strings. An unregistered string is refused: a typo
//     otherwise derives a perfectly valid key nothing else will ever reproduce.
//   - AES-256-GCM (gcm.go) with the v2 AAD (aad.go) binding each ciphertext to
//     the exact row that holds it.
//   - The sealed box (sealedbox.go) carries an environment's keys to a member, a
//     service token, or an invitation; grant signatures (sign.go) say who put
//     them there.
//   - The xk2 blob format (blob.go) is how all of it is stored, and it rejects
//     everything it does not recognise, loudly.
//
// Two error classes, and the difference is deliberate. [ErrFormat] means "that
// string is not an xk2 blob of the type expected here" — a fact about a string
// the caller already holds, so it says which. [ErrDecrypt] is every failure that
// depends on key material — wrong key, wrong AAD, flipped bit, forged tag — and
// it is uniform and detail-free, because distinguishing them tells an attacker
// which part of their guess was wrong.
//
// Nothing in this package sends anything anywhere. Callers pass key material in
// and get key material out; the rule that the Stretched Key, the User Key, and
// every private key never reach the server is enforced by the packages that do
// the talking.
package e2ee
