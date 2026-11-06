#!/bin/bash
# Tests for tools/session-peers/peers.sh against fake config dirs in a temp dir.
#   bash tools/session-peers/test-peers.sh
# Needs jq, ps and python3 (only to create the unix sockets).

set -u
HERE=$(cd "$(dirname "$0")" && pwd -P)
PEERS="$HERE/peers.sh"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }
check() { if eval "$2"; then ok; else bad "$1"; fi; }

T=$(mktemp -d "${TMPDIR:-/tmp}/peers-test-XXXXXX") && T=$(cd "$T" && pwd -P) || exit 2
# Socket paths must sit under /tmp/cc-socks* to be printed, and stay under the 104-byte sun_path limit.
S=$(mktemp -d /tmp/cc-socks-test-XXXXXX) || exit 2
O=$(mktemp -d /tmp/peers-other-XXXXXX) || exit 2
trap 'rm -rf "$T" "$S" "$O"' EXIT

mksock() {
  python3 -I -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$1" && [ -S "$1" ] ||
    { echo "setup: cannot create socket $1" >&2; exit 2; }
}
LIVE_PID=$$
LIVE_START=$(LC_ALL=C TZ=UTC ps -o lstart= -p "$LIVE_PID" | tr -s ' ' ' ' | sed 's/^ //; s/ $//')
DEAD_PID=99999
while ps -p "$DEAD_PID" >/dev/null 2>&1; do DEAD_PID=$((DEAD_PID - 1)); done

session() {  # session <dir> <file-stem> <pid> <procStart> <name> <socket>
  mkdir -p "$1/sessions"
  jq -n --argjson pid "$3" --arg ps "$4" --arg name "$5" --arg sock "$6" \
    '{pid: $pid, procStart: $ps, name: $name, kind: "interactive", status: "idle", sessionId: "sid-\($pid)",
      cwd: "/work/\($name)", startedAt: 1, messagingSocketPath: $sock}' > "$1/sessions/$2.json"
}

A="$T/home/.claude"
B="$T/home/.claude-conductor/config"
mksock "$S/a1.sock"
mksock "$S/b1.sock"
mksock "$O/outside.sock"
printf 'x' > "$S/plain.sock"
ln -s "$S/a1.sock" "$S/link.sock"
# procStart as a non-UTC ps would print it: must NOT count as live (guards the UTC assumption).
TOKYO_START=$(LC_ALL=C TZ=Asia/Tokyo ps -o lstart= -p "$LIVE_PID" | tr -s ' ' ' ' | sed 's/^ //; s/ $//')
session "$A" 1 "$LIVE_PID" "$LIVE_START" "zulu" "$S/a1.sock"
session "$A" 2 "$LIVE_PID" "$LIVE_START" "alpha" "$S/missing.sock"
session "$A" 3 "$DEAD_PID" "$LIVE_START" "deadone" "$S/a1.sock"
session "$A" 4 "$LIVE_PID" "Mon Jan  1 00:00:00 2001" "reused" "$S/a1.sock"
session "$A" 5 "$LIVE_PID" "$LIVE_START" "outside" "$O/outside.sock"
session "$A" 6 "$LIVE_PID" "$LIVE_START" "$(printf 'odd\033[31m\nname\342\200\256x\ty\342\200\213\357\273\277')" "$S/a1.sock"
session "$A" 7 "$LIVE_PID" "$LIVE_START" "dots" "$S/../$(basename "$S")/a1.sock"
session "$A" 11 "$LIVE_PID" "$TOKYO_START" "tokyo" "$S/a1.sock"
session "$A" 12 "$LIVE_PID" "$LIVE_START" "plainfile" "$S/plain.sock"
session "$A" 13 "$LIVE_PID" "$LIVE_START" "symsock" "$S/link.sock"
session "$B" 1 "$LIVE_PID" "$LIVE_START" "bravo" "$S/b1.sock"
# A key file that IS valid session JSON: if the glob ever widened to it, its name would show.
jq -n --argjson pid "$LIVE_PID" --arg ps "$LIVE_START" '{pid: $pid, procStart: $ps, name: "SECRETKEYVALUE"}' \
  > "$A/sessions/1.abcdef.key"
printf '{not json' > "$A/sessions/8.json"
printf '{"pid":"12; rm -rf /","name":"inject"}' > "$A/sessions/9.json"
ln -s "$A/sessions/1.json" "$A/sessions/10.json"
printf '{"pid":%s,"name":"multi1"}{"pid":%s,"name":"multi2"}' "$LIVE_PID" "$LIVE_PID" > "$A/sessions/14.json"

run() { PEERS_CONFIG_DIRS="$A:$B:$A" bash "$PEERS" "$@" 2>/dev/null; }
J=$(run --json)
JA=$(run --json --all)
TABLE=$(run)

