#!/bin/bash
# Installer tests against local bare fixture repositories and a throwaway prefix; nothing outside mktemp dirs is touched
# and nothing goes on the network.
# The source URL of install.sh is a constant with no override. To fetch offline, the tests run a COPY of install.sh in
# which exactly two lines differ, ORIGIN_URL (a file:// fixture) and ORIGIN_PROTO (file); the test checks that the copy
# differs in those two lines and nothing else, so every other line under test is the shipped one.
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd -P)"
T="$(mktemp -d)"; T="$(cd "$T" && pwd -P)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   $1"; }
bad() { fail=$((fail+1)); echo "FAIL $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', want '$2')"; fi; }
expect_fail() {  # expect_fail <name> <message fragment> <cmd...>
  local n="$1" frag="$2"; shift 2
  if "$@" >"$T/out" 2>&1; then bad "$n (succeeded)"; elif grep -q -- "$frag" "$T/out"; then ok "$n"; else bad "$n (wrong message)"; cat "$T/out"; fi
}
expect_pass() { local n="$1"; shift; if "$@" >"$T/out" 2>&1; then ok "$n"; else bad "$n"; cat "$T/out"; fi; }
in_dir() { (cd "$1" && shift && "$@"); }

# The fixtures' own git: no user or system config (no signing, no hooks), fixed identity.
tg() {
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$T/githome" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=fixture \
    GIT_COMMITTER_EMAIL=fixture@example.invalid /usr/bin/git -c init.defaultBranch=main "$@"
}
mkdir -p "$T/githome"

# --- fixtures: origin.git (main holds the callboard files), evil.git (the same files, one changed) ------------------
W="$T/wt"; mkdir -p "$W/tools"; cp -R "$SRC" "$W/tools/callboard"
# A shipped file committed executable (100755): the staged and installed copies must still be 0644.
chmod 0755 "$W/tools/callboard/mod/hooks/core.ts"
tg init -q "$W" && tg -C "$W" add -A && tg -C "$W" commit -q -m fixture
tg clone -q --bare "$W" "$T/origin.git"
push() { tg -C "$W" push -q "$T/origin.git" "${1:-main}"; }
sums_at() { tg --git-dir="$T/origin.git" show "$1:tools/callboard/SHA256SUMS" | shasum -a 256 | cut -d' ' -f1; }
REF="$(tg -C "$W" rev-parse HEAD)"; SS="$(sums_at "$REF")"
tg clone -q "$W" "$T/wt-evil"
echo "// evil-marker" >> "$T/wt-evil/tools/callboard/mod/hooks/core.ts"
tg -C "$T/wt-evil" commit -q -am evil
tg clone -q --bare "$T/wt-evil" "$T/evil.git"
# A commit that reaches origin.git on another branch, never on main.
tg -C "$W" checkout -q -b side
echo "// side" >> "$W/tools/callboard/mod/hooks/core.ts"
tg -C "$W" commit -q -am side
SIDE="$(tg -C "$W" rev-parse HEAD)"
push side
tg -C "$W" checkout -q main

# --- the copy under test, in a checkout of the fixture (the way a person runs it) ------------------------------------
CO="$T/co"
tg clone -q "$T/origin.git" "$CO"
I="$CO/tools/callboard/install.sh"
sed -e "s|^readonly ORIGIN_URL=.*|readonly ORIGIN_URL='file://$T/origin.git'|" \
  -e "s|^readonly ORIGIN_PROTO=.*|readonly ORIGIN_PROTO='file'|" "$SRC/install.sh" > "$I"
d="$(diff "$SRC/install.sh" "$I" | grep '^[<>]' || true)"
check "$(printf '%s\n' "$d" | wc -l | tr -d ' ')" 4 "the copy differs from install.sh in exactly two lines"
case "$d" in *ORIGIN_URL*ORIGIN_PROTO*ORIGIN_URL*ORIGIN_PROTO*) ok "the copy changes only ORIGIN_URL and ORIGIN_PROTO" ;; *) bad "the copy changes other lines" ;; esac

