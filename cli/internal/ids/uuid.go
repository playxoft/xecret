// Package ids mints the identifiers this client is responsible for.
//
// There is exactly one: a secret's id, under end-to-end encryption. The id is a
// component of the ciphertext's AAD (spec §4.2), so it has to exist *before* the
// value is encrypted — which is before any request exists for a server to answer
// with one. A server-assigned id would arrive after the only moment it could
// have been bound.
//
// UUIDv7 rather than v4, matching `packages/core/src/ids/uuid-v7.ts`: the
// timestamp prefix keeps insertions at the right-hand edge of the index instead
// of scattering them, which is a property the database wants and a random id
// cannot give it.
package ids

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"time"
)

// UUIDv7 returns a canonical lowercase 36-character UUID.
//
// Layout per RFC 9562: 48 bits of Unix milliseconds, version 7, 12 random bits,
// variant 0b10, and 62 more random bits.
func UUIDv7() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[6:]); err != nil {
		return "", fmt.Errorf("generating an id: %w", err)
	}

	milliseconds := uint64(time.Now().UnixMilli())
	var stamp [8]byte
	binary.BigEndian.PutUint64(stamp[:], milliseconds)
	copy(raw[0:6], stamp[2:8])

	raw[6] = (raw[6] & 0x0f) | 0x70 // version 7
	raw[8] = (raw[8] & 0x3f) | 0x80 // variant 10

	encoded := hex.EncodeToString(raw[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" +
		encoded[16:20] + "-" + encoded[20:32], nil
}
