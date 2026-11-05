#!/bin/bash
# Installer tests in a throwaway repo and prefix; nothing outside mktemp dirs is touched.
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   $1"; }
bad() { fail=$((fail+1)); echo "FAIL $1"; }
expect_fail() {  # expect_fail <name> <message fragment> <cmd...>
  local n="$1" frag="$2"; shift 2
  if "$@" >"$T/out" 2>&1; then bad "$n (succeeded)"; elif grep -q -- "$frag" "$T/out"; then ok "$n"; else bad "$n (wrong message)"; cat "$T/out"; fi
}
expect_pass() { local n="$1"; shift; if "$@" >"$T/out" 2>&1; then ok "$n"; else bad "$n"; cat "$T/out"; fi; }
G() { git -C "$R" -c commit.gpgsign=false "$@"; }
sums_at() { G show "$1:tools/callboard/SHA256SUMS" | shasum -a 256 | cut -d' ' -f1; }

R="$T/repo"; mkdir -p "$R/tools"; cp -R "$SRC" "$R/tools/callboard"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
G init -q && G add -A && G commit -q -m t
REF="$(G rev-parse HEAD)"; SS="$(sums_at "$REF")"
I="$R/tools/callboard/install.sh"
export HOME="$T/home"; mkdir -p "$HOME"
P="$T/prefix"
base=(bash "$I" --prefix "$P" --no-sudo)

