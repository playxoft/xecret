#!/bin/sh
# xecret agent skill installer — the `curl | sh` path.
#
#   curl -fsSL https://xecret.playxoft.com/skill.sh | sh
#
# Downloads the one canonical skill document — the same file served at
# /skill.md and read by chat agents straight from that URL — and writes it
# where each coding agent looks for it, in the current repository.
#
# What it writes, always:
#   .agents/skills/xecret/SKILL.md   the vendor-neutral location
#   .claude/skills/xecret/SKILL.md   Claude Code and Claude.ai
#   AGENTS.md                        a pointer paragraph, created if absent
#
# And, only where that file already exists, the same pointer in:
#   GEMINI.md · .github/copilot-instructions.md
#
# Cursor, Windsurf, Codex, Antigravity, Jules and Zed all read AGENTS.md, so
# they need nothing of their own here. Gemini CLI and Copilot do not, which is
# why those two are named — and only when the repository already uses them,
# because a file this script created unasked is clutter in somebody's tree.
#
# Nothing else is touched. Re-running replaces the skill copies with the
# current document — they are vendored, so that is the point — and leaves the
# pointer paragraphs alone once they are there, so this is safe in a loop, in a
# bootstrap script, or after an upgrade.
#
# Environment overrides:
#   XECRET_SKILL_URL  where to fetch the document from (default: the hosted
#                     one). Point it at your own deployment when self-hosting:
#                     XECRET_SKILL_URL=https://secrets.example.com/skill.md
#                     Only https: and file: are accepted.
#   XECRET_SKILL_DIR  which directory to install into. Defaults to the root of
#                     the repository you are standing in, not the working
#                     directory — agents look for AGENTS.md at the top of the
#                     tree, and this one-liner gets run from wherever you are.
#
# Flags:
#   --print           write the document to stdout and exit, installing
#                     nothing. For piping into an agent that reads stdin.
#   --no-pointer      install the skill files, touch no instruction file.

set -eu

DEFAULT_URL="https://xecret.playxoft.com/skill.md"
url="${XECRET_SKILL_URL:-$DEFAULT_URL}"
print_only=0
write_pointers=1

# `for arg in "$@"` would abort under `set -u` on bash 3.2 — still /bin/sh on
# macOS — which treats "$@" as unset when there are no positional parameters,
# and `curl | sh` passes none. That was fixed in bash 4.4; this loop works
# everywhere.
while [ $# -gt 0 ]; do
  case "$1" in
    --print) print_only=1 ;;
    --no-pointer) write_pointers=0 ;;
    -h|--help)
      # Not read out of $0: under `curl | sh` this script has no file to read.
      printf '%s\n' \
        'usage: install-skill.sh [--print] [--no-pointer]' \
        '  curl -fsSL https://xecret.playxoft.com/skill.sh | sh' \
        '  curl -fsSL https://xecret.playxoft.com/skill.sh | sh -s -- --print' \
        '' \
        'Installs the xecret agent skill into the current repository.' \
        '  --print            write the document to stdout, install nothing' \
        '  --no-pointer       skip AGENTS.md and the other instruction files' \
        '  XECRET_SKILL_URL   where to fetch it from (default: the hosted one)' \
        '  XECRET_SKILL_DIR   where to install (default: the repository root)'
      exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*" >&2; }
fail() { say "skill install failed: $*"; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"

# Refuse plaintext before fetching. The self-hosting instructions invite this
# variable to be pointed anywhere, and this document becomes standing
# instructions to every agent in the repository — it is not something to accept
# over a connection anybody on the path can rewrite.
case "$url" in
  https://*) proto='=https' ;;
  file://*)  proto='=file' ;;
  *) fail "XECRET_SKILL_URL must be https: or file: — refusing $url" ;;
esac

# Everything that can be checked without the network is checked before it, so a
# typo in XECRET_SKILL_DIR costs no download. install-cli.sh orders itself the
# same way.
if [ "$print_only" -eq 0 ]; then
  root="${XECRET_SKILL_DIR:-}"
  if [ -z "$root" ]; then
    root=$(git rev-parse --show-toplevel 2>/dev/null) || root=""
    [ -n "$root" ] || fail "not inside a repository — cd to one, or set XECRET_SKILL_DIR"
  fi
  [ -d "$root" ] || fail "$root is not a directory"
  [ -w "$root" ] || fail "$root is not writable"
fi

workdir=$(mktemp -d) || fail "could not create a temporary directory"
trap 'rm -rf "$workdir"' EXIT
document="$workdir/SKILL.md"

curl -fsSL --proto "$proto" --tlsv1.2 -o "$document" "$url" \
  || fail "could not download $url"

