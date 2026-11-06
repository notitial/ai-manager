#!/bin/bash
# Tests for tools/usage-watcher/install.sh. Fully sandboxed: a fake HOME, stub `launchctl` and `id` first on PATH (the
# stub launchctl records its arguments and keeps its "loaded" state in the sandbox), local bare fixture repositories
# with their own committed fixture files, TMPDIR inside the sandbox, no network. The real ~/Library/LaunchAgents,
# launchctl and home are never touched.
#
# The source URL of install.sh is a constant with no override. To fetch offline, the tests run a COPY of install.sh in
# which exactly two lines differ, ORIGIN_URL (a file:// fixture) and ORIGIN_PROTO (file); the test checks that the copy
# differs in those two lines and nothing else, so every other line under test is the shipped one.
#
#   bash tools/usage-watcher/test-install.sh
#
# Needs macOS (plutil, the Command Line Tools) and /usr/bin/python3 3.9 or later. Exit 0 when every check passes.

set -euo pipefail
umask 077

HERE=$(cd "$(dirname "$0")" && pwd -P)
SRC=$HERE/install.sh
[ -f "$SRC" ] || { echo "no install.sh beside this test" >&2; exit 2; }
[ "$(/usr/bin/uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 2; }

T=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/uw-install-test.XXXXXX")
T=$(cd "$T" && pwd -P)
trap '/bin/rm -rf -- "$T"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$*"; }
check() { if [ "$1" = "$2" ]; then ok; else bad "$3 (got '$1', want '$2')"; fi; }
has() { case $2 in *"$3"*) ok ;; *) bad "$1: output lacks '$3'"; printf '%s\n' "$2" | /usr/bin/sed 's/^/    | /' ;; esac; }
lacks() { case $2 in *"$3"*) bad "$1: output has '$3'" ;; *) ok ;; esac; }

# The fixtures' own git: no user or system config (no signing, no hooks), fixed identity.
tg() {
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$T/githome" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=fixture \
    GIT_COMMITTER_EMAIL=fixture@example.invalid /usr/bin/git -c init.defaultBranch=main "$@"
}

LABEL=io.notitial.usage-watcher
/bin/mkdir -p "$T/githome" "$T/tmp" "$T/stub" "$T/ld" "$T/cwd"
: >"$T/launchctl.log"

# --- fixtures --------------------------------------------------------------------------------------------------------

# write_tree <work tree> <tag> <test exit code>: the fixture files. A tag named extrakey* adds an EnvironmentVariables
# key to the plist template, extraarg* a sixth program argument; the installer must refuse both.
write_tree() {
  local d=$1/tools/usage-watcher extra_key='' extra_arg=''
  case $2 in
    extrakey*) extra_key='<key>EnvironmentVariables</key><dict><key>PYTHONPATH</key><string>/tmp/x</string></dict>' ;;
    extraarg*) extra_arg='<string>--cache-ctx-min</string>' ;;
  esac
  /bin/mkdir -p "$d"
  printf '# fixture watch.py %s\nprint("fixture %s")\n' "$2" "$2" >"$d/watch.py"
  printf 'import sys\nsys.exit(%s)\n' "$3" >"$d/test_watch.py"
  /bin/cat >"$d/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>io.notitial.usage-watcher</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/python3</string>
		<string>-I</string>
		<string>__HOME__/.local/share/usage-watcher/watch.py</string>
		<string>--config-dir</string>
		<string>__CONFIG_DIR__</string>
		${extra_arg}
	</array>
	${extra_key}
	<key>StartInterval</key>
	<integer>300</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>/dev/null</string>
	<key>StandardErrorPath</key>
	<string>/dev/null</string>
</dict>
</plist>
EOF
}

