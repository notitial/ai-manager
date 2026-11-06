#!/bin/bash
# Links the callboard panels extension into VS Code from this checkout. Dry run unless --apply.
#   link-extension.sh [--apply]            make ~/.vscode/extensions/notitial.callboard-panels-<version> a link to
#                                          this checkout's extension/ folder
#   link-extension.sh --remove [--apply]   remove every notitial.callboard-panels-* link into this checkout
# The version comes from extension/package.json. A link into this checkout under another version's name (left by a
# version bump) is removed. A real folder, or a link to anywhere else, under any notitial.callboard-panels-* name is
# never touched: the script stops and names it, so an old copy can't shadow the link. Run it as your user: it refuses
# root, never uses sudo and changes no setting. Reload the VS Code windows afterwards.
# --ext-dir is for the tests. Tests: bash tools/callboard/test-link-extension.sh
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
ID=notitial.callboard-panels
APPLY=0 REMOVE=0 EXT_DIR="" EXT_SET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --remove) REMOVE=1 ;;
    --ext-dir) [ $# -ge 2 ] || { echo "--ext-dir needs a folder" >&2; exit 2; }; EXT_DIR="$2"; EXT_SET=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
die() { echo "link-extension: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
act() { if [ "$APPLY" = 1 ]; then "$@"; else say "DRY: $*"; fi; }

[ "$(/usr/bin/id -u)" != 0 ] || die "run it as your user, not as root"
if [ "$EXT_SET" = 0 ]; then
  case "${HOME:-}" in /*) ;; *) die "HOME must be an absolute path" ;; esac
  EXT_DIR="$HOME/.vscode/extensions"
fi
case "$EXT_DIR" in /*) ;; *) echo "--ext-dir must be absolute" >&2; exit 2 ;; esac
[ ! -L "$EXT_DIR" ] || die "$EXT_DIR is a link; refusing to work through it"

HERE="$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")" && pwd -P)"
SRC="$HERE/extension"
MANIFEST="$SRC/package.json"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die "$MANIFEST is missing or not a regular file"
field() { /usr/bin/plutil -extract "$1" raw -o - "$MANIFEST" 2>/dev/null || true; }
[ "$(field publisher)" = notitial ] || die "extension/package.json publisher must be notitial"
[ "$(field name)" = callboard-panels ] || die "extension/package.json name must be callboard-panels"
VER="$(field version)"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "extension/package.json version must look like 1.2.3 (got '$VER')"
TARGET="$EXT_DIR/$ID-$VER"

# ours <path>: a symlink whose target is exactly this checkout's extension folder (the form this script writes).
ours() { [ -L "$1" ] && [ "$(/usr/bin/readlink "$1")" = "$SRC" ]; }

# Case-insensitive, as APFS and VS Code's extension ids are: an old copy in another letter case could shadow the link.
shopt -s nullglob nocaseglob
entries=("$EXT_DIR/$ID"-*)
shopt -u nullglob nocaseglob

if [ "$REMOVE" = 1 ]; then
  n=0
  for e in ${entries[@]+"${entries[@]}"}; do
    if ours "$e"; then act /bin/rm -- "$e"; n=$((n + 1)); else say "left alone (not a link into this checkout): $e"; fi
  done
  if [ "$APPLY" = 1 ]; then
    say "removed $n link(s) into $SRC"
  else
    say "would remove $n link(s) into $SRC"
    if [ "$n" -gt 0 ]; then say "dry run only; add --apply to remove"; fi
  fi
  exit 0
fi

# Check everything before changing anything, so a refusal leaves the folder as it was.
stale=()
already=0
for e in ${entries[@]+"${entries[@]}"}; do
  if ours "$e"; then
    if [ "$e" = "$TARGET" ]; then already=1; else stale+=("$e"); fi
  else
    die "$e is not a link into this checkout (an old copy, or a link elsewhere); remove it yourself, then run this again"
  fi
done
[ -d "$EXT_DIR" ] || act /bin/mkdir -p -- "$EXT_DIR"
for e in ${stale[@]+"${stale[@]}"}; do act /bin/rm -- "$e"; done
if [ "$already" = 1 ]; then
  say "already linked: $TARGET -> $SRC"
else
  act /bin/ln -s -n -- "$SRC" "$TARGET"
  if [ "$APPLY" = 1 ]; then
    ours "$TARGET" || die "the link at $TARGET did not come out as expected"
    say "linked: $TARGET -> $SRC"
  fi
fi
if [ "$already" = 1 ] && [ "${#stale[@]}" = 0 ]; then
  :
elif [ "$APPLY" = 1 ]; then
  say "reload the open VS Code windows to load version $VER"
else
  say "dry run only; add --apply to link"
fi
