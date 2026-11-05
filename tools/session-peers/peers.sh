#!/bin/bash
# peers.sh: list every local Claude Code session on this machine, across all config dirs, each with the
# uds:<socket> address SendMessage takes. ListAgents shows only the caller's own config dir; a session in
# another dir can still be messaged by its socket address (cross-dir sends verified both ways, 2026-10-30).
#
#   bash tools/session-peers/peers.sh            table of live sessions
#   bash tools/session-peers/peers.sh --json     the same as a JSON array
#   bash tools/session-peers/peers.sh --all      also list stale session files (dead pid, or pid reused)
#
# Config dirs: PEERS_CONFIG_DIRS (colon-separated; a leading ~/ is expanded) replaces discovery. Otherwise
# ~/.claude, $CLAUDE_CONFIG_DIR, and every ~/.claude-*/config or ~/.claude-* (the conductor root is
# ~/.claude-conductor/config), each kept only if it has a sessions/ folder. Rows show the resolved real path.
#
# Read-only. It reads only <dir>/sessions/<pid>.json, and only the fields printed below; it never opens a *.key
# file. Session names, cwds and dir names are untrusted display text: control, ANSI, bidi and zero-width
# characters are stripped. Needs bash 3.2+, jq, ps and column. Exit 3 if ps cannot read the process table.

set -u
JSON=0
ALL=0
for a in "$@"; do
  case $a in
    --json) JSON=1 ;;
    --all) ALL=1 ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "peers.sh: unknown argument: $a" >&2; exit 2 ;;
  esac
done
command -v jq >/dev/null 2>&1 || { echo "peers.sh: needs jq" >&2; exit 2; }
# Without this probe a sandboxed ps would mark every session dead and print "No sessions found".
LC_ALL=C TZ=UTC ps -o lstart= -p $$ >/dev/null 2>&1 || { echo "peers.sh: ps cannot read the process table" >&2; exit 3; }

NL='
'
DIRS=""
SEEN=""
add_dir() {
  local d=$1 real sess
  case $d in "~/"*) d="$HOME/${d#\~/}" ;; esac
  [ -n "$d" ] && [ -d "$d/sessions" ] || return 0
  real=$(cd "$d" 2>/dev/null && pwd -P) || return 0
  # Dedupe on the sessions folder too: one dir's sessions/ may be a symlink to another's.
  sess=$(cd "$d/sessions" 2>/dev/null && pwd -P) || return 0
  case "$NL$SEEN" in *"$NL$sess$NL"*) return 0 ;; esac
  SEEN="$SEEN$sess$NL"
  DIRS="$DIRS$real$NL"
}
if [ -n "${PEERS_CONFIG_DIRS:-}" ]; then
  _ifs=$IFS
  set -f
  IFS=:
  for d in $PEERS_CONFIG_DIRS; do IFS=$_ifs; add_dir "$d"; IFS=:; done
  IFS=$_ifs
  set +f
else
  add_dir "$HOME/.claude"
  add_dir "${CLAUDE_CONFIG_DIR:-}"
  for d in "$HOME"/.claude-*/config "$HOME"/.claude-*; do add_dir "$d"; done
fi

# Socket addresses are printed only for a socket under /tmp/cc-socks* (where Claude Code puts them) that is
# not a symlink and is owned by this user.
SOCK_RE='^(/private)?/tmp/cc-socks[A-Za-z0-9._-]*/[A-Za-z0-9._-]+\.sock$'
squash() { printf '%s' "$1" | tr -s ' \t' '  ' | sed 's/^ //; s/ $//'; }

# Strips C0/C1 controls, ANSI sequences (when jq has regex support), U+061C, U+200B-U+200F, U+2028-U+202E,
# U+2066-U+2069 and U+FEFF. By code point, so the program text stays ASCII.
CLEAN_JQ='def clean: tostring | . as $s | (try gsub("\u001b\\[[0-9;?]*[ -/]*[@-~]"; "") catch $s)
  | explode | map(select((. < 32 or (. >= 127 and . < 160) or . == 1564 or (. >= 8203 and . <= 8207)
      or (. >= 8232 and . <= 8238) or (. >= 8294 and . <= 8297) or . == 65279) | not)) | implode;'