# --- static: the URL is a constant and the checkout is never read ----------------------------------------------------
check "$(grep -c "^readonly ORIGIN_URL='https://github.com/notitial/ai-manager.git'$" "$SRC/install.sh")" 1 "install.sh pins the HTTPS URL once"
check "$(grep -c "^readonly ORIGIN_PROTO='https'$" "$SRC/install.sh")" 1 "install.sh pins the https transport"
check "$(grep -c 'ORIGIN_URL=' "$SRC/install.sh")" 1 "ORIGIN_URL is assigned once"
check "$(grep -c 'ORIGIN_PROTO=' "$SRC/install.sh")" 1 "ORIGIN_PROTO is assigned once"
check "$(grep -v '^[[:space:]]*#' "$SRC/install.sh" | grep -c '/usr/bin/git' || true)" 1 "git runs only inside hgit"
check "$(grep -cE -- '-C "\$(HERE|TOP)"|rev-parse --show-|\$\{?GIT\}?([^_A-Za-z]|$)' "$SRC/install.sh" || true)" 0 "no git call runs in the checkout"
check "$(grep -E '_proto=' "$SRC/install.sh" | grep -vcE '_proto=(none|\$ORIGIN_PROTO)$|local main _proto=none ' || true)" 0 "_proto is set only to none or ORIGIN_PROTO"
check "$(grep -v '^[[:space:]]*#' "$SRC/install.sh" | grep -cE '/usr/bin/tar|\.tar|archive' || true)" 0 "root unpacks no archive"
# The first rr call outside a function body comes after the fetch: no sudo before the source is fetched and checked.
first_rr="$(awk '/^[a-z_]+\(\) \{$/ { infn = 1; next } infn && /^\}$/ { infn = 0; next } infn { next } /^[a-z_]+\(\) \{.*\}$/ { next } /^[[:space:]]*#/ { next } /(^|[^a-z_])rr / { print NR; exit }' "$SRC/install.sh")"
fetch_line="$(grep -n '^fetch_source$' "$SRC/install.sh" | cut -d: -f1)"
if [ -n "$first_rr" ] && [ -n "$fetch_line" ] && [ "$fetch_line" -lt "$first_rr" ]; then ok "fetch_source runs before the first rr call"; else bad "fetch_source ($fetch_line) is not before the first rr call ($first_rr)"; fi
# The sudo branch expects a root-owned 0700 staging folder and sweeps it for anything not owned by root.
sudo_branch="$(awk '/^if \[ "\$APPLY" = 1 \] && \[ "\$NO_SUDO" = 0 \]; then$/ { f = 1; next } f && /^else$/ { exit } f' "$SRC/install.sh")"
case "$sudo_branch" in *'rr /usr/bin/mktemp -d /private/tmp/'*'STAGE_WANT="0 700"'*'STAGE_OWNER=root:wheel'*) ok "the sudo branch expects a root-owned 0700 staging folder" ;; *) bad "the sudo branch: $sudo_branch" ;; esac
check "$(grep -cF '[ -z "$(rr /usr/bin/find "$STAGE" ! -user root)" ]' "$SRC/install.sh")" 1 "the staging folder is swept for entries not owned by root"
check "$(grep -cF 'rr /usr/sbin/chown -R -h "$STAGE_OWNER" "$STAGE"' "$SRC/install.sh")" 1 "the staged files get root:wheel without following links"

export HOME="$T/home" TMPDIR="$T/tmp"; mkdir -p "$HOME" "$TMPDIR"
P="$T/prefix"
base=(bash "$I" --prefix "$P" --no-sudo)

