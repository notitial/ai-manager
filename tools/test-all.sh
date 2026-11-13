#!/bin/bash
# Runs every test suite under tools/ and prints one pass/fail row per suite.
#   bash tools/test-all.sh                run all suites
#   bash tools/test-all.sh --quick        skip the slow ones (callboard, about 3 min)
#   bash tools/test-all.sh NAME [NAME…]   run only the named suites (names are the first column)
# A suite whose tool is missing (node, claude, python3, jq, plutil) shows as skip, never as pass. Exit 1 if any suite fails,
# 2 on an unknown option or suite name (checked before anything runs).
# Adding a suite: add one `suite` line below and the same name to the Build / Test list in CLAUDE.md.

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd -P) || exit 2
QUICK=0
ONLY=" "
for a in "$@"; do
  case $a in
    --quick) QUICK=1 ;;
    -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) ONLY="$ONLY$a " ;;
  esac
done
LOG=$(mktemp -d "${TMPDIR:-/tmp}/test-all-XXXXXX") || exit 2
[ -n "$LOG" ] && [ -d "$LOG" ] || exit 2
trap 'rm -rf "$LOG"' EXIT

RAN=0 FAILS="" PASSED=0 SKIPPED=0 LISTING=0 NAMES=" "
suite() {  # suite <name> <slow:0|1> <needs> <command>; needs is one or more commands on PATH, space-separated
  local name=$1 slow=$2 needs=$3 cmd=$4 start rc n
  if [ "$LISTING" = 1 ]; then NAMES="$NAMES$name "; return; fi
  if [ "$ONLY" != " " ]; then case $ONLY in *" $name "*) ;; *) return ;; esac; fi
  RAN=$((RAN + 1))
  if [ "$slow" = 1 ] && [ "$QUICK" = 1 ]; then
    printf '%-24s skip  (--quick)\n' "$name"; SKIPPED=$((SKIPPED + 1)); return
  fi
  for n in $needs; do
    command -v "$n" >/dev/null 2>&1 || { printf '%-24s skip  (needs %s)\n' "$name" "$n"; SKIPPED=$((SKIPPED + 1)); return; }
  done
  start=$SECONDS
  (cd "$ROOT" && bash -c "$cmd") > "$LOG/$name.log" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '%-24s pass  %4ss\n' "$name" $((SECONDS - start)); PASSED=$((PASSED + 1))
  else
    printf '%-24s FAIL  %4ss  (exit %s)\n' "$name" $((SECONDS - start)) "$rc"; FAILS="$FAILS $name"
  fi
}

# callboard needs node 22.18 or later, the claude CLI (claude plugin validate, claude plugin test) and
# /usr/bin/python3 (for link-extension.sh). CALLBOARD_SKIP_MOD_TESTS=1 skips `claude plugin test mod` inside the callboard
# suite (the slow part); the row still shows pass, so run this without it before any change to
# tools/callboard/mod. CI does not set it.
# rule-text needs node 22.18 or later: it checks that rules/callboard.md quotes the mod's fixed texts exactly.
# usage-watcher-install needs macOS (plutil), the Command Line Tools and /usr/bin/python3 3.9 or later.
suites() {
  suite callboard              1 'node claude /usr/bin/python3' 'bash tools/callboard/test.sh'
  suite usage-watcher          0 /usr/bin/python3           '/usr/bin/python3 -I tools/usage-watcher/test_watch.py'
  suite usage-watcher-install  0 'plutil /usr/bin/python3'  'bash tools/usage-watcher/test-install.sh'
  suite session-peers          0 'jq python3'               'bash tools/session-peers/test-peers.sh'
  suite rule-text              0 node                       'node tools/check-rule-text.mjs'
}

LISTING=1
suites
LISTING=0
UNKNOWN=0
for n in $ONLY; do
  case $NAMES in *" $n "*) ;; *) echo "unknown suite: $n (known:${NAMES% })" >&2; UNKNOWN=1 ;; esac
done
[ "$UNKNOWN" = 0 ] || exit 2

suites

echo
echo "$PASSED passed, $(echo $FAILS | wc -w | tr -d ' ') failed, $SKIPPED skipped of $RAN"
for f in $FAILS; do
  echo
  echo "--- $f (last 20 lines) ---"
  tail -n 20 "$LOG/$f.log"
  echo "--- $f (steps, failed tests and totals) ---"
  grep -E -A4 '^== |^\(fail\)|^not ok |^ *[0-9]+ (pass|fail)$|^Ran [0-9]+ tests' "$LOG/$f.log" | grep -E -v '^(\(pass\)|ok |#)' | head -n 120
done
[ -z "$FAILS" ]
