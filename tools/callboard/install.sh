#!/bin/bash
# callboard installer. Dry run unless --apply. Never edits ~/.claude or any VS Code setting.
#   install.sh --terminal|--vscode|--all --ref <40-char commit> --sums-sha <sha256 of SHA256SUMS>
#              [--lanes FILE] [--apply]
# What it installs comes from the pinned commit's object store, never from the working tree:
#   1. `git archive` of --ref (replace objects off) is unpacked into a root-owned 0700 staging directory;
#   2. the staged SHA256SUMS must hash to --sums-sha (the value you took from the review);
#   3. every sums line must be a plain relative path under mod/, extension/ or send/;
#   4. every staged file must match the sums; only then is anything copied;
#   5. after the root-owned copy every installed file is checked against the sums again.
# --prefix and --no-sudo exist for the tests; with sudo the prefix is fixed and its parents must be root-owned.
set -euo pipefail
# The caller's PATH is kept for one thing only: finding node for the advisory --lanes check, run as the user.
ORIG_PATH="${PATH:-}"
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
GIT=/usr/bin/git
DEFAULT_PREFIX=/usr/local/libexec/callboard
PREFIX="$DEFAULT_PREFIX"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT_CMD=(/usr/bin/sudo)
NO_SUDO=0 WANT_TERM=0 WANT_CODE=0 APPLY=0 REF="" SUMS_SHA="" LANES="" LANES_SHA="" UT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --terminal) WANT_TERM=1 ;;
    --vscode) WANT_CODE=1 ;;
    --all) WANT_TERM=1; WANT_CODE=1 ;;
    --ref) REF="${2:-}"; shift ;;
    --sums-sha) SUMS_SHA="${2:-}"; shift ;;
    --prefix) PREFIX="${2:-}"; shift ;;
    --lanes) LANES="${2:-}"; shift ;;
    --lanes-sha) LANES_SHA="${2:-}"; shift ;;
    --apply) APPLY=1 ;;
    --no-sudo) ROOT_CMD=(); NO_SUDO=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
