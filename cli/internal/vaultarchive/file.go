package vaultarchive

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
)

// zip64LocatorSignature precedes the end-of-central-directory record in a ZIP64
// archive, which spec §14.1 refuses.
const zip64LocatorSignature = 0x07064b50

// ReadFile takes an archive file apart and validates its document. No
// credential, no key, no plaintext — so a hostile or damaged file is refused
// before anybody types a passphrase.
//
// Accepts the ZIP the server emails and a bare archive.json somebody extracted
// from it (§14.1). Liberal about the container — deflated entries and extra
// entries from a desktop tool's re-zip are fine — and strict about what matters:
// exactly one archive.json, not encrypted, not ZIP64, a size declared within
// bounds before inflating, and a CRC and size that match after.
func ReadFile(data []byte) (*Document, error) {
	if len(data) > 0 && data[0] == '{' {
		if len(data) > MaxDocumentBytes {
			return nil, formatErr("archive.json is larger than any archive this reader accepts")
		}
		return Parse(data)
	}
	if !bytes.HasPrefix(data, []byte("PK\x03\x04")) {
		return nil, formatErr("this is not a vault archive: expected a .zip or an archive.json")
	}

	document, err := readZipEntry(data, "archive.json")
	if err != nil {
		return nil, err
	}
	return Parse(document)
}

func readZipEntry(data []byte, name string) ([]byte, error) {
	if isZip64(data) {
		return nil, formatErr("ZIP64 archives are not supported")
	}

	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, formatErr("the ZIP archive is damaged")
	}

	var match *zip.File
	for _, file := range reader.File {
		if file.Name != name {
			continue
		}
		if match != nil {
			return nil, formatErr("the ZIP archive has more than one %s", name)
		}
		match = file
	}
	if match == nil {
		return nil, formatErr("the ZIP archive has no %s", name)
	}

	if match.Flags&0x1 != 0 {
		return nil, formatErr("%s is encrypted inside the ZIP, which is not supported", name)
	}
	if match.Method != zip.Store && match.Method != zip.Deflate {
		return nil, formatErr("%s uses a ZIP compression method that is not supported", name)
	}
	// The deprecated 32-bit fields are the ZIP64 tell: archive/zip sets them to
	// the maximum when a ZIP64 extra field carries the real sizes.
	if match.CompressedSize == ^uint32(0) || match.UncompressedSize == ^uint32(0) {
		return nil, formatErr("ZIP64 archives are not supported")
	}
	if match.UncompressedSize64 > MaxDocumentBytes {
		return nil, formatErr("%s is larger than any archive this reader accepts", name)
	}

	opened, err := match.Open()
	if err != nil {
		return nil, formatErr("%s could not be read", name)
	}
	defer opened.Close()

	// Read to EOF — archive/zip verifies the size and CRC only when the stream
	// ends — but never more than one byte past the declared size, so an entry
	// that inflates far beyond it is refused at that point, not after it has
	// filled memory.
	contents, err := io.ReadAll(io.LimitReader(opened, int64(match.UncompressedSize64)+1))
	if err != nil {
		if errors.Is(err, zip.ErrChecksum) {
			return nil, formatErr("%s is damaged: its checksum does not match", name)
		}
		return nil, formatErr("%s does not match what the ZIP directory states", name)
	}
	if uint64(len(contents)) != match.UncompressedSize64 {
		return nil, formatErr("%s does not have the size the ZIP directory states", name)
	}
	return contents, nil
}

// isZip64 reports whether the file carries a ZIP64 end-of-central-directory
// locator immediately before its end record. archive/zip accepts ZIP64
// transparently; this format does not.
func isZip64(data []byte) bool {
	const endRecord = 22
	for offset := len(data) - endRecord; offset >= 0 && offset >= len(data)-endRecord-0xffff; offset-- {
		if binary.LittleEndian.Uint32(data[offset:]) != 0x06054b50 {
			continue
		}
		if offset+endRecord+int(binary.LittleEndian.Uint16(data[offset+20:])) != len(data) {
			continue
		}
		return offset >= 20 && binary.LittleEndian.Uint32(data[offset-20:]) == zip64LocatorSignature
	}
	return false
}
