#!/usr/bin/env bash
# test-account-stamp.sh: behavioural tests for tools/usage-watcher/account-stamp.sh. Runs the hook under /bin/bash
# (3.2) by default; HOOK_SHELL=<bash> tests another bash, HOOK=<path> another copy. The hook prints nothing and
# always exits 0; its only effect is <state dir>/accounts/<session_id>.json.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
HOOK="${HOOK:-$HERE/account-stamp.sh}"
command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 2; }
PASS=0; FAIL=0
T=$(mktemp -d "${TMPDIR:-/tmp}/acctstamp-XXXXXX")
trap 'rm -rf "$T"' EXIT
SID=11111111-2222-3333-4444-555555555555
SID2=99999999-aaaa-bbbb-cccc-dddddddddddd

expect() {  # expect <what> <status of the condition just tested>
  if [ "$2" = 0 ]; then PASS=$((PASS + 1)); else echo "FAIL  $1"; FAIL=$((FAIL + 1)); fi
}

# hook <state dir> <label or -> <stdin>: runs the hook; OUT is its stdout, ST its exit status
hook() {
  if [ "$2" = - ]; then
    OUT=$(printf '%s' "$3" | env -u AIT_ACCOUNT USAGE_WATCHER_DIR="$1" "${HOOK_SHELL:-/bin/bash}" "$HOOK" 2>/dev/null); ST=$?
  else
    OUT=$(printf '%s' "$3" | AIT_ACCOUNT="$2" USAGE_WATCHER_DIR="$1" "${HOOK_SHELL:-/bin/bash}" "$HOOK" 2>/dev/null); ST=$?
  fi
}
inp() { jq -nc --arg s "$1" '{hook_event_name:"SessionStart",session_id:$s,source:"startup"}'; }
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }

D="$T/a"
hook "$D" second "$(inp $SID)"
[ "$ST" = 0 ] && [ -z "$OUT" ]; expect "label set: exit 0, no output" $?
[ "$(jq -r .label "$D/accounts/$SID.json" 2>/dev/null)" = second ]; expect "label set: file holds the label" $?
[ "$(jq -r .v "$D/accounts/$SID.json" 2>/dev/null)" = 1 ]; expect "label set: v is 1" $?
jq -e '.at | type == "number"' "$D/accounts/$SID.json" >/dev/null 2>&1; expect "label set: at is a number" $?
[ "$(mode_of "$D/accounts/$SID.json")" = 600 ]; expect "label set: mode 600" $?
[ "$(ls -A "$D/accounts" | wc -l | tr -d ' ')" = 1 ]; expect "label set: no temp file left behind" $?

hook "$D" second2 "$(inp $SID)"
[ "$(jq -r .label "$D/accounts/$SID.json")" = second2 ]; expect "a second start rewrites the file" $?

hook "$D" - "$(inp $SID)"
[ "$ST" = 0 ] && [ ! -e "$D/accounts/$SID.json" ]; expect "no label: this session's file is removed" $?

hook "$D" second "$(inp $SID2)"
hook "$D" - "$(inp $SID)"
[ -f "$D/accounts/$SID2.json" ]; expect "no label: another session's file stays" $?

hook "$T/b" - "$(inp $SID)"
[ "$ST" = 0 ] && [ ! -e "$T/b" ]; expect "no label: nothing is created" $?

LONG17=$(printf 'x%.0s' $(seq 1 17))
for bad_label in "Second" "a b" "-x" "a;b" "$LONG17" '$(id)' "../x"; do
  hook "$T/c" "$bad_label" "$(inp $SID)"
  [ "$ST" = 0 ] && [ ! -e "$T/c/accounts/$SID.json" ]; expect "invalid label '$bad_label' writes nothing" $?
done
hook "$T/c" "$(printf 'x%.0s' $(seq 1 16))" "$(inp $SID)"
[ -f "$T/c/accounts/$SID.json" ]; expect "a 16 character label is valid" $?

LONG65=$(printf '1%.0s' $(seq 1 65))
for bad_sid in "" "../../etc/passwd" "abc" "zzzzzzzz-1" "$LONG65" "a/b-1111111"; do
  hook "$T/d" second "$(inp "$bad_sid")"
  [ "$ST" = 0 ] && [ ! -e "$T/d" ]; expect "invalid session id '$bad_sid' writes nothing" $?
done

for junk in "" "not json" "[]" "null" '{"session_id":5}' '{"session_id":["x"]}'; do
  hook "$T/e" second "$junk"
  [ "$ST" = 0 ] && [ -z "$OUT" ] && [ ! -e "$T/e" ]; expect "junk input '$junk' is ignored" $?
done

mkdir -p "$T/real" "$T/f"; ln -s "$T/real" "$T/f/accounts"
hook "$T/f" second "$(inp $SID)"
[ "$ST" = 0 ] && [ -z "$(ls -A "$T/real")" ]; expect "a symlinked accounts dir is not written through" $?

mkdir -p "$T/realbase"; ln -s "$T/realbase" "$T/g"
hook "$T/g" second "$(inp $SID)"
[ "$ST" = 0 ] && [ -z "$(ls -A "$T/realbase")" ]; expect "a symlinked state dir is not written through" $?

mkdir -p "$T/h/accounts"; ln -s "$T/real" "$T/h/accounts/$SID.json"
hook "$T/h" - "$(inp $SID)"
[ -L "$T/h/accounts/$SID.json" ]; expect "no label: a symlink at the file path is left alone" $?

MARK="auth-marker-$$-$(date +%s)"
OUT=$(printf '%s' "$(inp $SID)" | AIT_ACCOUNT=second CLAUDE_CODE_OAUTH_TOKEN="$MARK" ANTHROPIC_API_KEY="$MARK" \
  USAGE_WATCHER_DIR="$T/i" "${HOOK_SHELL:-/bin/bash}" "$HOOK" 2>&1); ST=$?
[ "$ST" = 0 ] && [ -z "$OUT" ] && ! grep -rqF "$MARK" "$T/i"; expect "an auth variable in the env never reaches output or files" $?
! grep -v '^[[:space:]]*#' "$HOOK" | grep -qE 'OAUTH|API_KEY|TOKEN|SECRET'; expect "the hook's code names no auth variable" $?

if [ "$FAIL" = 0 ]; then echo "account-stamp: $PASS passed"; exit 0; fi
echo "account-stamp: $PASS passed, $FAIL FAILED"; exit 1