# Two checks, for two different failures.
#
# The frontmatter catches the wrong document: a captive portal or an SSO wall
# answering every request with a login page. It is not a security control and
# does not pretend to be — see the note at the bottom of this file.
#
# The sentinel catches a truncated one, which is the failure that matters more.
# curl reports most short reads, but a proxy that closes cleanly mid-response
# leaves a plausible half-document — and half a rules file is worse than none,
# because an agent reads the half it got and acts on it with confidence. The
# trailing `[[:space:]]*` tolerates a CRLF rewrite along the way.
head -n 5 "$document" | grep -q '^name: xecret[[:space:]]*$' \
  || fail "$url did not return the xecret skill"

tail -n 3 "$document" | grep -q '^<!-- end of the xecret skill -->[[:space:]]*$' \
  || fail "$url returned a truncated document — retry, and if you serve your own copy, keep its last line"

if [ "$print_only" -eq 1 ]; then
  cat "$document"
  exit 0
fi

install_copy() {
  # $1 — directory, relative to the repository root, to hold SKILL.md
  target="$root/$1"
  mkdir -p "$target" || fail "could not create $1"
  verb="wrote"
  [ -f "$target/SKILL.md" ] && verb="replaced"
  # Removed rather than copied over: cp follows a symlinked destination and
  # would write through to whatever it points at.
  rm -f "$target/SKILL.md"
  cp "$document" "$target/SKILL.md" || fail "could not write $1/SKILL.md"
  say "  $verb $1/SKILL.md"
}

# A fenced pair, not a lone marker. The opening line is what makes the check
# idempotent; the closing one is what lets a later version of this script find
# its own paragraph and revise it, instead of being frozen on this wording for
# ever.
POINTER_BEGIN='<!-- begin xecret-skill -->'
POINTER_END='<!-- end xecret-skill -->'

write_pointer() {
  # $1 — file, relative to the repository root. Appended to, never rewritten:
  # these files are the user's own instructions to their agents, and this has
  # one paragraph to add to them.
  target="$root/$1"
  # Anchored with -x: a repository that merely mentions the marker in prose or
  # inside a fenced block has not been given the pointer.
  if [ -f "$target" ] && grep -qxF "$POINTER_BEGIN" "$target"; then
    say "  $1 already points at the skill"
    return 0
  fi
  if [ -e "$target" ] && [ ! -w "$target" ]; then
    fail "$1 is not writable — fix that and re-run, or paste the pointer in by hand"
  fi
  verb="added a pointer to"
  [ -e "$target" ] || verb="created"
  mkdir -p "$(dirname "$target")" || fail "could not create the directory for $1"
  { [ -s "$target" ] && printf '\n' >>"$target"; } || :
  printf '%s\n' "$POINTER_BEGIN" >>"$target"
  # Quoted delimiter: the body below is markdown about a CLI, so it is exactly
  # the kind of prose that grows backticks and $VARs. Unquoted, the next person
  # to add one would be shipping command substitution into a `curl | sh`.
  cat >>"$target" <<'POINTER'
## Secrets: this repository uses xecret

Read `.agents/skills/xecret/SKILL.md` before running the app, before adding or
reading a secret, and before touching a `.env` file. It is the reference for
the `xecret` CLI, service tokens and the HTTP API.

Two rules that hold even without reading it: run the app with
`xecret run -- <command>` rather than creating a `.env`, and never print a
secret value into a transcript, a commit message or a summary. Where this
repository's own instructions say something different, they win.
POINTER
  printf '%s\n' "$POINTER_END" >>"$target"
  say "  $verb $1"
}

say "installing the xecret skill into $root"

install_copy ".agents/skills/xecret"
install_copy ".claude/skills/xecret"

if [ "$write_pointers" -eq 1 ]; then
  write_pointer "AGENTS.md"
  # The two agents that read neither AGENTS.md nor a skills directory. Written
  # only where the convention is already established in this repository.
  # Spelled `if` rather than `[ … ] && …` so that a repository without them
  # cannot leave this script exiting non-zero.
  if [ -f "$root/GEMINI.md" ]; then
    write_pointer "GEMINI.md"
  fi
  if [ -f "$root/.github/copilot-instructions.md" ]; then
    write_pointer ".github/copilot-instructions.md"
  fi
fi

say ""
say "Done. Start a new agent session so it picks the skill up."
say ""
say "Chat agents — ChatGPT, Gemini, Claude — take the same document by URL:"
say "  Read $url and follow it whenever I ask about xecret or secrets."

# On why there is no checksum here, unlike install-cli.sh:
#
# That script verifies a release archive against a checksums.txt from the same
# release, which is an immutable artifact with a signature behind it. This one
# would be verifying a file served from the deployment against a constant baked
# into a script served from the repository — both live-editable by the same
# party, so anyone able to change one can change the other in the same push. It
# would be a maintenance chore bought with no adversarial value, and it would
# break every self-hosted deployment serving its own copy.
#
# The trust root here is TLS to the deployment you chose, which is why only
# https: is accepted above. The property TLS does not give is completeness,
# which is what the sentinel check covers.