expect_fail "no target chosen" "choose" bash "$I" --ref "$REF" --sums-sha "$SS"
expect_fail "short ref refused" "40-character" "${base[@]}" --all --ref abc123 --sums-sha "$SS"
expect_fail "missing sums-sha refused" "sums-sha" "${base[@]}" --all --ref "$REF"
expect_fail "unknown commit refused" "not in this repository" "${base[@]}" --all --ref "$(printf '0%.0s' {1..40})" --sums-sha "$SS"
expect_fail "wrong sums-sha refused" "does not match --sums-sha" "${base[@]}" --all --ref "$REF" --sums-sha "$(printf 'a%.0s' {1..64})"
expect_fail "--no-sudo needs a test prefix" "needs a different --prefix" bash "$I" --all --ref "$REF" --sums-sha "$SS" --no-sudo
expect_fail "--lanes needs --lanes-sha" "lanes-sha" "${base[@]}" --all --ref "$REF" --sums-sha "$SS" --lanes /dev/null
expect_fail "custom prefix needs --no-sudo" "needs --no-sudo" bash "$I" --all --ref "$REF" --sums-sha "$SS" --prefix "$P"
expect_pass "dry run succeeds" "${base[@]}" --all --ref "$REF" --sums-sha "$SS"
if [ ! -e "$P" ]; then ok "dry run writes nothing"; else bad "dry run wrote $P"; fi
echo '{"lanes":[]}' > "$T/lanes.json"
expect_pass "terminal install applies" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply --lanes "$T/lanes.json" --lanes-sha "$(shasum -a 256 "$T/lanes.json" | cut -d' ' -f1)"
if [ -f "$P/mod/hooks/register.ts" ] && [ -f "$P/lanes.json" ] && [ -x "$P/claude-callboard" ]; then ok "terminal files placed"; else bad "terminal files missing"; fi
if grep -q "CLAUDE_CODE_PLUGIN_DIRS=$P/mod" "$P/claude-callboard"; then ok "wrapper pins the plugin dir"; else bad "wrapper content"; fi
if [ ! -e "$HOME/.vscode" ]; then ok "terminal-only leaves vscode alone"; else bad "vscode touched"; fi
expect_pass "vscode install applies" "${base[@]}" --vscode --ref "$REF" --sums-sha "$SS" --apply
if [ -f "$HOME/.vscode/extensions/local.callboard-panels-0.1.0/extension.js" ]; then ok "extension placed"; else bad "extension missing"; fi
if [ ! -e "$HOME/.claude" ]; then ok "no ~/.claude change"; else bad "~/.claude touched"; fi
SP="$T/pre fix"
expect_pass "spaced prefix installs" bash "$I" --prefix "$SP" --no-sudo --all --ref "$REF" --sums-sha "$SS" --apply
if bash -n "$SP/claude-callboard" && grep -qF "CLAUDE_CODE_PLUGIN_DIRS=$(printf '%q' "$SP/mod") " "$SP/claude-callboard"; then ok "spaced prefix is quoted in the wrapper"; else bad "spaced prefix wrapper"; fi
if [ ! -e "$P/code-callboard" ] && [ ! -e "$SP/code-callboard" ]; then ok "no VS Code launcher installed"; else bad "code-callboard installed"; fi
expect_fail "wrong lanes-sha refused" "does not match --lanes-sha" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply --lanes "$T/lanes.json" --lanes-sha "$(printf 'c%.0s' {1..64})"
expect_fail "invalid lanes json refused" "lanes-json" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply --lanes "$SRC/SHA256SUMS" --lanes-sha "$(shasum -a 256 "$SRC/SHA256SUMS" | cut -d' ' -f1)"
lanes_case() { printf '%s\n' "$2" > "$T/$1.json"; LF="$T/$1.json"; LS="$(shasum -a 256 "$LF" | cut -d' ' -f1)"; }
lanes_case reserved '{"lanes":[{"name":"MANAGER_","folder":"/w","brief":"/w/B.md"}]}'
expect_fail "reserved lane name refused by the mod's check" "rejected by the mod's own check: lane-name" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --lanes "$LF" --lanes-sha "$LS"
lanes_case dup '{"lanes":[{"name":"API","folder":"/w","brief":"/w/B.md"},{"name":"API","folder":"/v","brief":"/v/B.md"}]}'
expect_fail "duplicate lane refused by the mod's check" "rejected by the mod's own check: lane-dup" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --lanes "$LF" --lanes-sha "$LS"
lanes_case one '{"lanes":[{"name":"API","folder":"/w","brief":"/w/B.md"}]}'
expect_pass "one valid lane passes the mod's check" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --lanes "$LF" --lanes-sha "$LS"
expect_fail "--lanes without node on PATH refused" "needs node" env PATH=/usr/bin:/bin "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --lanes "$LF" --lanes-sha "$LS"
lanes_case reserved '{"lanes":[{"name":"MANAGER_","folder":"/w","brief":"/w/B.md"}]}'
rm -rf "$P"
expect_fail "rejected lanes with --apply" "lane-name" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply --lanes "$LF" --lanes-sha "$LS"
if [ ! -e "$P" ]; then ok "rejected lanes install nothing"; else bad "rejected lanes left $P"; fi

echo "// tampered" >> "$R/tools/callboard/mod/hooks/core.ts"
rm -rf "$P"
expect_pass "uncommitted edits in the checkout are ignored" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply
if ! grep -q tampered "$P/mod/hooks/core.ts"; then ok "installed content comes from the commit"; else bad "working tree content installed"; fi
G add -A && G commit -q -m tamper
REF2="$(G rev-parse HEAD)"; SS2="$(sums_at "$REF2")"
expect_fail "committed file not matching SHA256SUMS refused" "differ from SHA256SUMS" "${base[@]}" --all --ref "$REF2" --sums-sha "$SS2" --apply --prefix "$T/p2"
if [ ! -e "$T/p2" ]; then ok "refusal happens before any copy"; else bad "copied before verify"; fi

printf '%s  mod/../../escape\n' "$(printf 'b%.0s' {1..64})" > "$R/tools/callboard/SHA256SUMS"
G add -A && G commit -q -m traversal
REF3="$(G rev-parse HEAD)"; SS3="$(sums_at "$REF3")"
expect_fail "path traversal in SHA256SUMS refused" "bad path" "${base[@]}" --all --ref "$REF3" --sums-sha "$SS3" --apply --prefix "$T/p3"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