# make_origin <name> <tag...>: a bare repository whose main has one commit per tag (the tests of a tag named bad* fail).
make_origin() {
  local name=$1 wt=$T/wt-$1 tag rc
  shift
  tg init -q "$wt"
  for tag in "$@"; do
    case $tag in bad*) rc=1 ;; *) rc=0 ;; esac
    write_tree "$wt" "$tag" "$rc"
    tg -C "$wt" add -A
    tg -C "$wt" commit -q -m "$tag"
    tg -C "$wt" tag "$tag"
  done
  tg clone -q --bare "$wt" "$T/$name.git"
}
make_origin origin v1 v2
make_origin evil evil
make_origin badtests badtests
make_origin extrakey extrakey
make_origin extraarg extraarg
# The repo's real template, committed as is, so a change to it that the installer's allowlist refuses fails here.
[ -f "$HERE/$LABEL.plist" ] || { echo "no $LABEL.plist beside this test" >&2; exit 2; }
make_origin real real
/bin/cp "$HERE/$LABEL.plist" "$T/wt-real/tools/usage-watcher/$LABEL.plist"
tg -C "$T/wt-real" add -A
tg -C "$T/wt-real" commit -q --allow-empty -m "real template"
tg -C "$T/wt-real" push -q "$T/real.git" main
V1=$(tg -C "$T/wt-origin" rev-parse v1)
V2=$(tg -C "$T/wt-origin" rev-parse v2)
EVIL=$(tg -C "$T/wt-evil" rev-parse evil)

# --- stubs -----------------------------------------------------------------------------------------------------------

# id -u is 4242, or the content of fake-uid when present. bootstrap fails while fail-bootstrap exists.
/bin/cat >"$T/stub/id" <<EOF
#!/bin/bash
if [ "\${1:-}" = -u ]; then
  if [ -f '$T/fake-uid' ]; then /bin/cat '$T/fake-uid'; else echo 4242; fi
else
  exec /usr/bin/id "\$@"
fi
EOF
/bin/cat >"$T/stub/launchctl" <<EOF
#!/bin/bash
st='$T/ld'
printf '%s\n' "\$*" >>'$T/launchctl.log'
case \${1:-} in
  print)
    [ -f "\$st/\$2.plist" ] || { echo "Could not find service \"\$2\"" >&2; exit 113; }
    echo "\$2 = {"
    echo "	arguments = {"
    i=0
    while a=\$(/usr/bin/plutil -extract "ProgramArguments.\$i" raw -o - "\$st/\$2.plist" 2>/dev/null); do
      echo "		\$a"
      i=\$((i + 1))
    done
    echo "	}"
    echo "	last exit code = 0"
    echo "}"
    ;;
  bootstrap)
    [ -f '$T/fail-bootstrap' ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    l=\$(/usr/bin/plutil -extract Label raw -o - "\$3" 2>/dev/null) || exit 5
    /bin/mkdir -p "\$st/\$2" && /bin/cp "\$3" "\$st/\$2/\$l.plist"
    ;;
  bootout)
    [ -f "\$st/\$2.plist" ] || exit 3
    /bin/rm -f "\$st/\$2.plist"
    ;;
  *) exit 64 ;;
esac
EOF
/bin/chmod 0755 "$T/stub/id" "$T/stub/launchctl"
SPATH="$T/stub:/usr/bin:/bin"
check "$(/usr/bin/env -i PATH="$SPATH" /bin/bash -c 'command -v launchctl')" "$T/stub/launchctl" "launchctl resolves to the stub"
check "$(/usr/bin/env -i PATH="$SPATH" /bin/bash -c 'command -v id')" "$T/stub/id" "id resolves to the stub"
[ "$FAIL" = 0 ] || { echo "stubs not first on PATH; refusing to run the installer" >&2; exit 1; }

# --- the copies under test -------------------------------------------------------------------------------------------