expect_fail "no target chosen" "choose" bash "$I" --ref "$REF" --sums-sha "$SS"
expect_fail "short ref refused" "40-character" "${base[@]}" --all --ref abc123 --sums-sha "$SS"
expect_fail "missing sums-sha refused" "sums-sha" "${base[@]}" --all --ref "$REF"
expect_fail "unknown commit refused" "is not on main" "${base[@]}" --all --ref "$(printf '0%.0s' {1..40})" --sums-sha "$SS"
expect_fail "commit not on main refused" "is not on main" "${base[@]}" --all --ref "$SIDE" --sums-sha "$SS" --apply
if [ ! -e "$P" ]; then ok "refused ref installs nothing"; else bad "refused ref wrote $P"; fi
expect_fail "wrong sums-sha refused" "does not match --sums-sha" "${base[@]}" --all --ref "$REF" --sums-sha "$(printf 'a%.0s' {1..64})"
expect_fail "--no-sudo needs a test prefix" "needs a different --prefix" bash "$I" --all --ref "$REF" --sums-sha "$SS" --no-sudo
expect_fail "--lanes needs --lanes-sha" "lanes-sha" "${base[@]}" --all --ref "$REF" --sums-sha "$SS" --lanes /dev/null
expect_fail "custom prefix needs --no-sudo" "needs --no-sudo" bash "$I" --all --ref "$REF" --sums-sha "$SS" --prefix "$P"
expect_fail "fetch failure fails closed" "fetching main from" bash -c 'sed "s|origin\.git|missing.git|" "$1" > "$2" && bash "$2" --prefix "$3" --no-sudo --all --ref "$4" --sums-sha "$5" --apply' _ "$I" "$CO/tools/callboard/install-missing.sh" "$P" "$REF" "$SS"
if [ ! -e "$P" ]; then ok "a failed fetch installs nothing"; else bad "failed fetch wrote $P"; fi
rm -f "$CO/tools/callboard/install-missing.sh"
expect_pass "dry run succeeds" "${base[@]}" --all --ref "$REF" --sums-sha "$SS"
if grep -q "source: file://$T/origin.git, commit $REF (on main" "$T/out"; then ok "dry run names the fixed source"; else bad "dry run source line"; cat "$T/out"; fi
if [ ! -e "$P" ]; then ok "dry run writes nothing"; else bad "dry run wrote $P"; fi
echo '{"lanes":[]}' > "$T/lanes.json"
expect_pass "terminal install applies" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply --lanes "$T/lanes.json" --lanes-sha "$(shasum -a 256 "$T/lanes.json" | cut -d' ' -f1)"
if [ -f "$P/mod/hooks/register.ts" ] && [ -f "$P/lanes.json" ] && [ -x "$P/claude-callboard" ]; then ok "terminal files placed"; else bad "terminal files missing"; fi
if grep -q "CLAUDE_CODE_PLUGIN_DIRS=$P/mod" "$P/claude-callboard"; then ok "wrapper pins the plugin dir"; else bad "wrapper content"; fi
if [ ! -e "$HOME/.vscode" ]; then ok "terminal-only leaves vscode alone"; else bad "vscode touched"; fi
if [ -z "$(find "$P" -type f ! -name claude-callboard ! -perm 0644)" ] && [ -z "$(find "$P" -type d ! -perm 0755)" ] && [ "$(stat -f %Lp "$P/claude-callboard")" = 755 ] && [ -z "$(find "$P" -perm +7022)" ]; then ok "installed files 0644, folders and the wrapper 0755, nothing setuid or writable by others"; else bad "installed modes"; find "$P" -exec stat -f '%Sp %N' {} +; fi
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
# The staged tree, seen from inside the run: a stand-in node (the --lanes check runs it after staging) records the
# modes of the staging directory (without sudo it sits in the run's temporary folder under TMPDIR), then answers ok.
mkdir -p "$T/fakenode"
cat > "$T/fakenode/node" <<EOF
#!/bin/bash
for d in "$T/tmp"/callboard-install.*/stage.*; do
  [ -d "\$d/mod" ] || continue
  { stat -f '%Lp %u' "\$d"; find "\$d" -mindepth 1 -type d ! -perm 0755; find "\$d" -type f ! -name lanes.json ! -perm 0644; find "\$d" -perm +7022; find "\$d" -type f -links +1; } > "$T/stage-report"
done
cat > /dev/null
printf ok
EOF
chmod 0755 "$T/fakenode/node"
expect_pass "a run with the stand-in node passes" env PATH="$T/fakenode:/usr/bin:/bin" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --lanes "$LF" --lanes-sha "$LS"
check "$(cat "$T/stage-report" 2>/dev/null)" "700 $(id -u)" "staged: the folder is 0700, every file 0644 (core.ts was committed 100755), every subfolder 0755, nothing setuid, writable by others or hard-linked"
expect_fail "--lanes without node on PATH refused" "needs node" env PATH=/usr/bin:/bin "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --lanes "$LF" --lanes-sha "$LS"
lanes_case reserved '{"lanes":[{"name":"MANAGER_","folder":"/w","brief":"/w/B.md"}]}'
rm -rf "$P"
expect_fail "rejected lanes with --apply" "lane-name" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply --lanes "$LF" --lanes-sha "$LS"
if [ ! -e "$P" ]; then ok "rejected lanes install nothing"; else bad "rejected lanes left $P"; fi

ORIG_CORE="$T/core.orig"; tg --git-dir="$T/origin.git" show "$REF:tools/callboard/mod/hooks/core.ts" > "$ORIG_CORE"
echo "// tampered" >> "$CO/tools/callboard/mod/hooks/core.ts"
rm -rf "$P"
expect_pass "uncommitted edits in the checkout are ignored" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply
if cmp -s "$ORIG_CORE" "$P/mod/hooks/core.ts"; then ok "installed content comes from the fetched commit"; else bad "checkout content installed"; fi