die() { echo "install: $*" >&2; exit 1; }
# Run as your user: the script calls sudo itself for the root-owned steps, and the --lanes check runs node from your PATH as you.
[ "$(/usr/bin/id -u)" != 0 ] || die "run install.sh as your user, not as root: it calls sudo itself"
[ $((WANT_TERM + WANT_CODE)) -gt 0 ] || { echo "choose --terminal, --vscode or --all" >&2; exit 2; }
[[ "$REF" =~ ^[0-9a-f]{40}$ ]] || { echo "--ref must be a full 40-character commit hash" >&2; exit 2; }
[[ "$SUMS_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "--sums-sha must be the 64-hex SHA-256 of SHA256SUMS from the review" >&2; exit 2; }
case "$PREFIX" in /*) ;; *) echo "--prefix must be absolute" >&2; exit 2 ;; esac
if [ -n "$LANES" ] && ! [[ "$LANES_SHA" =~ ^[0-9a-f]{64}$ ]]; then echo "--lanes needs --lanes-sha <sha256 of the file you reviewed>" >&2; exit 2; fi
if [ "$NO_SUDO" = 1 ] && [ "$PREFIX" = "$DEFAULT_PREFIX" ]; then echo "--no-sudo is for tests and needs a different --prefix" >&2; exit 2; fi
if [ "$NO_SUDO" = 0 ] && [ "$PREFIX" != "$DEFAULT_PREFIX" ]; then echo "--prefix needs --no-sudo (tests only): the mod reads $DEFAULT_PREFIX/lanes.json" >&2; exit 2; fi

# RR runs as root when applying with sudo; otherwise as the user (dry run and tests).
RR=()
if [ "$APPLY" = 1 ] && [ "$NO_SUDO" = 0 ]; then RR=("${ROOT_CMD[@]}"); fi
OWN=(-o root -g wheel)
if [ "$NO_SUDO" = 1 ]; then OWN=(); fi
say() { printf '%s\n' "$*"; }
rr() { ${RR[@]+"${RR[@]}"} "$@"; }
act() { if [ "$APPLY" = 1 ]; then rr "$@"; else say "DRY: $*"; fi; }

TOP="$($GIT -C "$HERE" rev-parse --show-toplevel)"
rel="$($GIT -C "$HERE" rev-parse --show-prefix)"
rel="${rel%/}"
tree="$REF"
if [ -n "$rel" ]; then tree="$REF:$rel"; fi
$GIT -C "$HERE" --no-replace-objects cat-file -e "$REF^{commit}" 2>/dev/null || die "commit $REF is not in this repository"

if [ "$APPLY" = 1 ] && [ "$NO_SUDO" = 0 ]; then
  STAGE="$(rr /usr/bin/mktemp -d /private/tmp/callboard.XXXXXXXX)"
  read -r su sm < <(rr /usr/bin/stat -f '%u %Lp' "$STAGE")
  [ "$su $sm" = "0 700" ] || die "staging directory is not root-owned 0700"
else
  STAGE="$(/usr/bin/mktemp -d)"
fi
cleanup() { rr /bin/rm -rf "$STAGE" 2>/dev/null || true; if [ -n "$UT" ]; then /bin/rm -rf "$UT" 2>/dev/null || true; fi; }
trap cleanup EXIT
$GIT -C "$TOP" --no-replace-objects archive "$tree" | rr /usr/bin/tar -x -o -C "$STAGE"
[ -z "$(rr /usr/bin/find "$STAGE" ! -type f ! -type d)" ] || die "staged tree holds something other than files and directories"
self="$(/usr/bin/shasum -a 256 "$0" | /usr/bin/cut -d' ' -f1)"
say "this installer script: sha256 $self (compare it with the value in the review before --apply)"

SUMS="$(rr /bin/cat "$STAGE/SHA256SUMS")"
got="$(printf '%s\n' "$SUMS" | /usr/bin/shasum -a 256 | /usr/bin/cut -d' ' -f1)"
[ "$got" = "$SUMS_SHA" ] || die "SHA256SUMS hash $got does not match --sums-sha"
FILES=()
while read -r h f; do
  [[ "$h" =~ ^[0-9a-f]{64}$ ]] || die "bad hash in SHA256SUMS"
  [[ "$f" =~ ^(mod|extension|send)/[A-Za-z0-9._/-]+$ ]] || die "bad path in SHA256SUMS: $f"
  case "/$f/" in */../*|*/./*|*//*) die "bad path in SHA256SUMS: $f" ;; esac
  FILES+=("$f")
done <<< "$SUMS"
[ "${#FILES[@]}" -gt 0 ] || die "SHA256SUMS is empty"
check_against() {
  local d="$1" line bad=0
  while read -r h f; do
    [ -n "$f" ] || continue
    if [ "$d" = "$PREFIX" ]; then case "$f" in mod/*) ;; *) continue ;; esac; fi
    line="$(rr /usr/bin/shasum -a 256 "$d/$f" | /usr/bin/cut -d' ' -f1)" || { bad=1; continue; }
    [ "$line" = "$h" ] || { echo "checksum differs: $d/$f" >&2; bad=1; }
  done <<< "$SUMS"
  [ "$bad" = 0 ]
}
check_against "$STAGE" || die "staged files differ from SHA256SUMS"
say "verified: commit $REF, SHA256SUMS $SUMS_SHA, staged files"

# --lanes is checked by the mod's own parser, before anything is installed: the mod rejects a bad file whole, and every lane with it.
# node runs as the user from the caller's PATH, on a hash-checked copy of core.ts; the check is advisory (the mod parses the root copy again).
if [ -n "$LANES" ]; then
  [ -f "$LANES" ] || die "--lanes file not found"
  rr /usr/bin/install -m 0600 "$LANES" "$STAGE/lanes.json"
  lgot="$(rr /usr/bin/shasum -a 256 "$STAGE/lanes.json" | /usr/bin/cut -d' ' -f1)"
  [ "$lgot" = "$LANES_SHA" ] || die "lanes file hash $lgot does not match --lanes-sha"
  NODE="$(PATH="$ORIG_PATH" command -v node 2>/dev/null || true)"
  NEEDS_NODE="--lanes needs node 22.18 or later on PATH to check the file the way the mod does"
  { [[ "$NODE" == /* ]] && [ -x "$NODE" ]; } || die "$NEEDS_NODE"
  UT="$(/usr/bin/mktemp -d)"
  rr /bin/cat "$STAGE/mod/hooks/core.ts" > "$UT/core.ts"
  want="$(printf '%s\n' "$SUMS" | /usr/bin/awk '$2 == "mod/hooks/core.ts" { print $1 }')"
  [ -n "$want" ] || die "SHA256SUMS has no mod/hooks/core.ts line"
  [ "$(/usr/bin/shasum -a 256 "$UT/core.ts" | /usr/bin/cut -d' ' -f1)" = "$want" ] || die "the copy of core.ts differs from SHA256SUMS"
  verdict="$(rr /bin/cat "$STAGE/lanes.json" | /usr/bin/env -u NODE_OPTIONS -u NODE_PATH "$NODE" --input-type=module -e '
import { pathToFileURL } from "node:url"
const { parseLanes } = await import(pathToFileURL(process.argv[1]).href)
let text = ""
for await (const chunk of process.stdin) text += chunk
const r = parseLanes(text)
process.stdout.write(r.ok ? "ok" : r.reason)
' "$UT/core.ts" 2>/dev/null || true)"
  [ -n "$verdict" ] || die "$NEEDS_NODE"
  [[ "$verdict" =~ ^[a-z-]{1,40}$ ]] || die "--lanes check gave unexpected output"
  [ "$verdict" = ok ] || die "--lanes rejected by the mod's own check: $verdict"
fi

if [ "$NO_SUDO" = 0 ]; then
  d="$PREFIX"
  while [ "$d" != "/" ]; do
    d="$(/usr/bin/dirname "$d")"
    [ -d "$d" ] || continue
    [ ! -L "$d" ] || die "parent is a symlink: $d"
    read -r u m < <(/usr/bin/stat -f '%u %Lp' "$d")
    if [ "$u" != 0 ] || [ $((8#$m & 8#022)) != 0 ]; then die "parent not root-owned or writable by others: $d"; fi
  done
fi

act /usr/bin/install -d ${OWN[@]+"${OWN[@]}"} -m 0755 "$PREFIX"
for f in "${FILES[@]}"; do
  case "$f" in mod/*)
    act /usr/bin/install -d ${OWN[@]+"${OWN[@]}"} -m 0755 "$(/usr/bin/dirname "$PREFIX/$f")"
    act /usr/bin/install ${OWN[@]+"${OWN[@]}"} -m 0644 "$STAGE/$f" "$PREFIX/$f" ;;
  esac
done
if [ -n "$LANES" ]; then
  act /usr/bin/install ${OWN[@]+"${OWN[@]}"} -m 0644 "$STAGE/lanes.json" "$PREFIX/lanes.json"
fi
# The terminal wrapper is installed before the final sweep below, so the sweep checks it too.
if [ "$WANT_TERM" = 1 ]; then
  printf '#!/bin/bash\nexec env CLAUDE_CODE_PLUGIN_DIRS=%q claude "$@"\n' "$PREFIX/mod" | rr /usr/bin/tee "$STAGE/claude-callboard" > /dev/null
  act /usr/bin/install ${OWN[@]+"${OWN[@]}"} -m 0755 "$STAGE/claude-callboard" "$PREFIX/claude-callboard"
fi
if [ "$APPLY" = 1 ]; then
  check_against "$PREFIX" || die "installed files differ from SHA256SUMS"
  if [ "$NO_SUDO" = 0 ]; then [ -z "$(rr /usr/bin/find "$PREFIX" \( -type l -o ! -user root -o -perm -020 -o -perm -002 \))" ] || die "$PREFIX holds a symlink, a non-root file or a writable entry"; fi
  say "verified: installed files"
fi

if [ "$WANT_TERM" = 1 ]; then
  say "terminal: start lanes with $PREFIX/claude-callboard (it runs the 'claude' found on your PATH); no ~/.claude file was changed"
fi
if [ "$WANT_CODE" = 1 ]; then
  EXT="$HOME/.vscode/extensions/local.callboard-panels-0.1.0"
  if [ "$APPLY" = 1 ]; then
    /bin/mkdir -p "$EXT"
    for f in "${FILES[@]}"; do
      case "$f" in extension/*) rr /bin/cat "$STAGE/$f" > "$EXT/${f#extension/}" ;; esac
    done
    while read -r h f; do
      case "$f" in extension/*) [ "$(/usr/bin/shasum -a 256 "$EXT/${f#extension/}" | /usr/bin/cut -d' ' -f1)" = "$h" ] || die "copied extension file differs: $f" ;; esac
    done <<< "$SUMS"
  else
    say "DRY: copy extension/ files to $EXT"
  fi
  say "vscode: reload open VS Code windows to load the panels extension; the mod loads from the CLAUDE_CODE_PLUGIN_DIRS line in ~/.claude/settings.json (README, Default load); no VS Code setting was changed"
fi
say "Live tests showed that settings ask rules do not gate mod-registered tools, so request_compact and lane_retire run without a prompt whatever you add; their own checks are the only gate. lane_terminate asks for itself."
if [ "$APPLY" != 1 ]; then say "dry run only; add --apply to install"; fi
