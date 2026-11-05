#!/bin/bash
# Usage-watcher installer: installs watch.py, account-stamp.sh and the launchd job io.notitial.usage-watcher from a
# commit of https://github.com/notitial/ai-manager.git. It never reads the working tree it sits in.
#
#   bash tools/usage-watcher/install.sh [--ref <commit>]           dry run: fetch, then print what --apply would do
#   bash tools/usage-watcher/install.sh [--ref <commit>] --apply   install or update, then reload the job and verify
#   bash tools/usage-watcher/install.sh --status [--ref <commit>]  read-only report; with --ref, compare against it
#   bash tools/usage-watcher/install.sh --uninstall [--apply]      dry run, or unload the job and remove the files
#
# --ref takes a full 40-hex commit that must be on main (recommended: one you have read). Without it, main's tip.
#
# How it fetches. The URL above is a constant: no option, and no variable or git config the installer reads, changes
# it. main is fetched over HTTPS without credentials into a fresh temporary bare repository, and every file is read
# from the commit there (git ls-tree / cat-file), never from a checkout: the checkout's object store and git config
# are never read. Every git call runs under `env -i` (PATH /usr/bin:/bin, HOME the temporary folder, no system or
# global config, no prompts, no replace refs, no lazy fetch) with -c flags that turn off hooks, fsmonitor, credential
# helpers, askpass, auto gc and maintenance, submodule recursion and HTTP redirects, and check every fetched object.
# Only the fetch may use a transport (HTTPS); every other git call may use none. The fetch ignores proxy variables.
#
# What it writes (with --apply only):
#   ~/.local/share/usage-watcher/watch.py           0444   the copy the job runs
#   ~/.local/share/usage-watcher/account-stamp.sh   0555   the SessionStart hook
#   ~/Library/LaunchAgents/io.notitial.usage-watcher.plist  0644, rendered from the commit's template, then refused
#       unless it holds only the template's keys (Label, ProgramArguments, StartInterval, RunAtLoad, ProcessType, Nice,
#       StandardOutPath, StandardErrorPath) with their expected values, and ProgramArguments is exactly
#       /usr/bin/python3 -I <watch.py> --config-dir <config dir>: no Program, EnvironmentVariables, KeepAlive, etc.
#   ~/.local/share/usage-watcher and ~/.local/state/usage-watcher (the data folder) as 0700 directories
# It refuses a symlink, a foreign owner or a group- or world-writable directory anywhere on those paths. Before
# installing it runs the commit's own watcher tests in the temporary folder, on the same bytes it installs. It then
# runs `launchctl bootout` (when loaded) and `launchctl bootstrap gui/<uid>`, and checks the loaded job runs the
# installed watch.py. It refuses to run as root.
# It prints, and never writes, the hook entry for settings.json. It never edits a settings file, never uses sudo,
# never reads or sends a credential. --uninstall keeps the data folder.
#
# Exit codes: 0 done (or nothing to do); 1 failed (fetch, tests, launchctl, verification, environment);
#   2 usage error; 3 refused: unsafe state (symlink, owner, permissions, run as root);
#   4 --status only: something is missing, not loaded, differs from --ref, or jq is missing.
# Needs macOS, the Command Line Tools and /usr/bin/python3 3.9 or later. bash 3.2.
# Tests: bash tools/usage-watcher/test-install.sh (it runs a copy whose two source lines point at a local fixture).

set -euo pipefail
umask 077

readonly ORIGIN_URL='https://github.com/notitial/ai-manager.git'
readonly ORIGIN_PROTO='https'
readonly LABEL='io.notitial.usage-watcher'
readonly SRC_DIR='tools/usage-watcher'
readonly PY=/usr/bin/python3
readonly INTERVAL=300

say() { printf '%s\n' "$*"; }
die() {
  local rc=$1
  shift
  printf 'install.sh: %s\n' "$*" >&2
  exit "$rc"
}
usage() {
  say "usage: install.sh [--ref <40-hex commit>] [--apply]"
  say "       install.sh --status [--ref <40-hex commit>]"
  say "       install.sh --uninstall [--apply]"
  say "Without --apply nothing changes. See the header of this file for details."
}

