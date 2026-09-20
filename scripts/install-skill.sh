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
# current document and leaves the pointers alone if they are already there,
# so this is safe in a loop, in a bootstrap script, or after an upgrade.
#
# Environment overrides:
#   XECRET_SKILL_URL  where to fetch the document from (default: the hosted
#                     one). Point it at your own deployment when self-hosting:
#                     XECRET_SKILL_URL=https://secrets.example.com/skill.md
#   XECRET_SKILL_DIR  which repository to install into (default: the current
#                     directory)
#
# Flags:
#   --print           write the document to stdout and exit, installing
#                     nothing. For piping into an agent that reads stdin.

set -eu

DEFAULT_URL="https://xecret.playxoft.com/skill.md"
url="${XECRET_SKILL_URL:-$DEFAULT_URL}"
root="${XECRET_SKILL_DIR:-.}"
print_only=0

for arg in "$@"; do
  case "$arg" in
    --print) print_only=1 ;;
    -h|--help)
      # Not read out of $0: under `curl | sh` this script has no file to read.
      printf '%s\n' \
        'usage: install-skill.sh [--print]' \
        '' \
        'Installs the xecret agent skill into the current repository.' \
        '  --print            write the document to stdout, install nothing' \
        '  XECRET_SKILL_URL   where to fetch it from (default: the hosted one)' \
        '  XECRET_SKILL_DIR   which repository to install into (default: .)'
      exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*" >&2; }
fail() { say "skill install failed: $*"; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
document="$workdir/SKILL.md"

curl -fsSL -o "$document" "$url" || fail "could not download $url"

# A proxy that answers every request with a login page is the failure this
# catches: the bytes arrived, and they are not the skill. Checking the
# frontmatter costs nothing and turns a silently wrong install into an error.
head -n 5 "$document" | grep -q '^name: xecret$' \
  || fail "$url did not return the xecret skill"

if [ "$print_only" -eq 1 ]; then
  cat "$document"
  exit 0
fi

[ -d "$root" ] || fail "$root is not a directory"

install_copy() {
  # $1 — directory, relative to the repository root, to hold SKILL.md
  target="$root/$1"
  mkdir -p "$target"
  cp "$document" "$target/SKILL.md"
  say "  wrote $1/SKILL.md"
}

POINTER_MARKER='<!-- xecret-skill -->'

write_pointer() {
  # $1 — file, relative to the repository root. Appended to, never rewritten:
  # these files are the user's own instructions to their agents, and this has
  # one paragraph to add to them.
  target="$root/$1"
  if [ -f "$target" ] && grep -qF "$POINTER_MARKER" "$target"; then
    say "  $1 already points at the skill"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  [ -s "$target" ] && printf '\n' >>"$target"
  cat >>"$target" <<POINTER
$POINTER_MARKER
## Secrets: this repository uses xecret

Read \`.agents/skills/xecret/SKILL.md\` before running the app, before adding or
reading a secret, and before touching a \`.env\` file. It is the reference for
the \`xecret\` CLI, service tokens and the HTTP API.

Two rules that hold even without reading it: run the app with
\`xecret run -- <command>\` rather than creating a \`.env\`, and never print a
secret value into a transcript, a commit message or a summary.
POINTER
  say "  added a pointer to $1"
}

say "installing the xecret skill into $root"

install_copy ".agents/skills/xecret"
install_copy ".claude/skills/xecret"
write_pointer "AGENTS.md"

# The two agents that read neither AGENTS.md nor a skills directory. Written
# only where the convention is already established in this repository.
[ -f "$root/GEMINI.md" ] && write_pointer "GEMINI.md"
[ -f "$root/.github/copilot-instructions.md" ] && write_pointer ".github/copilot-instructions.md"

say ""
say "Done. Start a new agent session so it picks the skill up."
say ""
say "Chat agents — ChatGPT, Gemini, Claude — take the same document by URL:"
say "  Read $url and follow it whenever I ask about xecret or secrets."