# --- a hostile checkout config does nothing --------------------------------------------------------------------------
# insteadOf to evil.git, a hooks path and a filter driver whose command writes a marker, all in the checkout's .git.
mkdir -p "$T/evilhooks"
for h in reference-transaction post-checkout pre-auto-gc; do printf '#!/bin/sh\ntouch "%s/MARKER"\n' "$T" > "$T/evilhooks/$h"; chmod 0755 "$T/evilhooks/$h"; done
tg -C "$CO" config "url.file://$T/evil.git.insteadOf" "file://$T/origin.git"
tg -C "$CO" config --add "url.file://$T/evil.git.insteadOf" "https://github.com/notitial/ai-manager.git"
tg -C "$CO" config core.hooksPath "$T/evilhooks"
tg -C "$CO" config filter.evil.smudge "touch '$T/MARKER'; cat"
tg -C "$CO" config filter.evil.clean "touch '$T/MARKER'; cat"
echo '* filter=evil' > "$CO/.git/info/attributes"
# Control: the hostile config works on a plain git archive in the checkout (else the checks below prove nothing).
tg -C "$CO" archive "$REF:tools/callboard" > /dev/null 2>&1 || true
if [ -e "$T/MARKER" ]; then ok "control: the checkout's filter runs under a plain git archive"; else bad "control: the checkout's filter did not run"; fi
rm -f "$T/MARKER"
rm -rf "$P"
expect_pass "install from a hostile checkout succeeds" in_dir "$CO" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply
if cmp -s "$ORIG_CORE" "$P/mod/hooks/core.ts"; then ok "hostile checkout: the fixture's bytes are installed"; else bad "hostile checkout: wrong bytes installed"; fi
if ! grep -q evil "$T/out"; then ok "hostile checkout: evil.git is never named"; else bad "hostile checkout: evil.git named"; cat "$T/out"; fi
if [ ! -e "$T/MARKER" ]; then ok "hostile checkout: no filter or hook ran"; else bad "hostile checkout: the marker exists"; fi

# --- a GIT_CONFIG_COUNT redirect in the caller's environment is ignored ----------------------------------------------
REDIRECT=(GIT_CONFIG_COUNT=1 "GIT_CONFIG_KEY_0=url.file://$T/evil.git.insteadOf" "GIT_CONFIG_VALUE_0=file://$T/origin.git")
ctl="$(env -i PATH=/usr/bin:/bin HOME="$T/githome" "${REDIRECT[@]}" /usr/bin/git ls-remote "file://$T/origin.git" refs/heads/main 2>/dev/null | cut -f1 || true)"
check "$ctl" "$(tg --git-dir="$T/evil.git" rev-parse main)" "control: the GIT_CONFIG_COUNT redirect reroutes a plain git"
rm -rf "$P"
expect_pass "install with a GIT_CONFIG_COUNT redirect succeeds" env "${REDIRECT[@]}" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply
if cmp -s "$ORIG_CORE" "$P/mod/hooks/core.ts"; then ok "env redirect: the fixture's bytes are installed"; else bad "env redirect: wrong bytes installed"; fi
if ! grep -q evil "$T/out"; then ok "env redirect: evil.git is never named"; else bad "env redirect: evil.git named"; cat "$T/out"; fi

# --- a hostile ~/.gitconfig and XDG config, and a GIT_EXEC_PATH with fake helpers, are ignored --------------------
EVIL_MAIN="$(tg --git-dir="$T/evil.git" rev-parse main)"
EH="$T/evilhome"; mkdir -p "$EH" "$T/evilxdg/git" "$T/evilexec"
printf '[url "file://%s/evil.git"]\n\tinsteadOf = file://%s/origin.git\n' "$T" "$T" > "$EH/.gitconfig"
cp "$EH/.gitconfig" "$T/evilxdg/git/config"
for h in git-upload-pack git-remote-file; do printf '#!/bin/sh\ntouch "%s/EXEC-MARKER"\nexit 1\n' "$T" > "$T/evilexec/$h"; chmod 0755 "$T/evilexec/$h"; done
ctl="$(env -i PATH=/usr/bin:/bin HOME="$EH" /usr/bin/git ls-remote "file://$T/origin.git" refs/heads/main 2>/dev/null | cut -f1 || true)"
check "$ctl" "$EVIL_MAIN" "control: the hostile ~/.gitconfig reroutes a plain git"
ctl="$(env -i PATH=/usr/bin:/bin HOME="$T/githome" XDG_CONFIG_HOME="$T/evilxdg" /usr/bin/git ls-remote "file://$T/origin.git" refs/heads/main 2>/dev/null | cut -f1 || true)"
check "$ctl" "$EVIL_MAIN" "control: the hostile XDG config reroutes a plain git"
env -i PATH=/usr/bin:/bin HOME="$T/githome" GIT_EXEC_PATH="$T/evilexec" /usr/bin/git ls-remote "file://$T/origin.git" > /dev/null 2>&1 || true
if [ -e "$T/EXEC-MARKER" ]; then ok "control: the fake helper in GIT_EXEC_PATH runs under a plain git"; else bad "control: the fake helper did not run"; fi
rm -f "$T/EXEC-MARKER"
rm -rf "$P"
expect_pass "install with a hostile home, XDG config and GIT_EXEC_PATH succeeds" env HOME="$EH" XDG_CONFIG_HOME="$T/evilxdg" GIT_EXEC_PATH="$T/evilexec" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply
if cmp -s "$ORIG_CORE" "$P/mod/hooks/core.ts"; then ok "hostile home: the fixture's bytes are installed"; else bad "hostile home: wrong bytes installed"; fi
if ! grep -q evil "$T/out"; then ok "hostile home: evil.git is never named"; else bad "hostile home: evil.git named"; cat "$T/out"; fi
if [ ! -e "$T/EXEC-MARKER" ]; then ok "hostile GIT_EXEC_PATH: no fake helper ran"; else bad "hostile GIT_EXEC_PATH: the marker exists"; fi

