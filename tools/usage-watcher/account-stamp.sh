#!/bin/bash
# SessionStart hook: record which labelled account a session runs on, for the usage watcher.
#
# Why: two accounts can share one ~/.claude (the second one launched with CLAUDE_CODE_OAUTH_TOKEN), and nothing in a
# session's registry entry, transcript or status-line stamp says which account it is: all of them come from the
# logged-in account in ~/.claude.json (measured 2026-11-03: a token-launched CLI session and the VS Code sessions on
# the token account all stamped the main account's fingerprint). The launcher therefore sets a non-secret label next
# to the token, AIT_ACCOUNT=<label>, and this hook writes it down per session. VS Code sessions never run the status
# line, so this hook is the only thing that covers them; it fires there too (measured: SessionStart in a
# claude-vscode transcript).
#
# What it writes: <state dir>/accounts/<session_id>.json = {"v":1,"label":"<label>","at":<epoch>}, mode 0600, where
# the state dir is $USAGE_WATCHER_DIR or ~/.local/state/usage-watcher (the watcher's output dir). watch.py reads those
# files; a session with no file is the main account. With no (or an invalid) AIT_ACCOUNT the hook writes nothing and
# removes this session's own file, so a session resumed without the label goes back to the main account.
#
# What it never does: read, print or store any credential (it does not look at CLAUDE_CODE_OAUTH_TOKEN or any other
# auth variable), print anything, or fail a session. No set -e; every path exits 0. bash 3.2, jq.
#
# Register it in ~/.claude/settings.json under hooks.SessionStart (no matcher: startup, resume, clear and compact
# all refresh the file), command: the installed path of this file.

command -v jq >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null) || exit 0
sid=$(printf '%s' "$input" | jq -r 'if type == "object" then (.session_id // empty) | strings else empty end' 2>/dev/null)
case $sid in '' | *[!0-9a-fA-F-]*) exit 0 ;; esac
[ "${#sid}" -ge 8 ] && [ "${#sid}" -le 64 ] || exit 0

base="${USAGE_WATCHER_DIR:-$HOME/.local/state/usage-watcher}"
dir="$base/accounts"
file="$dir/$sid.json"

label=${AIT_ACCOUNT:-}
if ! [[ $label =~ ^[a-z0-9][a-z0-9_-]{0,15}$ ]]; then
  [ -L "$dir" ] || { [ -f "$file" ] && [ ! -L "$file" ] && rm -f -- "$file" 2>/dev/null; }
  exit 0
fi

[ -L "$base" ] && exit 0
umask 077
mkdir -p -- "$dir" 2>/dev/null || exit 0
[ -L "$dir" ] && exit 0
tmp=$(mktemp "$dir/.stamp.XXXXXX" 2>/dev/null) || exit 0
if printf '{"v":1,"label":"%s","at":%s}\n' "$label" "$(date +%s)" >"$tmp" 2>/dev/null; then
  mv -f -- "$tmp" "$file" 2>/dev/null || rm -f -- "$tmp" 2>/dev/null
else
  rm -f -- "$tmp" 2>/dev/null
fi
exit 0
