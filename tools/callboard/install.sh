#!/bin/bash
# callboard installer. Dry run unless --apply. Never edits ~/.claude or any VS Code setting.
#   install.sh --terminal|--vscode|--all --ref <40-hex commit on main> --sums-sha <sha256 of SHA256SUMS>
#              [--lanes FILE --lanes-sha <sha256>] [--apply]
# What it installs comes from a commit of https://github.com/notitial/ai-manager.git, never from the checkout it sits in:
#   1. main is fetched, as you and before any sudo, into a fresh temporary bare repository; --ref must be a 40-hex
#      commit on main (main's tip or an ancestor of it);
#   2. as you, SHA256SUMS of tools/callboard at --ref is read from that repository and must hash to --sums-sha (from
#      the description of the pull request that last changed tools/callboard); every line must be a plain relative path
#      under mod/, extension/ or send/, and a regular file at --ref;
#   3. a root-owned 0700 staging directory is made (the first sudo); each listed file is streamed from git straight
#      into it and given mode 0644 and owner root:wheel. Root parses nothing you can write: no archive, no
#      intermediate file, no path you chose;
#   4. the staging directory is checked again: still root-owned 0700, only directories and regular files, no special or
#      group/other-writable mode, no hard link, and exactly the listed files;
#   5. every staged file must match the sums; only then is anything copied;
#   6. after the root-owned copy every installed file is checked against the sums again.
# How it fetches. The URL above is a constant: no option, no environment variable and no git config outside the
# temporary repository changes it. main is fetched over HTTPS without credentials (so it fails, and installs nothing,
# while the repository is private); there is no fallback to the local repository: the checkout's object store and git
# config are never read. A dry run fetches too, so it needs network access.
# What it guards. The temporary repository is yours and writable by code running as you during the run, so what root
# installs rests on the --sums-sha pin and the per-file hash checks in the root-owned staging folder. The "on main"
# check and the fixed URL guard an honest mistake (a wrong commit, a stray config), not code running as you.
# Every git call runs under `env -i` (PATH /usr/bin:/bin, HOME the temporary folder, no system or global config, no
# prompts, no replace refs, no lazy fetch) with -c flags that turn off hooks, fsmonitor, credential helpers, askpass,
# auto gc and maintenance, submodule recursion, HTTP redirects and attribute files, and check every fetched object.
# Only the fetch may use a transport (HTTPS); every other git call may use none. Files are read with
# `git cat-file blob`, which applies no filter.
# --prefix and --no-sudo exist for the tests; with sudo the prefix is fixed and its parents must be root-owned.
# Tests: bash tools/callboard/test-install.sh (it runs a copy whose two source lines point at a local fixture).
set -euo pipefail
readonly ORIGIN_URL='https://github.com/notitial/ai-manager.git'
readonly ORIGIN_PROTO='https'
readonly SRC_DIR='tools/callboard'
# The caller's PATH is kept for one thing only: finding node for the advisory --lanes check, run as the user.
ORIG_PATH="${PATH:-}"
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
DEFAULT_PREFIX=/usr/local/libexec/callboard
PREFIX="$DEFAULT_PREFIX"
ROOT_CMD=(/usr/bin/sudo)
NO_SUDO=0 WANT_TERM=0 WANT_CODE=0 APPLY=0 REF="" SUMS_SHA="" LANES="" LANES_SHA="" UT="" WORK="" STAGE=""
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
[[ "$SUMS_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "--sums-sha must be the 64-hex SHA-256 of SHA256SUMS, from the description of the pull request that last changed tools/callboard" >&2; exit 2; }
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

cleanup() {
  if [ -n "$STAGE" ]; then rr /bin/rm -rf "$STAGE" 2>/dev/null || true; fi
  if [ -n "$UT" ]; then /bin/rm -rf "$UT" 2>/dev/null || true; fi
  if [ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ]; then /bin/rm -rf -- "$WORK" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# hgit <git args...>: git with nothing from the caller's environment or any config outside the repository it is
# pointed at, and the settings that could run a program or reroute a fetch turned off (the usage watcher installer's
# flags, plus core.attributesFile=/dev/null). The transport allowed is _proto (a caller's local), else none.
hgit() {
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$WORK/home" LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= \
    SSH_ASKPASS= GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL="${_proto:-none}" \
    /usr/bin/git --no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c gc.auto=0 \
    -c maintenance.auto=false -c credential.helper= -c core.askPass= -c protocol.allow=never \
    -c fetch.recurseSubmodules=false -c transfer.fsckObjects=true -c http.sslVerify=true \
    -c http.followRedirects=false -c init.defaultBranch=main "$@"
}

# fetch_source: fetches main into a fresh temporary bare repository and checks --ref is on main. Every hgit call names
# that repository with --git-dir (no discovery), so no checkout's objects or config are read. Attributes cannot come
# from anywhere you control: HOME is the empty temporary folder, there is no system or global config,
# core.attributesFile is /dev/null and the bare repository is made with no template; and cat-file blob applies none.
fetch_source() {
  local main _proto=none tmp_base="${TMPDIR:-/tmp}"
  case "$tmp_base" in /*) ;; *) die "TMPDIR must be an absolute path (got '$tmp_base')" ;; esac
  WORK="$(/usr/bin/mktemp -d "$tmp_base/callboard-install.XXXXXX")" || die "cannot make a temporary folder in $tmp_base"
  /bin/mkdir -m 0700 "$WORK/home" || die "cannot set up $WORK"
  REPO="$WORK/repo.git"
  hgit --git-dir="$REPO" init -q --bare --template= || die "cannot set up the temporary repository"
  _proto=$ORIGIN_PROTO
  hgit --git-dir="$REPO" fetch -q --no-tags --no-recurse-submodules --no-write-fetch-head "$ORIGIN_URL" \
    '+refs/heads/main:refs/remotes/origin/main' ||
    die "fetching main from $ORIGIN_URL failed: network, proxy or TLS, or the repository is still private (the fetch sends no credentials); nothing was installed"
  _proto=none
  main="$(hgit --git-dir="$REPO" rev-parse --verify -q 'refs/remotes/origin/main^{commit}')" ||
    die "the fetch from $ORIGIN_URL brought no main"
  hgit --git-dir="$REPO" cat-file -e "$REF^{commit}" 2>/dev/null || die "commit $REF is not on main of $ORIGIN_URL"
  hgit --git-dir="$REPO" merge-base --is-ancestor "$REF" "$main" || die "commit $REF is not on main of $ORIGIN_URL"
  say "source: $ORIGIN_URL, commit $REF (on main; main is at $main)"
}
# regular_at <path in the repository>: the path is a regular file (not a link, tree or submodule) at --ref.
regular_at() {
  local entry
  entry="$(hgit --git-dir="$REPO" ls-tree "$REF" -- "$1")" || die "cannot list $1 at $REF"
  case "${entry%% *}" in
    100644|100755) ;;
    '') die "$1 is missing at $REF" ;;
    *) die "$1 at $REF is not a regular file" ;;
  esac
}
fetch_source
self="$(/usr/bin/shasum -a 256 "$0" | /usr/bin/cut -d' ' -f1)"
say "this installer script: sha256 $self (compare it with the value in the description of the pull request that last changed tools/callboard before --apply)"

# As you: the sums file from the commit, its hash, and the path rules, before any sudo.
regular_at "$SRC_DIR/SHA256SUMS"
SUMS="$(hgit --git-dir="$REPO" cat-file blob "$REF:$SRC_DIR/SHA256SUMS")" || die "cannot read $SRC_DIR/SHA256SUMS at $REF"
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
[ -z "$(printf '%s\n' "${FILES[@]}" | LC_ALL=C /usr/bin/sort | /usr/bin/uniq -d)" ] || die "SHA256SUMS lists a path twice"
for f in "${FILES[@]}"; do regular_at "$SRC_DIR/$f"; done

# Staging. With sudo it is root-owned 0700 and this is the first sudo call; otherwise (dry run, tests) it is yours.
if [ "$APPLY" = 1 ] && [ "$NO_SUDO" = 0 ]; then
  STAGE="$(rr /usr/bin/mktemp -d /private/tmp/callboard.XXXXXXXX)"
  STAGE_WANT="0 700"
  STAGE_OWNER=root:wheel
else
  STAGE="$(/usr/bin/mktemp -d "$WORK/stage.XXXXXX")"
  STAGE_WANT="$(/usr/bin/id -u) 700"
  STAGE_OWNER=""
fi
stage_mode() {
  local su sm
  read -r su sm < <(rr /usr/bin/stat -f '%u %Lp' "$STAGE")
  [ "$su $sm" = "$STAGE_WANT" ]
}
stage_mode || die "staging directory does not have mode 0700 and the expected owner"
# Each file goes from git straight into the staging directory: root opens only paths it built under it from checked
# names, and never reads an archive or a file you could change.
for f in "${FILES[@]}"; do
  rr /usr/bin/install -d -m 0755 "$STAGE/$(/usr/bin/dirname "$f")" || die "cannot make a staging folder for $f"
  hgit --git-dir="$REPO" cat-file blob "$REF:$SRC_DIR/$f" | rr /usr/bin/tee "$STAGE/$f" > /dev/null || die "cannot stage $f"
  rr /bin/chmod 0644 "$STAGE/$f" || die "cannot set the mode of $f"
done
if [ -n "$STAGE_OWNER" ]; then rr /usr/sbin/chown -R -h "$STAGE_OWNER" "$STAGE" || die "cannot set the owner of the staged files"; fi
stage_mode || die "staging directory no longer has mode 0700 and the expected owner"
[ -z "$(rr /usr/bin/find "$STAGE" ! -type f ! -type d)" ] || die "staged tree holds something other than files and directories"
[ -z "$(rr /usr/bin/find "$STAGE" -perm +7022)" ] || die "staged tree holds a setuid, setgid, sticky or group- or other-writable entry"
[ -z "$(rr /usr/bin/find "$STAGE" -type f -links +1)" ] || die "staged tree holds a hard link"
if [ -n "$STAGE_OWNER" ]; then
  [ -z "$(rr /usr/bin/find "$STAGE" ! -user root)" ] || die "staged tree holds an entry not owned by root"
fi
staged="$(rr /usr/bin/find "$STAGE" -type f | /usr/bin/awk -v p="$STAGE/" 'index($0, p) == 1 { print substr($0, length(p) + 1) }' | LC_ALL=C /usr/bin/sort)"
[ "$staged" = "$(printf '%s\n' "${FILES[@]}" | LC_ALL=C /usr/bin/sort)" ] || die "staged files are not exactly the files SHA256SUMS lists"

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
  [ "$(/usr/bin/stat -L -f %HT "$LANES" 2>/dev/null)" = "Regular File" ] || die "--lanes is not a regular file (or not found)"
  # Read as you, at most 1 MiB and one byte, and streamed in, so root never opens the path you named.
  /usr/bin/head -c 1048577 -- "$LANES" | rr /usr/bin/tee "$STAGE/lanes.json" > /dev/null || die "cannot stage the --lanes file"
  rr /bin/chmod 0600 "$STAGE/lanes.json" || die "cannot set the mode of the staged --lanes file"
  [ "$(rr /usr/bin/stat -f %z "$STAGE/lanes.json")" -le 1048576 ] || die "--lanes file is over 1 MiB"
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