check "json parses as an array" '[ "$(printf "%s" "$J" | jq -r type)" = array ]'
names() { printf '%s' "$1" | jq -r '.[].name' | tr '\n' ','; }
check "live rows only, sorted by dir then name" '[ "$(names "$J")" = "alpha,dots,oddnamexy,outside,plainfile,symsock,zulu,bravo," ]'
check "a non-UTC procStart is not live" '! printf "%s" "$J" | grep -q tokyo'
check "no address for a regular file at a cc-socks path" '[ "$(printf "%s" "$J" | jq -r ".[] | select(.name == \"plainfile\") | .address")" = null ]'
check "no address for a symlinked socket" '[ "$(printf "%s" "$J" | jq -r ".[] | select(.name == \"symsock\") | .address")" = null ]'
check "multi-document file skipped" '! printf "%s" "$JA" | grep -q multi'
check "pid is a number" '[ "$(printf "%s" "$J" | jq -r ".[0].pid | type")" = number ]'
check "warnings go to stderr" 'PEERS_CONFIG_DIRS="$A" bash "$PEERS" 2>&1 >/dev/null | grep -q "skipping unreadable"'
check "duplicate config dir listed once" '[ "$(printf "%s" "$J" | jq "[.[] | select(.name == \"zulu\")] | length")" = 1 ]'
check "address for a live socket under cc-socks" '[ "$(printf "%s" "$J" | jq -r ".[] | select(.name == \"zulu\") | .address")" = "uds:$S/a1.sock" ]'
check "no address when the socket is missing" '[ "$(printf "%s" "$J" | jq -r ".[] | select(.name == \"alpha\") | .address")" = null ]'
check "no address for a socket outside cc-socks" '[ "$(printf "%s" "$J" | jq -r ".[] | select(.name == \"outside\") | .address")" = null ]'
check "no address for a path with .." '[ "$(printf "%s" "$J" | jq -r ".[] | select(.name == \"dots\") | .address")" = null ]'
check "second dir row carries its config dir" '[ "$(printf "%s" "$J" | jq -r ".[] | select(.name == \"bravo\") | .configDir")" = "$(cd "$B" && pwd -P)" ]'
check "control and bidi characters stripped" '[ "$(printf "%s" "$J" | jq -r ".[] | select(.name | startswith(\"odd\")) | .name")" = "oddnamexy" ]'
check "--all adds the dead and reused files" '[ "$(names "$JA")" = "alpha,deadone,dots,oddnamexy,outside,plainfile,reused,symsock,tokyo,zulu,bravo," ]'
check "dead pid marked dead, no address" '[ "$(printf "%s" "$JA" | jq -r ".[] | select(.name == \"deadone\") | [.state, .address] | join(\",\")")" = "dead," ]'
check "--all table has a STATE column" 'run --all | head -1 | grep -q "STATE$"'
check "reused pid marked reused, no address" '[ "$(printf "%s" "$JA" | jq -r ".[] | select(.name == \"reused\") | [.state, .address] | join(\",\")")" = "reused," ]'
check "non-numeric pid file skipped" '! printf "%s" "$JA" | grep -q inject'
check "key file never read" '! printf "%s%s" "$JA" "$TABLE" | grep -q SECRETKEYVALUE'
check "table has a header and the uds address" 'printf "%s" "$TABLE" | head -1 | grep -q "^CONFIG" && printf "%s" "$TABLE" | grep -q "uds:$S/b1.sock"'
check "table shortens HOME" '[ "$(HOME="$T/home" PEERS_CONFIG_DIRS="$A" bash "$PEERS" 2>/dev/null | sed -n 2p | cut -c1-9)" = "~/.claude" ]'

# Discovery without the override: ~/.claude and ~/.claude-*/config under a fake HOME, no CLAUDE_CONFIG_DIR.
D=$(HOME="$T/home" env -u PEERS_CONFIG_DIRS -u CLAUDE_CONFIG_DIR bash "$PEERS" --json 2>/dev/null | jq -r '[.[].configDir] | unique | length')
check "discovery finds both dirs" '[ "$D" = 2 ]'
C="$T/elsewhere/cfg"
session "$C" 1 "$LIVE_PID" "$LIVE_START" "charlie" "$S/a1.sock"
X="$T/home/.claude-x"
session "$X" 1 "$LIVE_PID" "$LIVE_START" "xray" "$S/a1.sock"
DN=$(HOME="$T/home" CLAUDE_CONFIG_DIR="$C" env -u PEERS_CONFIG_DIRS bash "$PEERS" --json 2>/dev/null | jq -r '[.[].name] | sort | join(",")')
check "discovery adds CLAUDE_CONFIG_DIR and ~/.claude-*" 'case ",$DN," in *,charlie,*) case ",$DN," in *,xray,*) true ;; *) false ;; esac ;; *) false ;; esac'
L="$T/linked"
mkdir -p "$L"
ln -s "$A/sessions" "$L/sessions"
check "a symlinked sessions folder is listed once" '[ "$(PEERS_CONFIG_DIRS="$A:$L" bash "$PEERS" --json 2>/dev/null | jq "[.[] | select(.name == \"zulu\")] | length")" = 1 ]'
check "a leading ~/ in PEERS_CONFIG_DIRS is expanded" '[ "$(HOME="$T/home" PEERS_CONFIG_DIRS="~/.claude" bash "$PEERS" --json 2>/dev/null | jq "length")" -gt 0 ]'
check "-h prints usage" 'bash "$PEERS" -h | grep -q "uds:<socket>"'
E=$(HOME="$T/empty" env -u PEERS_CONFIG_DIRS -u CLAUDE_CONFIG_DIR bash "$PEERS" 2>/dev/null)
check "no dirs gives a message, not an error" 'printf "%s" "$E" | grep -q "No sessions found"'
check "unknown argument exits 2" 'bash "$PEERS" --bogus >/dev/null 2>&1; [ $? = 2 ]'

# A jq built without Oniguruma raises on gsub: clean must fall back to the input, not to the error
# text. Simulated by shadowing gsub ahead of the script's own filter.
FILTER=$(sed -n "/^CLEAN_JQ='/,/implode;'\$/p" "$PEERS" | sed "1s/^CLEAN_JQ='//; \$s/'\$//")
NOREGEX=$(jq -nr 'def gsub($r; $s): error("jq was compiled without ONIGURUMA regex library"); '"$FILTER"' "ab\u0007c" | clean' 2>&1)
check "clean survives a jq without regex support" '[ "$NOREGEX" = abc ]'

echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