MODE=install
APPLY=0
REF=''
REF_SET=0
while [ $# -gt 0 ]; do
  case $1 in
    --apply) APPLY=1 ;;
    --status)
      [ "$MODE" = install ] || die 2 "--status and --uninstall do not combine"
      MODE=status
      ;;
    --uninstall)
      [ "$MODE" = install ] || die 2 "--status and --uninstall do not combine"
      MODE=uninstall
      ;;
    --ref)
      [ $# -ge 2 ] || die 2 "--ref needs a value"
      REF=$2
      REF_SET=1
      shift
      ;;
    --ref=*)
      REF=${1#--ref=}
      REF_SET=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die 2 "unknown argument: $1"
      ;;
  esac
  shift
done
if [ "$REF_SET" = 1 ]; then
  case $REF in *[!0-9a-f]* | '') die 2 "--ref must be a full commit id, 40 lowercase hex characters" ;; esac
  [ "${#REF}" -eq 40 ] || die 2 "--ref must be a full commit id, 40 lowercase hex characters"
fi
[ "$MODE" = status ] && [ "$APPLY" = 1 ] && die 2 "--status is read-only; it takes no --apply"
[ "$MODE" = uninstall ] && [ "$REF_SET" = 1 ] && die 2 "--uninstall takes no --ref"

[ "$(/usr/bin/uname -s)" = Darwin ] || die 1 "the usage watcher runs on macOS only"

