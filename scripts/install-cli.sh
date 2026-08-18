#!/bin/sh
# xecret CLI installer — the `curl | sh` path.
#
#   curl -fsSL https://xecret.playxoft.com/install.sh | sh
#
# What it does, in order: detect platform, download the release archive and
# its checksum file from GitHub, VERIFY the checksum before anything is
# unpacked, then install the single binary. It never needs root unless the
# chosen directory does; it does not touch shell profiles; and it downloads
# over TLS from GitHub releases only.
#
# Environment overrides:
#   XECRET_VERSION      install a specific version (default: latest)
#   XECRET_INSTALL_DIR  target directory (default: /usr/local/bin, falling
#                       back to ~/.local/bin when not writable)
#
# For a stronger guarantee than a checksum, verify the cosign signature on
# checksums.txt — documented in the release notes of every version.

set -eu

REPO="playxoft/xecret"
PROJECT="xecret"

say()  { printf '%s\n' "$*" >&2; }
fail() { say "install failed: $*"; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar  >/dev/null 2>&1 || fail "tar is required"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux|darwin) ;;
  *) fail "unsupported operating system: $os (Windows: download the zip from GitHub releases)" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64)  arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) fail "unsupported architecture: $arch" ;;
esac

version="${XECRET_VERSION:-}"
if [ -z "$version" ]; then
  # The releases/latest redirect carries the tag; no API token, no jq.
  version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest" | sed 's|.*/tag/||')
  [ -n "$version" ] || fail "could not determine the latest version"
fi
# Archive names carry the version without the leading v.
bare_version=${version#v}

archive="${PROJECT}_${bare_version}_${os}_${arch}.tar.gz"
base="https://github.com/$REPO/releases/download/$version"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

say "downloading $PROJECT $version for $os/$arch…"
curl -fsSL -o "$workdir/$archive" "$base/$archive" \
  || fail "download failed — does $version have a $os/$arch build?"
curl -fsSL -o "$workdir/checksums.txt" "$base/checksums.txt" \
  || fail "checksums.txt is missing from the release"

# Verify before unpacking. An installer that checks after extraction has
# already run untrusted bytes through tar.
say "verifying checksum…"
(
  cd "$workdir"
  expected=$(grep " ${archive}\$" checksums.txt | awk '{print $1}')
  [ -n "$expected" ] || fail "no checksum recorded for $archive"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$archive" | awk '{print $1}')
  else
    actual=$(shasum -a 256 "$archive" | awk '{print $1}')
  fi
  [ "$expected" = "$actual" ] || fail "checksum mismatch — refusing to install"
)

tar -xzf "$workdir/$archive" -C "$workdir" "$PROJECT"

install_dir="${XECRET_INSTALL_DIR:-/usr/local/bin}"
if [ ! -w "$install_dir" ]; then
  if [ -z "${XECRET_INSTALL_DIR:-}" ]; then
    install_dir="$HOME/.local/bin"
    mkdir -p "$install_dir"
  else
    fail "$install_dir is not writable"
  fi
fi

install -m 0755 "$workdir/$PROJECT" "$install_dir/$PROJECT"
say "installed $install_dir/$PROJECT"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) say "note: $install_dir is not on your PATH — add it to your shell profile" ;;
esac

"$install_dir/$PROJECT" version >&2 || true
say ""
say "next: xecret login"