ROWS=""
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  for f in "$dir"/sessions/*.json; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    # A session can exit between the glob and the read: skip a vanished file quietly.
    size=$(wc -c < "$f" 2>/dev/null) || continue
    size=$(printf '%s' "$size" | tr -d ' ')
    [ "$size" -le 65536 ] 2>/dev/null || { echo "peers.sh: skipping oversized $f" >&2; continue; }
    fields=$(jq -rs 'if length == 1 and (.[0] | type) == "object" then .[0] else error("not one object") end
      | [(.pid // "" | tostring), (.procStart // "" | tostring), (.messagingSocketPath // "" | tostring)] | @tsv' \
      < "$f" 2>/dev/null) || { echo "peers.sh: skipping unreadable $f" >&2; continue; }
    pid=${fields%%$'\t'*}
    rest=${fields#*$'\t'}
    proc=${rest%%$'\t'*}
    sock=${rest#*$'\t'}
    case $pid in '' | *[!0-9]*) echo "peers.sh: skipping $f (no numeric pid)" >&2; continue ;; esac

    # procStart is `ps -o lstart` in UTC and the C locale (measured: local ps differs by the UTC offset).
    actual=$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null)
    if [ -z "$actual" ]; then
      state=dead
    elif [ -n "$proc" ] && [ "$(squash "$actual")" = "$(squash "$proc")" ]; then
      state=live
    else
      state=reused
    fi
    [ "$state" = live ] || [ "$ALL" = 1 ] || continue

    addr=""
    if [ "$state" = live ] && printf '%s' "$sock" | grep -Eq "$SOCK_RE" && [ ! -L "$sock" ] && [ -S "$sock" ] &&
      [ -O "$sock" ]; then
      addr="uds:$sock"
    fi

    row=$(jq -c --arg dir "$dir" --arg state "$state" --arg addr "$addr" --argjson pid "$pid" "$CLEAN_JQ"'
      { configDir: $dir,
        name: (.name // "" | clean),
        kind: (.kind // "" | clean),
        status: (.status // "" | clean),
        pid: $pid,
        sessionId: (.sessionId // "" | clean),
        cwd: (.cwd // "" | clean),
        startedAt: (.startedAt | if type == "number" then . else null end),
        procStart: (.procStart // "" | clean),
        state: $state,
        address: (if $addr == "" then null else $addr end) }' < "$f" 2>&1) || {
      echo "peers.sh: skipping $f (cannot render: $(printf '%s' "$row" | head -1))" >&2; continue; }
    ROWS="$ROWS$row$NL"
  done
done <<EOF
$DIRS
EOF

SORTED=$(printf '%s' "$ROWS" | jq -s 'sort_by(.configDir, (.name | ascii_downcase), .pid)')
if [ "$JSON" = 1 ]; then
  printf '%s\n' "$SORTED"
  exit 0
fi
if [ "$SORTED" = "[]" ]; then
  printf 'No sessions found in:\n%s' "${DIRS:-  (no config dir with a sessions/ folder)$NL}" |
    jq -Rr "$CLEAN_JQ"' clean'
  exit 0
fi
printf '%s' "$SORTED" | jq -r --arg home "$HOME" --argjson all "$ALL" "$CLEAN_JQ"'
  def short: if startswith($home + "/") then "~" + .[($home | length):] elif . == $home then "~" else . end;
  def dash: if . == null or . == "" then "-" else tostring end;
  (["CONFIG", "NAME", "KIND", "STATUS", "PID", "CWD", "ADDRESS"] + (if $all == 1 then ["STATE"] else [] end)),
  (.[] | [(.configDir | clean | short), (.name | .[0:48] | dash), (.kind | dash), (.status | dash), (.pid | dash),
          (.cwd | short | dash), (.address | dash)] + (if $all == 1 then [.state] else [] end))
  | @tsv' | column -t -s "$(printf '\t')"