expect_fail "a relative TMPDIR is refused" "TMPDIR must be an absolute path" env TMPDIR=relative/tmp "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS"

# --- commits on main that the sums refuse ----------------------------------------------------------------------------
echo "// tampered" >> "$W/tools/callboard/mod/hooks/core.ts"
tg -C "$W" commit -q -am tamper && push
REF2="$(tg -C "$W" rev-parse HEAD)"; SS2="$(sums_at "$REF2")"
expect_fail "committed file not matching SHA256SUMS refused" "differ from SHA256SUMS" "${base[@]}" --all --ref "$REF2" --sums-sha "$SS2" --apply --prefix "$T/p2"
if [ ! -e "$T/p2" ]; then ok "refusal happens before any copy"; else bad "copied before verify"; fi

printf '%s  mod/../../escape\n' "$(printf 'b%.0s' {1..64})" > "$W/tools/callboard/SHA256SUMS"
tg -C "$W" commit -q -am traversal && push
REF3="$(tg -C "$W" rev-parse HEAD)"; SS3="$(sums_at "$REF3")"
expect_fail "path traversal in SHA256SUMS refused" "bad path" "${base[@]}" --all --ref "$REF3" --sums-sha "$SS3" --apply --prefix "$T/p3"
{ cat "$SRC/SHA256SUMS"; head -n 1 "$SRC/SHA256SUMS"; } > "$W/tools/callboard/SHA256SUMS"
tg -C "$W" commit -q -am duplicate && push
REF4="$(tg -C "$W" rev-parse HEAD)"; SS4="$(sums_at "$REF4")"
expect_fail "a path listed twice in SHA256SUMS refused" "lists a path twice" "${base[@]}" --all --ref "$REF4" --sums-sha "$SS4" --apply --prefix "$T/p4"

cp "$SRC/SHA256SUMS" "$W/tools/callboard/SHA256SUMS"
printf '%s  mod/hooks/link.ts\n' "$(printf 'b%.0s' {1..64})" >> "$W/tools/callboard/SHA256SUMS"
ln -s core.ts "$W/tools/callboard/mod/hooks/link.ts"
tg -C "$W" add -A && tg -C "$W" commit -q -m symlink && push
REF5="$(tg -C "$W" rev-parse HEAD)"; SS5="$(sums_at "$REF5")"
check "$(tg --git-dir="$T/origin.git" ls-tree "$REF5" -- tools/callboard/mod/hooks/link.ts | cut -d' ' -f1)" 120000 "the fixture commits link.ts as a symlink"
expect_fail "a listed path that is a symlink refused" "is not a regular file" "${base[@]}" --all --ref "$REF5" --sums-sha "$SS5" --apply --prefix "$T/p5"
if [ ! -e "$T/p4" ] && [ ! -e "$T/p5" ]; then ok "those refusals install nothing"; else bad "a refused commit installed something"; fi

head -c 1048577 /dev/zero | tr '\0' ' ' > "$T/big.json"
expect_fail "a --lanes file over 1 MiB refused" "over 1 MiB" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --lanes "$T/big.json" --lanes-sha "$(shasum -a 256 "$T/big.json" | cut -d' ' -f1)"
expect_fail "a --lanes that is not a regular file refused" "not a regular file" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --lanes /dev/null --lanes-sha "$(printf 'd%.0s' {1..64})"
expect_pass "an older commit on main still installs" "${base[@]}" --terminal --ref "$REF" --sums-sha "$SS" --apply

check "$(ls -A "$TMPDIR" | grep -c '^callboard-install\.' || true)" 0 "no temporary repository left behind"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