# make_copy <dest> <bare repository>: install.sh with only ORIGIN_URL and ORIGIN_PROTO changed (checked).
make_copy() {
  /bin/mkdir -p "$(dirname "$1")"
  /usr/bin/sed -e "s|^readonly ORIGIN_URL=.*|readonly ORIGIN_URL='file://$2'|" \
    -e "s|^readonly ORIGIN_PROTO=.*|readonly ORIGIN_PROTO='file'|" "$SRC" >"$1"
  /bin/chmod 0755 "$1"
  local d
  d=$(/usr/bin/diff "$SRC" "$1" | /usr/bin/grep '^[<>]' || true)
  check "$(printf '%s\n' "$d" | /usr/bin/wc -l | /usr/bin/tr -d ' ')" 4 "copy $1 differs from install.sh in exactly two lines"
  case $d in *ORIGIN_URL*ORIGIN_PROTO*ORIGIN_URL*ORIGIN_PROTO*) ok ;; *) bad "copy $1 changes lines other than ORIGIN_URL and ORIGIN_PROTO" ;; esac
}
INST=$T/bin/install.sh
make_copy "$INST" "$T/origin.git"
make_copy "$T/bin-bad/install.sh" "$T/badtests.git"

# run [NAME=value...] -- <home> <script> [args...]: sets OUT (stdout and stderr) and RC. Runs from $CWD.
CWD=$T/cwd
run() {
  local envs=()
  while [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  local h=$1 s=$2
  shift 2
  OUT=$(cd "$CWD" && /usr/bin/env -i PATH="$SPATH" HOME="$h" TMPDIR="$T/tmp" ${envs[@]+"${envs[@]}"} /bin/bash "$s" "$@" 2>&1) && RC=0 || RC=$?
}

new_home() {
  /bin/mkdir -m 0700 "$1" "$1/Library" "$1/.claude"
  printf '{"hooks": {}}\n' >"$1/.claude/settings.json"
}
snap() { (cd "$1" && /usr/bin/find . -print0 | /usr/bin/xargs -0 /usr/bin/stat -f '%N %Lp %z %m %i' | LC_ALL=C /usr/bin/sort); }
lc_count() { /usr/bin/awk -v p="$1" '$0 == p || index($0, p " ") == 1 { n++ } END { print n + 0 }' "$T/launchctl.log"; }
tmp_left() { /bin/ls -A "$T/tmp" | /usr/bin/grep -c '^uw-install\.' || true; }

# --- static: the URL is a constant -----------------------------------------------------------------------------------

check "$(/usr/bin/grep -c "^readonly ORIGIN_URL='https://github.com/notitial/ai-manager.git'$" "$SRC")" 1 "install.sh pins the HTTPS URL"
check "$(/usr/bin/grep -c "^readonly ORIGIN_PROTO='https'$" "$SRC")" 1 "install.sh pins the https transport"
check "$(/usr/bin/grep -c 'ORIGIN_URL=' "$SRC")" 1 "ORIGIN_URL is assigned once"
check "$(/usr/bin/grep -c 'ORIGIN_PROTO=' "$SRC")" 1 "ORIGIN_PROTO is assigned once"
check "$(/usr/bin/grep -v '^[[:space:]]*#' "$SRC" | /usr/bin/grep -cE '(^|[^_[:alnum:]])eval([^_[:alnum:]]|$)' || true)" 0 "install.sh has no eval"
check "$(/usr/bin/grep -E '_proto=' "$SRC" | /usr/bin/grep -vcE '_proto=(none|\$ORIGIN_PROTO)$|local main _proto=none$' || true)" 0 "_proto is set only to none or ORIGIN_PROTO"

# --- usage errors ----------------------------------------------------------------------------------------------------

H=$T/home
new_home "$H"
SETTINGS_SUM=$(/usr/bin/shasum -a 256 "$H/.claude/settings.json")
before=$(snap "$H")
for args in "--ref main" "--ref abc" "--ref $(printf '%s' "$V1" | /usr/bin/tr a-f A-F)" "--ref ${V1}0" "--ref" "--ref= " \
  "--status --apply" "--uninstall --ref $V1" "--status --uninstall" "--bogus"; do
  # shellcheck disable=SC2086 # split on purpose: each string is an argument list
  run -- "$H" "$INST" $args
  check "$RC" 2 "usage error for '$args'"
done
check "$(snap "$H")" "$before" "usage errors change nothing"

# --- dry run ---------------------------------------------------------------------------------------------------------

run -- "$H" "$INST"
check "$RC" 0 "dry run exits 0"
has "dry run" "$OUT" "DRY RUN"
has "dry run" "$OUT" "source: file://$T/origin.git, main at $V2"
has "dry run" "$OUT" "would write $H/.local/share/usage-watcher/watch.py (mode 0444"
has "dry run" "$OUT" "would load the job: launchctl bootstrap gui/4242 $H/Library/LaunchAgents/$LABEL.plist"
has "dry run" "$OUT" "<string>$H/.local/share/usage-watcher/watch.py</string>"
lacks "dry run" "$OUT" "SessionStart"
check "$(snap "$H")" "$before" "dry run changes nothing in the home"
check "$(lc_count bootstrap)$(lc_count bootout)" 00 "dry run neither loads nor unloads"
check "$(tmp_left)" 0 "dry run removes its temporary folder"

# --- apply -----------------------------------------------------------------------------------------------------------

S=$H/.local/share/usage-watcher
P=$H/Library/LaunchAgents/$LABEL.plist
run -- "$H" "$INST" --apply
check "$RC" 0 "--apply exits 0"
has "--apply" "$OUT" "installed from $V2"
check "$(/bin/cat "$S/watch.py")" "$(printf '# fixture watch.py v2\nprint("fixture v2")')" "watch.py is main's"
check "$([ -e "$S/account-stamp.sh" ] && echo present || echo absent)" absent "account-stamp.sh is retired: not installed"
check "$(/usr/bin/stat -f %Lp "$S/watch.py")" 444 "watch.py mode"
check "$(/usr/bin/stat -f %Lp "$P")" 644 "plist mode"
check "$(/usr/bin/stat -f %Lp "$S")" 700 "share dir mode"
check "$(/usr/bin/stat -f %Lp "$H/.local/state/usage-watcher")" 700 "data dir mode"
pg() { /usr/bin/plutil -extract "$1" raw -o - "$P"; }
check "$(pg Label)" "$LABEL" "plist Label"
check "$(pg ProgramArguments.0) $(pg ProgramArguments.1) $(pg ProgramArguments.2)" "/usr/bin/python3 -I $S/watch.py" "plist program"
check "$(pg ProgramArguments.3) $(pg ProgramArguments.4)" "--config-dir $H/.claude" "plist config dir"
check "$(pg StartInterval)" 300 "plist interval"
check "$(/usr/bin/grep -c '__HOME__\|__CONFIG_DIR__' "$P" || true)" 0 "plist has no placeholder left"
check "$(/usr/bin/tail -n 1 "$T/launchctl.log")" "print gui/4242/$LABEL" "apply verifies with launchctl print"
check "$(lc_count "bootstrap gui/4242 $P")" 1 "apply bootstraps the job in gui/<uid>"
check "$(lc_count bootout)" 0 "first apply has nothing to boot out"
check "$(/usr/bin/shasum -a 256 "$H/.claude/settings.json")" "$SETTINGS_SUM" "settings.json untouched"
lacks "--apply" "$OUT" "SessionStart"
check "$(tmp_left)" 0 "apply removes its temporary folder"
check "$(/bin/ls -A "$S" | /usr/bin/grep -c '^\.uw-install' || true)" 0 "no leftover pending file"

# idempotent
run -- "$H" "$INST" --apply
check "$RC" 0 "second --apply exits 0"
has "second --apply" "$OUT" "watch.py unchanged"
has "second --apply" "$OUT" "plist unchanged"
check "$(lc_count "bootout gui/4242/$LABEL")" 1 "second apply boots the job out before loading it"
check "$(lc_count bootstrap)" 2 "second apply loads it again"

# a copy of the retired account-stamp.sh from an earlier install: noted by every mode, never rewritten or removed
# except by --uninstall --apply, and never an error
printf '#!/bin/bash\n# the retired hook\nexit 0\n' >"$S/account-stamp.sh"
/bin/chmod 0555 "$S/account-stamp.sh"
retired=$(/usr/bin/shasum -a 256 "$S/account-stamp.sh")
run -- "$H" "$INST"
check "$RC" 0 "the dry run with a retired copy exits 0"
has "dry run, retired copy" "$OUT" "account-stamp.sh is retired and a copy is still at $S/account-stamp.sh"
run -- "$H" "$INST" --apply
check "$RC" 0 "--apply with a retired copy exits 0"
has "--apply, retired copy" "$OUT" "Remove its SessionStart entry from"
check "$(/usr/bin/shasum -a 256 "$S/account-stamp.sh")" "$retired" "--apply leaves the retired copy as it was"

# --- status ----------------------------------------------------------------------------------------------------------

before=$(snap "$H")
run -- "$H" "$INST" --status
check "$RC" 0 "--status exits 0 when installed"
has "--status" "$OUT" "loaded   gui/4242/$LABEL (last exit code = 0)"
has "--status" "$OUT" "all good"
has "--status, retired copy" "$OUT" "account-stamp.sh is retired"
run -- "$H" "$INST" --status --ref "$V2"
check "$RC" 0 "--status --ref main's tip exits 0"
has "--status --ref" "$OUT" "same     watch.py as at $V2"
run -- "$H" "$INST" --status --ref "$V1"
check "$RC" 4 "--status --ref an older commit exits 4"
has "--status --ref older" "$OUT" "DIFFERS  watch.py from $V1"
check "$(snap "$H")" "$before" "--status changes nothing"

# --- --ref -----------------------------------------------------------------------------------------------------------

run -- "$H" "$INST" --apply --ref "$V1"
check "$RC" 0 "--apply --ref v1 exits 0"
check "$(/usr/bin/grep -c 'fixture v1' "$S/watch.py")" 1 "--ref installs that commit"
before=$(snap "$H")
run -- "$H" "$INST" --apply --ref "$EVIL"
check "$RC" 1 "--ref of a commit not on main is refused"
has "--ref not on main" "$OUT" "is not on main"
run -- "$H" "$INST" --apply --ref 0000000000000000000000000000000000000000
check "$RC" 1 "--ref of an unknown commit is refused"
check "$(snap "$H")" "$before" "refused --ref changes nothing"
run -- "$H" "$INST" --apply
check "$(/usr/bin/grep -c 'fixture v2' "$S/watch.py")" 1 "--apply without --ref goes back to main"

# --- a failing bootstrap, root, a relative TMPDIR --------------------------------------------------------------------

: >"$T/fail-bootstrap"
n=$(lc_count "bootout gui/4242/$LABEL")
run -- "$H" "$INST" --apply
check "$RC" 1 "--apply exits non-zero when bootstrap fails"
has "failed bootstrap" "$OUT" "the job is unloaded; the files are installed; fix the cause and re-run --apply"
check "$(lc_count "bootout gui/4242/$LABEL")" "$((n + 1))" "the job was booted out before the failed bootstrap"
/bin/rm -f "$T/fail-bootstrap"
run -- "$H" "$INST" --apply
check "$RC" 0 "re-running --apply after the cause is fixed loads the job"

printf '0\n' >"$T/fake-uid"
before=$(snap "$H")
run -- "$H" "$INST" --apply
check "$RC" 3 "refuses to run as root"
has "root" "$OUT" "run as your own user, not root"
/bin/rm -f "$T/fake-uid"
run "TMPDIR=relative/tmp" -- "$H" "$INST" --apply
check "$RC" 1 "refuses a relative TMPDIR"
has "relative TMPDIR" "$OUT" "TMPDIR must be an absolute path"
check "$(snap "$H")" "$before" "root and relative TMPDIR refusals change nothing"

# --- uninstall -------------------------------------------------------------------------------------------------------

printf '{"v":5}\n' >"$H/.local/state/usage-watcher/usage-summary.json"
before=$(snap "$H")
n=$(lc_count bootout)
run -- "$H" "$INST" --uninstall
check "$RC" 0 "--uninstall dry run exits 0"
has "--uninstall dry run" "$OUT" "would remove $P"
has "--uninstall dry run" "$OUT" "would remove $S/account-stamp.sh"
check "$(snap "$H")" "$before" "--uninstall dry run changes nothing"
check "$(lc_count bootout)" "$n" "--uninstall dry run unloads nothing"
run -- "$H" "$INST" --uninstall --apply
check "$RC" 0 "--uninstall --apply exits 0"
check "$([ -e "$P" ] || [ -e "$S" ] && echo present || echo gone)" gone "plist, watch.py and account-stamp.sh removed"
check "$(/bin/cat "$H/.local/state/usage-watcher/usage-summary.json")" '{"v":5}' "data folder kept"
check "$(lc_count "bootout gui/4242/$LABEL")" "$((n + 1))" "--uninstall unloads the job"
check "$([ -e "$T/ld/gui/4242/$LABEL.plist" ] && echo loaded || echo unloaded)" unloaded "job unloaded"
run -- "$H" "$INST" --uninstall --apply
check "$RC" 0 "second --uninstall --apply exits 0"
has "second uninstall" "$OUT" "the job is not loaded"
run -- "$H" "$INST" --status
check "$RC" 4 "--status after uninstall exits 4"
check "$(/usr/bin/shasum -a 256 "$H/.claude/settings.json")" "$SETTINGS_SUM" "settings.json still untouched"

# --- refuses symlinks ------------------------------------------------------------------------------------------------

H2=$T/home2
new_home "$H2"
/bin/mkdir -p "$H2/.local/share" "$T/elsewhere"
/bin/ln -s "$T/elsewhere" "$H2/.local/share/usage-watcher"
run -- "$H2" "$INST"
check "$RC" 3 "dry run refuses a symlinked destination folder"
has "symlinked folder" "$OUT" "is a symlink"
run -- "$H2" "$INST" --apply
check "$RC" 3 "--apply refuses a symlinked destination folder"
run -- "$H2" "$INST" --uninstall --apply
check "$RC" 3 "--uninstall refuses a symlinked destination folder"
check "$(/bin/ls -A "$T/elsewhere")" "" "nothing written through the symlink"

H3=$T/home3
new_home "$H3"
/bin/mkdir -m 0700 "$H3/Library/LaunchAgents"
printf 'target\n' >"$T/plist-target"
/bin/ln -s "$T/plist-target" "$H3/Library/LaunchAgents/$LABEL.plist"
run -- "$H3" "$INST" --apply
check "$RC" 3 "--apply refuses a symlinked plist"
check "$(/bin/cat "$T/plist-target")" target "the symlink's target is untouched"
check "$([ -e "$H3/.local" ] && echo yes || echo no)" no "a refusal writes nothing"

H3b=$T/home3b
new_home "$H3b"
/bin/mkdir -m 0777 "$H3b/.local"
run -- "$H3b" "$INST" --apply
check "$RC" 3 "--apply refuses a world-writable folder on the path"

# --- the plist must be exactly the expected job ----------------------------------------------------------------------

make_copy "$T/bin-extrakey/install.sh" "$T/extrakey.git"
make_copy "$T/bin-extraarg/install.sh" "$T/extraarg.git"
H4=$T/home4
new_home "$H4"
before=$(snap "$H4")
run -- "$H4" "$T/bin-extrakey/install.sh" --apply
check "$RC" 1 "--apply refuses a plist template with an extra key"
has "extra key" "$OUT" 'unexpected key "EnvironmentVariables"'
run -- "$H4" "$T/bin-extrakey/install.sh"
check "$RC" 1 "the dry run refuses it too"
run -- "$H4" "$T/bin-extraarg/install.sh" --apply
check "$RC" 1 "--apply refuses a plist template with an extra program argument"
has "extra argument" "$OUT" "ProgramArguments is"
check "$(snap "$H4")" "$before" "a refused plist installs nothing"

# --- the repo's real plist template passes the allowlist -------------------------------------------------------------

make_copy "$T/bin-real/install.sh" "$T/real.git"
check "$(tg --git-dir="$T/real.git" cat-file blob "main:tools/usage-watcher/$LABEL.plist" | /usr/bin/cmp -s - "$HERE/$LABEL.plist" && echo same)" same "the fixture carries the real template byte for byte"
H9=$T/home9
new_home "$H9"
run -- "$H9" "$T/bin-real/install.sh"
check "$RC" 0 "the dry run accepts the real template"
run -- "$H9" "$T/bin-real/install.sh" --apply
check "$RC" 0 "--apply accepts the real template"
check "$(/usr/bin/plutil -extract ProgramArguments.2 raw -o - "$H9/Library/LaunchAgents/$LABEL.plist")" "$H9/.local/share/usage-watcher/watch.py" "the real template renders the installed watch.py"

# --- a checkout config with insteadOf around the run is never read ---------------------------------------------------

H10=$T/home10
new_home "$H10"
tg init -q "$T/co"
tg -C "$T/co" config "url.file://$T/evil.git.insteadOf" "file://$T/origin.git"
tg -C "$T/co" config --add "url.file://$T/evil.git.insteadOf" "https://github.com/notitial/ai-manager.git"
CWD=$T/co
run -- "$H10" "$INST" --apply
CWD=$T/cwd
check "$RC" 0 "--apply from a checkout whose config rewrites the URL exits 0"
check "$(/usr/bin/grep -c 'fixture v2' "$H10/.local/share/usage-watcher/watch.py" 2>/dev/null || true)" 1 "the fixture origin's watch.py is installed"
lacks "insteadOf checkout" "$OUT" "evil.git"

# --- a config dir that needs XML escaping ----------------------------------------------------------------------------

H8=$T/home8
new_home "$H8"
CFG="$T/cfg & <x> dir"
run "CLAUDE_CONFIG_DIR=$CFG" -- "$H8" "$INST" --apply
check "$RC" 0 "--apply with '&', '<' and a space in CLAUDE_CONFIG_DIR exits 0"
P8=$H8/Library/LaunchAgents/$LABEL.plist
/usr/bin/plutil -lint -s "$P8" >/dev/null && ok || bad "the escaped plist lints"
check "$(/usr/bin/plutil -extract ProgramArguments.4 raw -o - "$P8")" "$CFG" "the config dir reads back unchanged"
check "$(/usr/bin/grep -c "<string>$T/cfg &amp; &lt;x&gt; dir</string>" "$P8" || true)" 1 "the config dir is XML-escaped in the file"

# --- ignores a poisoned git environment ------------------------------------------------------------------------------

/bin/mkdir -p "$T/evilhooks" "$T/evilxdg/git"
printf '#!/bin/sh\ntouch "%s/HOOK-RAN"\n' "$T" >"$T/evilhooks/reference-transaction"
/bin/chmod 0755 "$T/evilhooks/reference-transaction"
printf '[url "file://%s/evil.git"]\n\tinsteadOf = file://%s/origin.git\n[core]\n\thooksPath = %s/evilhooks\n' "$T" "$T" "$T/evilhooks" >"$T/evil.gitconfig"
/bin/cp "$T/evil.gitconfig" "$T/evilxdg/git/config"
POISON=("GIT_DIR=$T/evil.git" "GIT_WORK_TREE=$T/wt-evil" "GIT_OBJECT_DIRECTORY=$T/evil.git/objects"
  "GIT_ALTERNATE_OBJECT_DIRECTORIES=$T/evil.git/objects" "GIT_CONFIG_GLOBAL=$T/evil.gitconfig"
  "GIT_CONFIG_SYSTEM=$T/evil.gitconfig" "GIT_CONFIG_NOSYSTEM=" "XDG_CONFIG_HOME=$T/evilxdg"
  "GIT_CONFIG_COUNT=1" "GIT_CONFIG_KEY_0=url.file://$T/evil.git.insteadOf" "GIT_CONFIG_VALUE_0=file://$T/origin.git"
  "GIT_CONFIG_PARAMETERS='core.hookspath'='$T/evilhooks'" "GIT_ALLOW_PROTOCOL=file:https:ext")
# Controls: the poison works on a plain git (else the checks below prove nothing).
ctl=$(/usr/bin/env -i PATH=/usr/bin:/bin HOME="$T/githome" "${POISON[@]}" /usr/bin/git ls-remote "file://$T/origin.git" refs/heads/main 2>/dev/null | /usr/bin/cut -f1 || true)
check "$ctl" "$EVIL" "control: the poisoned environment reroutes a plain git"
tg init -q --bare "$T/ctl.git"
/usr/bin/env -i PATH=/usr/bin:/bin HOME="$T/githome" "${POISON[@]}" /usr/bin/git --git-dir="$T/ctl.git" fetch -q \
  "file://$T/origin.git" +refs/heads/main:refs/heads/main >/dev/null 2>&1 || true
check "$([ -e "$T/HOOK-RAN" ] && echo ran || echo not)" ran "control: the poisoned environment runs a hook in a plain git"
/bin/rm -f "$T/HOOK-RAN"
H5=$T/home5
new_home "$H5"
run "${POISON[@]}" "GIT_EXEC_PATH=$T/evilhooks" -- "$H5" "$INST" --apply
check "$RC" 0 "--apply under a poisoned git environment exits 0"
check "$(/usr/bin/grep -c 'fixture v2' "$H5/.local/share/usage-watcher/watch.py" 2>/dev/null || true)" 1 "poisoned environment: main's watch.py installed"
check "$([ -e "$T/HOOK-RAN" ] && echo ran || echo not)" not "poisoned environment: no hook ran"

# --- the URL cannot be changed from the environment ------------------------------------------------------------------

H6=$T/home6
new_home "$H6"
run "ORIGIN_URL=file://$T/evil.git" "ORIGIN_PROTO=file" "USAGE_WATCHER_URL=file://$T/evil.git" \
  "SRC_DIR=evil" "LABEL=evil" "PY=/bin/sh" -- "$H6" "$INST" --apply
check "$RC" 0 "--apply with URL variables in the environment exits 0"
has "env URL" "$OUT" "source: file://$T/origin.git, main at $V2"
lacks "env URL" "$OUT" "evil.git"
check "$(/usr/bin/grep -c 'fixture v2' "$H6/.local/share/usage-watcher/watch.py" 2>/dev/null || true)" 1 "env URL: main's watch.py installed"
check "$(/usr/bin/plutil -extract Label raw -o - "$H6/Library/LaunchAgents/$LABEL.plist")" "$LABEL" "env LABEL ignored"

# --- failing watcher tests stop the install --------------------------------------------------------------------------

H7=$T/home7
new_home "$H7"
before=$(snap "$H7")
run -- "$H7" "$T/bin-bad/install.sh" --apply
check "$RC" 1 "--apply refuses a commit whose watcher tests fail"
has "failing tests" "$OUT" "tests fail"
check "$(snap "$H7")" "$before" "failing tests install nothing"

check "$(tmp_left)" 0 "no temporary folder left behind"

echo "test-install: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