# safe_value <name> <value>: an absolute path with no control character (a newline would split a plist or a hook line).
safe_value() {
  case $2 in
    /*) ;;
    *) die 1 "$1 must be an absolute path (got '$2')" ;;
  esac
  case $2 in *[[:cntrl:]]*) die 1 "$1 holds a control character" ;; esac
  return 0
}
HOME_DIR=${HOME:-}
safe_value HOME "$HOME_DIR"
HOME_DIR=${HOME_DIR%/}
CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$HOME_DIR/.claude}
safe_value CLAUDE_CONFIG_DIR "$CONFIG_DIR"
CONFIG_DIR=${CONFIG_DIR%/}

SHARE=$HOME_DIR/.local/share/usage-watcher
STATE=$HOME_DIR/.local/state/usage-watcher
AGENTS=$HOME_DIR/Library/LaunchAgents
PLIST=$AGENTS/$LABEL.plist
WATCH=$SHARE/watch.py
STAMP=$SHARE/account-stamp.sh
# The directories on the install paths, parents first, so each is checked (and created) before what is inside it.
# One per line (no path holds a newline: safe_value), read with `while read ... <<<`, so a space in a path is kept.
DIRS="$HOME_DIR/.local
$HOME_DIR/.local/share
$SHARE
$HOME_DIR/.local/state
$STATE
$HOME_DIR/Library
$AGENTS"

UIDN=$(command id -u) || die 1 "cannot read your user id"
case $UIDN in '' | *[!0-9]*) die 1 "unexpected user id '$UIDN'" ;; esac
[ "$UIDN" != 0 ] || die 3 "run as your own user, not root"
TMP_BASE=${TMPDIR:-/tmp}
case $TMP_BASE in
  /*) ;;
  *) die 1 "TMPDIR must be an absolute path (got '$TMP_BASE')" ;;
esac
DOMAIN=gui/$UIDN
SERVICE=$DOMAIN/$LABEL

WORK=''
PENDING=''
cleanup() {
  if [ -n "$PENDING" ] && [ -f "$PENDING" ] && [ ! -L "$PENDING" ]; then /bin/rm -f -- "$PENDING"; fi
  if [ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ]; then /bin/rm -rf -- "$WORK"; fi
  return 0
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# --- checks on the destination paths -------------------------------------------------------------------------------

mode_of() { /usr/bin/stat -f %Lp "$1"; }

# check_dir <path>: 0 when it is a safe directory, 1 when missing; exits 3 when unsafe.
check_dir() {
  local p=$1 m
  [ -L "$p" ] && die 3 "$p is a symlink; replace it with a real directory, then retry"
  [ -e "$p" ] || return 1
  [ -d "$p" ] || die 3 "$p is not a directory"
  [ -O "$p" ] || die 3 "$p is not owned by you"
  m=$(mode_of "$p") || die 1 "cannot read the mode of $p"
  if ((8#$m & 8#022)); then die 3 "$p is group- or world-writable (mode $m); fix that, then retry"; fi
  return 0
}

# check_file <path>: 0 when it is a regular file of yours, 1 when missing; exits 3 when unsafe.
check_file() {
  local p=$1
  [ -L "$p" ] && die 3 "$p is a symlink; remove it, then retry"
  [ -e "$p" ] || return 1
  [ -f "$p" ] || die 3 "$p is not a regular file"
  [ -O "$p" ] || die 3 "$p is not owned by you"
  return 0
}

check_paths() {
  local d
  check_dir "$HOME_DIR" || die 1 "your home $HOME_DIR does not exist"
  while IFS= read -r d; do check_dir "$d" || true; done <<<"$DIRS"
  for d in "$WATCH" "$STAMP" "$PLIST"; do check_file "$d" || true; done
  return 0
}

# --- git, hardened ---------------------------------------------------------------------------------------------------

# hgit <git args...>: git with nothing from the caller's environment or any config outside the repository it is
# pointed at, and the settings that could run a program or reroute a fetch turned off. The transport allowed is
# _proto (a caller's local), else none.
hgit() {
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$WORK/home" LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= \
    SSH_ASKPASS= GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL="${_proto:-none}" \
    /usr/bin/git --no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null -c gc.auto=0 \
    -c maintenance.auto=false -c credential.helper= -c core.askPass= -c protocol.allow=never \
    -c fetch.recurseSubmodules=false -c transfer.fsckObjects=true -c http.sslVerify=true \
    -c http.followRedirects=false -c init.defaultBranch=main "$@"
}

REPO=''
COMMIT=''
# fetch_commit: fetches main into a fresh temporary bare repository and sets COMMIT (--ref, checked to be on main).
# Every hgit call names that repository with --git-dir (no discovery), so no checkout's objects or config are read.
fetch_commit() {
  local main _proto=none
  WORK=$(/usr/bin/mktemp -d "$TMP_BASE/uw-install.XXXXXX") || die 1 "cannot make a temporary folder in $TMP_BASE"
  /bin/mkdir -m 0700 "$WORK/home" "$WORK/tmp" || die 1 "cannot set up $WORK"
  REPO=$WORK/repo.git
  hgit --git-dir="$REPO" init -q --bare --template= || die 1 "cannot set up the temporary repository"
  _proto=$ORIGIN_PROTO
  hgit --git-dir="$REPO" fetch -q --no-tags --no-recurse-submodules --no-write-fetch-head "$ORIGIN_URL" \
    '+refs/heads/main:refs/remotes/origin/main' ||
    die 1 "fetching main from $ORIGIN_URL failed (the fetch has no credentials and ignores proxy environment variables)"
  _proto=none
  main=$(hgit --git-dir="$REPO" rev-parse --verify -q 'refs/remotes/origin/main^{commit}') ||
    die 1 "the fetch from $ORIGIN_URL brought no main"
  if [ -n "$REF" ]; then
    hgit --git-dir="$REPO" cat-file -e "$REF^{commit}" 2>/dev/null ||
      die 1 "commit $REF is not on main of $ORIGIN_URL"
    hgit --git-dir="$REPO" merge-base --is-ancestor "$REF" "$main" ||
      die 1 "commit $REF is not on main of $ORIGIN_URL"
    COMMIT=$REF
    say "source: $ORIGIN_URL, commit $COMMIT (on main; main is at $main)"
  else
    COMMIT=$main
    say "source: $ORIGIN_URL, main at $COMMIT (pin it next time with --ref $COMMIT)"
  fi
}

# read_blob <path in repo> <out file>: the commit's file, which must be a regular (not symlink) non-empty file.
read_blob() {
  local entry mode
  entry=$(hgit --git-dir="$REPO" ls-tree "$COMMIT" -- "$1") || die 1 "cannot list $1 at $COMMIT"
  mode=${entry%% *}
  case $mode in
    100644 | 100755) ;;
    '') die 1 "$1 is missing at $COMMIT" ;;
    *) die 1 "$1 at $COMMIT is not a regular file (mode $mode)" ;;
  esac
  hgit --git-dir="$REPO" cat-file blob "$COMMIT:$1" >"$2" || die 1 "cannot read $1 at $COMMIT"
  [ -s "$2" ] || die 1 "$1 is empty at $COMMIT"
}

xml_esc() { printf '%s' "$1" | /usr/bin/sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
pl_get() { /usr/bin/plutil -extract "$1" raw -o - "$2" 2>/dev/null; }

# The rendered plist, as JSON on stdin, must hold only these keys with these values (argv: label, python, watch.py,
# config dir, interval); anything else (Program, EnvironmentVariables, WatchPaths, KeepAlive, UserName, an extra
# argument, ...) is refused. Types are compared too, so true is not 1.
readonly PLIST_CHECK='
import json, sys
label, py, watch, cfg, interval = sys.argv[1:6]
want = {"Label": label, "ProgramArguments": [py, "-I", watch, "--config-dir", cfg], "StartInterval": int(interval),
        "RunAtLoad": True, "ProcessType": "Background", "Nice": 10,
        "StandardOutPath": "/dev/null", "StandardErrorPath": "/dev/null"}
required = ("Label", "ProgramArguments", "StartInterval")
d = json.load(sys.stdin)
if not isinstance(d, dict):
    sys.exit("not a dictionary")
bad = []
for k in sorted(d):
    if k not in want:
        bad.append("unexpected key %s" % json.dumps(k))
    elif type(d[k]) is not type(want[k]) or d[k] != want[k]:
        bad.append("%s is %s, want %s" % (k, json.dumps(d[k]), json.dumps(want[k])))
bad += ["missing key %s" % k for k in required if k not in d]
if any(type(a) is not str for a in d.get("ProgramArguments", [])):
    bad.append("ProgramArguments holds a non-string")
if bad:
    sys.exit("; ".join(bad))
'

# render_plist <template> <out>: fills __HOME__ and __CONFIG_DIR__ in one pass (a value is never re-scanned), then
# refuses the result unless it is a valid plist holding exactly what PLIST_CHECK allows.
render_plist() {
  local h c out
  h=$(xml_esc "$HOME_DIR")
  c=$(xml_esc "$CONFIG_DIR")
  UW_H=$h UW_C=$c /usr/bin/awk '{
    s = $0; out = ""
    while (1) {
      i = index(s, "__HOME__"); j = index(s, "__CONFIG_DIR__")
      if (i == 0 && j == 0) break
      if (j == 0 || (i > 0 && i < j)) { out = out substr(s, 1, i - 1) ENVIRON["UW_H"]; s = substr(s, i + 8) }
      else { out = out substr(s, 1, j - 1) ENVIRON["UW_C"]; s = substr(s, j + 14) }
    }
    print out s
  }' "$1" >"$2" || die 1 "cannot render the plist"
  /usr/bin/plutil -lint -s "$2" >/dev/null || die 1 "the rendered plist is not valid"
  /usr/bin/plutil -convert json -o "$2.json" "$2" >/dev/null 2>&1 || die 1 "the rendered plist does not convert to JSON"
  if ! out=$(/usr/bin/env -i PATH=/usr/bin:/bin "$PY" -I -c "$PLIST_CHECK" "$LABEL" "$PY" "$WATCH" "$CONFIG_DIR" \
    "$INTERVAL" <"$2.json" 2>&1); then
    die 1 "the plist at $COMMIT is not the expected job, refusing it: $out"
  fi
}

sha_of() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{ print $1 }'; }

# --- launchd ---------------------------------------------------------------------------------------------------------

job_loaded() { command launchctl print "$SERVICE" >/dev/null 2>&1; }

# job_runs_watch: the loaded job lists the installed watch.py as a whole line of `launchctl print`.
job_runs_watch() {
  local out
  out=$(command launchctl print "$SERVICE" 2>&1) || return 1
  printf '%s\n' "$out" | UW_W=$WATCH /usr/bin/awk '{ s = $0; gsub(/^[ \t]+|[ \t]+$/, "", s); if (s == ENVIRON["UW_W"]) f = 1 } END { exit !f }'
}

unload_job() {
  local i=0
  job_loaded || return 0
  command launchctl bootout "$SERVICE" || say "launchctl bootout $SERVICE reported an error; waiting for it to unload" >&2
  while job_loaded; do
    i=$((i + 1))
    [ "$i" -le 20 ] || { say "$SERVICE is still loaded 10 s after bootout" >&2; return 1; }
    /bin/sleep 0.5
  done
  return 0
}

load_job() {
  local i=0
  until command launchctl bootstrap "$DOMAIN" "$PLIST"; do
    i=$((i + 1))
    if [ "$i" -ge 3 ]; then
      say "launchctl bootstrap $DOMAIN $PLIST failed; if the job is disabled, run: launchctl enable $SERVICE" >&2
      say "the job is unloaded; the files are installed; fix the cause and re-run --apply" >&2
      return 1
    fi
    /bin/sleep 1
  done
  job_runs_watch || { say "after bootstrap, $SERVICE is not loaded or does not run $WATCH" >&2; return 1; }
}

# --- install steps ---------------------------------------------------------------------------------------------------

# act <description> <command...>: runs the command with --apply, else only says it would. No eval: the command is argv.
act() {
  local what=$1
  shift
  if [ "$APPLY" = 1 ]; then
    say "  - $what"
    "$@" || die 1 "failed to $what"
  else
    say "  - would $what"
  fi
}

# put_file <source> <mode> <destination>: writes beside the destination, then renames over it.
put_file() {
  PENDING=$(/usr/bin/mktemp "$(/usr/bin/dirname "$3")/.uw-install.XXXXXX") || return 1
  /bin/cat "$1" >"$PENDING" || return 1
  /bin/chmod "$2" "$PENDING" || return 1
  /bin/mv -f "$PENDING" "$3" || return 1
  PENDING=''
}

# plan_file <name> <new file> <mode> <destination>
plan_file() {
  local new_sha
  new_sha=$(sha_of "$2")
  if check_file "$4"; then
    if /usr/bin/cmp -s "$2" "$4" && [ "$(mode_of "$4")" = "${3#0}" ]; then
      say "  - $1 unchanged ($4)"
      return 0
    fi
    act "replace $4 (mode $3, sha256 $(sha_of "$4") -> $new_sha)" put_file "$2" "$3" "$4"
  else
    act "write $4 (mode $3, sha256 $new_sha)" put_file "$2" "$3" "$4"
  fi
}

have_jq() { command -v jq >/dev/null 2>&1; }

json_esc() { printf '%s' "$1" | /usr/bin/sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

print_hook_line() {
  say ""
  say "By hand: register account-stamp.sh as a SessionStart hook in $CONFIG_DIR/settings.json (this installer never"
  say "edits settings). Add this entry to the \"SessionStart\" list under \"hooks\" (no matcher), unless it is there:"
  say ""
  say "  {\"hooks\": [{\"type\": \"command\", \"command\": \"$(json_esc "$STAMP")\"}]}"
}

do_install() {
  local d pyv
  /usr/bin/xcode-select -p >/dev/null 2>&1 ||
    die 1 "the Command Line Tools are missing (git and $PY need them); run: xcode-select --install"
  pyv=$("$PY" -I -c 'import sys; print("%d.%d" % sys.version_info[:2]); sys.exit(sys.version_info < (3, 9))') ||
    die 1 "$PY is older than 3.9"
  check_paths
  [ "$APPLY" = 1 ] && say "usage-watcher install (--apply)" || say "usage-watcher install: DRY RUN, nothing changes (add --apply to install)"
  fetch_commit
  read_blob "$SRC_DIR/watch.py" "$WORK/watch.py"
  read_blob "$SRC_DIR/account-stamp.sh" "$WORK/account-stamp.sh"
  read_blob "$SRC_DIR/$LABEL.plist" "$WORK/plist.in"
  render_plist "$WORK/plist.in" "$WORK/plist"
  say "  - python: $PY $pyv"
  have_jq || say "  - WARNING: jq is not on your PATH, so account-stamp.sh will record nothing; install jq"

  if [ "$APPLY" = 1 ]; then
    say "  - run the watcher's tests at $COMMIT"
    run_tests
  else
    say "  - would run the watcher's tests at $COMMIT (in a temporary folder)"
  fi

  while IFS= read -r d; do
    if ! check_dir "$d"; then
      act "create $d (mode 0700)" /bin/mkdir -m 0700 "$d"
    elif { [ "$d" = "$SHARE" ] || [ "$d" = "$STATE" ]; } && [ "$(mode_of "$d")" != 700 ]; then
      act "set $d to mode 0700" /bin/chmod 0700 "$d"
    fi
  done <<<"$DIRS"
  plan_file watch.py "$WORK/watch.py" 0444 "$WATCH"
  plan_file account-stamp.sh "$WORK/account-stamp.sh" 0555 "$STAMP"
  if [ "$APPLY" != 1 ]; then
    if check_file "$PLIST"; then
      if ! /usr/bin/cmp -s "$WORK/plist" "$PLIST"; then
        say "  - the plist would change:"
        /usr/bin/diff -u "$PLIST" "$WORK/plist" | /usr/bin/sed 's/^/      /' || true
      fi
    else
      say "  - the plist would be:"
      /usr/bin/sed 's/^/      /' "$WORK/plist"
    fi
  fi
  plan_file plist "$WORK/plist" 0644 "$PLIST"
  if job_loaded; then
    act "unload the job: launchctl bootout $SERVICE" unload_job
  fi
  act "load the job: launchctl bootstrap $DOMAIN $PLIST" load_job
  if [ "$APPLY" = 1 ]; then
    verify_install
    say "installed from $COMMIT; the job is loaded and runs $WATCH every $INTERVAL s"
  fi
  print_hook_line
}

run_tests() {
  local out
  /bin/mkdir -m 0700 "$WORK/src" || die 1 "cannot make $WORK/src"
  hgit --git-dir="$REPO" archive --format=tar "$COMMIT" -- "$SRC_DIR" | /usr/bin/tar -x -f - -C "$WORK/src" ||
    die 1 "cannot extract $SRC_DIR at $COMMIT"
  # The tests must run on the bytes that get installed (an export-subst or a filter could make them differ).
  /usr/bin/cmp -s "$WORK/src/$SRC_DIR/watch.py" "$WORK/watch.py" ||
    die 1 "the tested watch.py differs from the one to install; nothing installed"
  /usr/bin/cmp -s "$WORK/src/$SRC_DIR/account-stamp.sh" "$WORK/account-stamp.sh" ||
    die 1 "the tested account-stamp.sh differs from the one to install; nothing installed"
  [ -f "$WORK/src/$SRC_DIR/test_watch.py" ] && [ ! -L "$WORK/src/$SRC_DIR/test_watch.py" ] ||
    die 1 "$SRC_DIR/test_watch.py is missing at $COMMIT; nothing installed"
  if ! out=$(cd "$WORK/src" && /usr/bin/env -i PATH=/usr/bin:/bin HOME="$WORK/home" TMPDIR="$WORK/tmp/" \
    "$PY" -B -I "$WORK/src/$SRC_DIR/test_watch.py" 2>&1); then
    printf '%s\n' "$out" | /usr/bin/tail -n 20 >&2
    die 1 "the watcher's tests fail at $COMMIT; nothing installed"
  fi
}

verify_install() {
  /usr/bin/cmp -s "$WORK/watch.py" "$WATCH" && [ "$(mode_of "$WATCH")" = 444 ] || die 1 "verify: $WATCH is not the commit's copy (mode 0444)"
  /usr/bin/cmp -s "$WORK/account-stamp.sh" "$STAMP" && [ "$(mode_of "$STAMP")" = 555 ] || die 1 "verify: $STAMP is not the commit's copy (mode 0555)"
  /usr/bin/cmp -s "$WORK/plist" "$PLIST" && [ "$(mode_of "$PLIST")" = 644 ] || die 1 "verify: $PLIST is not the rendered plist (mode 0644)"
  [ "$(mode_of "$SHARE")" = 700 ] && [ "$(mode_of "$STATE")" = 700 ] || die 1 "verify: $SHARE or $STATE is not mode 0700"
  job_runs_watch || die 1 "verify: $SERVICE is not loaded with $WATCH"
}

# --- status ----------------------------------------------------------------------------------------------------------

ATTN=0
# describe <path> <want: file|dir>: one line; counts what needs attention.
describe() {
  local p=$1
  if [ -L "$p" ]; then
    say "  UNSAFE   $p is a symlink"
    ATTN=$((ATTN + 1))
  elif [ ! -e "$p" ]; then
    say "  missing  $p"
    ATTN=$((ATTN + 1))
  elif [ "$2" = dir ]; then
    say "  ok       $p (directory, mode $(mode_of "$p"))"
  elif [ ! -f "$p" ] || [ ! -O "$p" ]; then
    say "  UNSAFE   $p is not a regular file of yours"
    ATTN=$((ATTN + 1))
  else
    say "  ok       $p (mode $(mode_of "$p"), sha256 $(sha_of "$p"))"
  fi
}

# compare <name> <commit file> <installed file>
compare() {
  if [ -f "$3" ] && [ ! -L "$3" ] && /usr/bin/cmp -s "$2" "$3"; then
    say "  same     $1 as at $COMMIT"
  else
    say "  DIFFERS  $1 from $COMMIT"
    ATTN=$((ATTN + 1))
  fi
}

do_status() {
  local out last
  say "usage-watcher status (job $SERVICE)"
  describe "$WATCH" file
  describe "$STAMP" file
  describe "$PLIST" file
  if [ -f "$PLIST" ] && [ ! -L "$PLIST" ]; then
    [ "$(pl_get Label "$PLIST")" = "$LABEL" ] || { say "  WRONG    the plist's Label is not $LABEL"; ATTN=$((ATTN + 1)); }
  fi
  describe "$STATE" dir
  if ! have_jq; then
    say "  WARNING  jq is not on your PATH, so account-stamp.sh will record nothing; install jq"
    ATTN=$((ATTN + 1))
  fi
  if out=$(command launchctl print "$SERVICE" 2>&1); then
    last=$(printf '%s\n' "$out" | /usr/bin/awk '/last exit code/ { sub(/^[ \t]+/, ""); print; exit }')
    say "  loaded   $SERVICE${last:+ ($last)}"
    job_runs_watch || { say "  WRONG    the loaded job does not run $WATCH"; ATTN=$((ATTN + 1)); }
  else
    say "  not loaded  $SERVICE"
    ATTN=$((ATTN + 1))
  fi
  if [ -n "$REF" ]; then
    /usr/bin/xcode-select -p >/dev/null 2>&1 || die 1 "the Command Line Tools are missing; run: xcode-select --install"
    fetch_commit
    read_blob "$SRC_DIR/watch.py" "$WORK/watch.py"
    read_blob "$SRC_DIR/account-stamp.sh" "$WORK/account-stamp.sh"
    read_blob "$SRC_DIR/$LABEL.plist" "$WORK/plist.in"
    render_plist "$WORK/plist.in" "$WORK/plist"
    compare watch.py "$WORK/watch.py" "$WATCH"
    compare account-stamp.sh "$WORK/account-stamp.sh" "$STAMP"
    compare plist "$WORK/plist" "$PLIST"
  fi
  if [ "$ATTN" -gt 0 ]; then
    say "$ATTN item(s) need attention"
    return 4
  fi
  say "all good"
}

# --- uninstall -------------------------------------------------------------------------------------------------------

do_uninstall() {
  local f
  [ "$APPLY" = 1 ] && say "usage-watcher uninstall (--apply)" || say "usage-watcher uninstall: DRY RUN, nothing changes (add --apply to uninstall)"
  check_paths
  if job_loaded; then
    act "unload the job: launchctl bootout $SERVICE" unload_job
  else
    say "  - the job is not loaded"
  fi
  for f in "$PLIST" "$WATCH" "$STAMP"; do
    if check_file "$f"; then act "remove $f" /bin/rm -f -- "$f"; fi
  done
  if check_dir "$SHARE"; then
    if [ "$APPLY" = 1 ]; then
      /bin/rmdir -- "$SHARE" 2>/dev/null && say "  - removed $SHARE" || say "  - kept $SHARE (it holds other files)"
    else
      say "  - would remove $SHARE if nothing else is in it"
    fi
  fi
  say "  - keep the data folder $STATE"
  say ""
  say "By hand: remove the SessionStart hook entry for $STAMP from $CONFIG_DIR/settings.json."
}

case $MODE in
  install) do_install ;;
  status) do_status || exit $? ;;
  uninstall) do_uninstall ;;
esac
