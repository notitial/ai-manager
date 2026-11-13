#!/bin/bash
# Tests for link-extension.sh. Each case runs a copy of the script inside a fixture checkout under a temporary
# folder, against a temporary extensions folder, so nothing in your home folder is touched.
set -uo pipefail
cd "$(dirname "$0")"
SCRIPT="$(pwd -P)/link-extension.sh"
T="$(/usr/bin/mktemp -d)"
T="$(cd "$T" && pwd -P)"
trap '/bin/chmod -R u+rwx "$T" 2>/dev/null; /bin/rm -rf "$T"' EXIT
fails=0 n=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fails=$((fails + 1)); echo "not ok $n - $1"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

# fixture <dir> <version> [publisher] [name]: a checkout with link-extension.sh and extension/package.json.
fixture() {
  /bin/mkdir -p "$1/extension"
  /bin/cp "$SCRIPT" "$1/link-extension.sh"
  printf '{\n  "name": "%s",\n  "version": "%s",\n  "publisher": "%s"\n}\n' "${4:-callboard-panels}" "$2" "${3:-notitial}" > "$1/extension/package.json"
}
RUNNING=no
run() { local dir="$1"; shift; bash "$dir/link-extension.sh" --vscode-running "$RUNNING" "$@" > "$T/out" 2>&1; }
target_of() { /usr/bin/readlink "$1" 2>/dev/null; }

C="$T/repo" E="$T/ext"
fixture "$C" 1.2.3
SRC="$C/extension"
L="$E/notitial.callboard-panels-1.2.3"

run "$C" --ext-dir "$E"
check "dry run exits 0" [ $? -eq 0 ]
check "dry run makes nothing" [ ! -e "$E" ]
check "dry run names the link" grep -qF "DRY: /bin/ln -s -n -- $SRC $L" "$T/out"

run "$C" --ext-dir "$E" --apply
check "apply exits 0" [ $? -eq 0 ]
check "apply links the version from package.json" [ "$(target_of "$L")" = "$SRC" ]

run "$C" --ext-dir "$E" --apply
check "a second apply exits 0" [ $? -eq 0 ]
check "a second apply reports the link" grep -qF "already linked: $L" "$T/out"

fixture "$C" 1.3.0
run "$C" --ext-dir "$E" --apply
check "a version bump exits 0" [ $? -eq 0 ]
check "a version bump links the new version" [ "$(target_of "$E/notitial.callboard-panels-1.3.0")" = "$SRC" ]
check "a version bump removes the old link" [ ! -L "$L" ]

/bin/mkdir -p "$E/notitial.callboard-panels-1.0.0"
run "$C" --ext-dir "$E" --apply
check "a real folder under the id refuses" [ $? -ne 0 ]
check "the refusal names it" grep -qF "notitial.callboard-panels-1.0.0 is not a link into this checkout" "$T/out"
check "the real folder is left alone" sh -c '[ -d "$1" ] && [ ! -L "$1" ]' _ "$E/notitial.callboard-panels-1.0.0"
/bin/rm -rf "$E/notitial.callboard-panels-1.0.0"

/bin/ln -s /elsewhere "$E/notitial.callboard-panels-9.9.9"
fixture "$C" 1.4.0
run "$C" --ext-dir "$E" --apply
check "a link elsewhere refuses" [ $? -ne 0 ]
check "a refusal keeps the existing link" [ "$(target_of "$E/notitial.callboard-panels-1.3.0")" = "$SRC" ]
check "a refusal makes no new link" sh -c '[ ! -e "$1" ] && [ ! -L "$1" ]' _ "$E/notitial.callboard-panels-1.4.0"

run "$C" --ext-dir "$E" --remove
check "remove dry run exits 0" [ $? -eq 0 ]
check "remove dry run keeps the link" [ -L "$E/notitial.callboard-panels-1.3.0" ]
run "$C" --ext-dir "$E" --remove --apply
check "remove exits 0" [ $? -eq 0 ]
check "remove deletes the link into this checkout" [ ! -L "$E/notitial.callboard-panels-1.3.0" ]
check "remove leaves a foreign link" [ "$(target_of "$E/notitial.callboard-panels-9.9.9")" = /elsewhere ]
check "remove reports the foreign link" grep -qF "left alone (not a link into this checkout): $E/notitial.callboard-panels-9.9.9" "$T/out"
/bin/rm "$E/notitial.callboard-panels-9.9.9"

O="$T/other"
fixture "$O" 1.0.0
/bin/ln -s "$O/extension" "$E/notitial.callboard-panels-1.0.0"
run "$C" --ext-dir "$E" --apply
check "a link into another checkout refuses" [ $? -ne 0 ]
/bin/rm "$E/notitial.callboard-panels-1.0.0"

fixture "$T/pub" 1.0.0 someone
run "$T/pub" --ext-dir "$E"
check "a wrong publisher refuses" [ $? -ne 0 ]
fixture "$T/name" 1.0.0 notitial other-name
run "$T/name" --ext-dir "$E"
check "a wrong name refuses" [ $? -ne 0 ]
fixture "$T/ver" '1.0.0/../x'
run "$T/ver" --ext-dir "$E"
check "a version that is not x.y.z refuses" [ $? -ne 0 ]

run "$C" --ext-dir relative/dir
check "a relative --ext-dir is a usage error" [ $? -eq 2 ]
run "$C" --bogus
check "an unknown option is a usage error" [ $? -eq 2 ]
/bin/mkdir -p "$E/Notitial.Callboard-Panels-0.1.0"
run "$C" --ext-dir "$E" --apply
check "an old copy in another letter case refuses" [ $? -ne 0 ]
/bin/rm -rf "$E/Notitial.Callboard-Panels-0.1.0"

run "$C" --ext-dir
check "--ext-dir with no folder is a usage error" [ $? -eq 2 ]

/bin/ln -s "$E" "$T/ext-link"
run "$C" --ext-dir "$T/ext-link" --apply
check "an extensions folder that is a link refuses" [ $? -ne 0 ]

bash "$SCRIPT" --ext-dir "$T/real" > "$T/out" 2>&1
check "the real script reads its own package.json" grep -qE "DRY: /bin/ln -s -n -- .*/extension $T/real/notitial.callboard-panels-[0-9]+\.[0-9]+\.[0-9]+$" "$T/out"

# --- The registry: VS Code's extensions.json and .obsolete, and the running-VS-Code guard. ---
PY=/usr/bin/python3
# snap <dir>: every path under it with its link target or checksum, so "changes nothing" can be compared.
snap() {
  (cd "$1" && /usr/bin/find . -print0 | /usr/bin/sort -z | /usr/bin/xargs -0 -n1 sh -c \
    'printf "%s " "$0"; if [ -L "$0" ]; then readlink "$0"; elif [ -f "$0" ]; then cksum < "$0"; else echo dir; fi')
}
# entry_of <extensions.json> <version> <ext dir>: the exact JSON text the script must write for one entry.
entry_of() {
  printf '{"identifier":{"id":"notitial.callboard-panels"},"version":"%s","location":{"$mid":1,"path":"%s/notitial.callboard-panels-%s","scheme":"file"},"relativeLocation":"notitial.callboard-panels-%s"}' "$2" "$3" "$2" "$2"
}
# jq_ok <file> <python expression over d>: true when the expression holds for the parsed JSON. The expressions are
# constants written in this file; nothing from a fixture or the environment reaches eval.
jq_ok() { "$PY" -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if eval(sys.argv[2]) else 1)' "$1" "$2"; }
OTHER='{"identifier":{"id":"other.ext","uuid":"0000"},"version":"2.0.0","location":{"$mid":1,"path":"/x/other.ext-2.0.0","scheme":"file"},"relativeLocation":"other.ext-2.0.0","metadata":{"installedTimestamp":1,"source":"gallery"}}'

R="$T/reg" RE="$T/regext"
fixture "$R" 1.2.3
RL="$RE/notitial.callboard-panels-1.2.3"
/bin/mkdir -p "$RE"
printf '[%s]' "$OTHER" > "$RE/extensions.json"
printf '{"notitial.callboard-panels-1.0.0":true,"Notitial.Callboard-Panels-1.2.3":true,"other.ext-1.0.0":true}' > "$RE/.obsolete"
before="$(snap "$RE")"
run "$R" --ext-dir "$RE"
check "registry: dry run exits 0" [ $? -eq 0 ]
check "registry: dry run changes nothing" [ "$(snap "$RE")" = "$before" ]
check "registry: dry run names the entry" grep -qF "DRY: register notitial.callboard-panels-1.2.3 in $RE/extensions.json" "$T/out"
check "registry: dry run names the obsolete keys" grep -qF "DRY: clear 2 keys in $RE/.obsolete" "$T/out"

run "$R" --ext-dir "$RE" --apply
check "registry: apply exits 0" [ $? -eq 0 ]
check "registry: apply links" [ "$(target_of "$RL")" = "$R/extension" ]
check "registry: the entry has exactly the wanted shape" [ "$(cat "$RE/extensions.json")" = "[$OTHER,$(entry_of x 1.2.3 "$RE")]" ]
check "registry: the entry has no metadata or timestamp" jq_ok "$RE/extensions.json" '"metadata" not in d[-1] and "installedTimestamp" not in json.dumps(d[-1])'
check "registry: other entries are kept as they were" jq_ok "$RE/extensions.json" 'len(d) == 2 and d[0]["metadata"]["installedTimestamp"] == 1'
check "registry: the id's .obsolete keys are cleared, case-insensitively, others kept" [ "$(cat "$RE/.obsolete")" = '{"other.ext-1.0.0":true}' ]
check "registry: the old extensions.json is kept as a backup" [ "$(cat "$RE/extensions.json.callboard.bak")" = "[$OTHER]" ]
check "registry: no temp files are left" sh -c '[ -z "$(ls -A "$1" | grep -E "^\..*\.callboard-[A-Za-z0-9_]+$")" ]' _ "$RE"

# Nothing to change: no rewrite, and fine while VS Code runs. A read-only folder would fail any write.
before="$(snap "$RE")"
/bin/chmod 555 "$RE"
RUNNING=yes run "$R" --ext-dir "$RE" --apply
rc=$?
/bin/chmod 755 "$RE"
check "registry: nothing to change exits 0 with VS Code running" [ $rc -eq 0 ]
check "registry: nothing to change reports the link" grep -qF "already linked: $RL" "$T/out"
check "registry: nothing to change writes nothing" [ "$(snap "$RE")" = "$before" ]
RUNNING=yes run "$R" --ext-dir "$RE"
check "registry: nothing to change dry run says nothing about VS Code" sh -c '! grep -q "VS Code is running" "$1"' _ "$T/out"

# A version bump replaces the entry, removes the old link and clears the old key.
printf '{"notitial.callboard-panels-1.2.3":true}' > "$RE/.obsolete"
fixture "$R" 1.3.0
before="$(snap "$RE")"
RUNNING=yes run "$R" --ext-dir "$RE" --apply
check "registry: a bump with VS Code running refuses" [ $? -ne 0 ]
check "registry: the refusal says to quit VS Code" grep -qF "quit it with Cmd+Q" "$T/out"
check "registry: the refusal changed nothing" [ "$(snap "$RE")" = "$before" ]
RUNNING=yes run "$R" --ext-dir "$RE"
check "registry: the dry run exits 0 and reports VS Code running" sh -c '[ "$1" -eq 0 ] && grep -qF "VS Code is running: --apply will refuse" "$2"' _ $? "$T/out"
run "$R" --ext-dir "$RE" --apply
check "registry: a bump exits 0" [ $? -eq 0 ]
check "registry: a bump links the new version and drops the old link" sh -c '[ -L "$1" ] && [ ! -L "$2" ]' _ "$RE/notitial.callboard-panels-1.3.0" "$RL"
check "registry: a bump leaves one entry of the id, the new version" [ "$(cat "$RE/extensions.json")" = "[$OTHER,$(entry_of x 1.3.0 "$RE")]" ]
check "registry: a bump clears the old key" [ "$(cat "$RE/.obsolete")" = '{}' ]

# A dangling entry (a link that is gone) is removed.
printf '[%s,%s]' "$(entry_of x 1.0.0 "$RE")" "$OTHER" > "$RE/extensions.json"
run "$R" --ext-dir "$RE" --apply
check "registry: a dangling entry is replaced" [ "$(cat "$RE/extensions.json")" = "[$OTHER,$(entry_of x 1.3.0 "$RE")]" ]

# A link with no entry is repaired; a missing extensions.json is created.
/bin/rm "$RE/extensions.json"
run "$R" --ext-dir "$RE" --apply
check "registry: a bare link is repaired, exit 0" [ $? -eq 0 ]
check "registry: a bare link gets its entry" [ "$(cat "$RE/extensions.json")" = "[$(entry_of x 1.3.0 "$RE")]" ]
# An entry that carries metadata at our location is rewritten without it.
printf '[{"identifier":{"id":"notitial.callboard-panels"},"version":"1.3.0","location":{"$mid":1,"path":"%s/notitial.callboard-panels-1.3.0","scheme":"file"},"relativeLocation":"notitial.callboard-panels-1.3.0","metadata":{"installedTimestamp":5}}]' "$RE" > "$RE/extensions.json"
run "$R" --ext-dir "$RE" --apply
check "registry: metadata on our entry is dropped" [ "$(cat "$RE/extensions.json")" = "[$(entry_of x 1.3.0 "$RE")]" ]

# A fresh machine: no extensions folder at all.
FE="$T/fresh/ext"
run "$R" --ext-dir "$FE" --apply
check "registry: a fresh folder applies, exit 0" [ $? -eq 0 ]
check "registry: a fresh folder gets the link" [ "$(target_of "$FE/notitial.callboard-panels-1.3.0")" = "$R/extension" ]
check "registry: a fresh folder gets the entry" [ "$(cat "$FE/extensions.json")" = "[$(entry_of x 1.3.0 "$FE")]" ]
check "registry: a fresh folder gets no .obsolete" [ ! -e "$FE/.obsolete" ]

# Refusals leave everything as it was, and name the file.
refuses() { # <name> <file> <content-or-@link> <message part>
  local name="$1" file="$2" content="$3" part="$4" d="$T/ref-$1"
  /bin/mkdir -p "$d"
  if [ "$content" = @link ]; then /bin/ln -s /elsewhere "$d/$file"; else printf '%s' "$content" > "$d/$file"; fi
  local b; b="$(snap "$d")"
  run "$R" --ext-dir "$d" --apply
  check "refuses: $name" [ $? -ne 0 ]
  check "refuses: $name names the file" grep -qF "$d/$file" "$T/out"
  check "refuses: $name says why" grep -qF "$part" "$T/out"
  check "refuses: $name changes nothing, no link made" [ "$(snap "$d")" = "$b" ]
}
refuses malformed-registry extensions.json '[{' "not valid JSON"
refuses registry-object extensions.json '{}' "not a JSON list"
refuses registry-item extensions.json '[1]' "not an object"
refuses registry-link extensions.json @link "is a link"
refuses obsolete-malformed .obsolete 'nope' "not valid JSON"
refuses obsolete-list .obsolete '[]' "not a JSON object"
refuses obsolete-link .obsolete @link "is a link"
refuses foreign-location extensions.json '[{"identifier":{"id":"Notitial.Callboard-Panels"},"version":"1.0.0","location":{"$mid":1,"path":"/elsewhere/x","scheme":"file"}}]' "which is not"
refuses foreign-no-location extensions.json '[{"identifier":{"id":"notitial.callboard-panels"},"version":"1.0.0"}]' "(no location)"
/bin/mkdir -p "$T/refdir/extensions.json"
run "$R" --ext-dir "$T/refdir" --apply
check "refuses: extensions.json that is a folder" [ $? -ne 0 ]

# --remove: links, this id's entries and keys go; a foreign link and its entry stay, named.
M="$T/rm" ME="$T/rmext"
fixture "$M" 1.2.3
/bin/mkdir -p "$ME"
run "$M" --ext-dir "$ME" --apply
/bin/ln -s /elsewhere "$ME/notitial.callboard-panels-9.9.9"
printf '[%s,%s,{"identifier":{"id":"notitial.callboard-panels"},"version":"9.9.9","location":{"$mid":1,"path":"%s/notitial.callboard-panels-9.9.9","scheme":"file"}},{"identifier":{"id":"notitial.callboard-panels"},"version":"0.5.0","location":{"$mid":1,"path":"/outside/x","scheme":"file"}}]' \
  "$OTHER" "$(entry_of x 1.2.3 "$ME")" "$ME" > "$ME/extensions.json"
printf '{"notitial.callboard-panels-0.9.0":true,"notitial.callboard-panels-9.9.9":true,"other.ext-1.0.0":true}' > "$ME/.obsolete"
before="$(snap "$ME")"
run "$M" --ext-dir "$ME" --remove
check "remove: dry run exits 0" [ $? -eq 0 ]
check "remove: dry run changes nothing" [ "$(snap "$ME")" = "$before" ]
check "remove: dry run names the entries and keys" sh -c 'grep -qF "DRY: unregister 1 entry of notitial.callboard-panels" "$1" && grep -qF "DRY: clear 1 key in" "$1"' _ "$T/out"
RUNNING=yes run "$M" --ext-dir "$ME" --remove --apply
check "remove: with VS Code running refuses" [ $? -ne 0 ]
check "remove: the running refusal changes nothing" [ "$(snap "$ME")" = "$before" ]
run "$M" --ext-dir "$ME" --remove --apply
check "remove: exits 0" [ $? -eq 0 ]
check "remove: removes the link" [ ! -L "$ME/notitial.callboard-panels-1.2.3" ]
check "remove: keeps the foreign link" [ "$(target_of "$ME/notitial.callboard-panels-9.9.9")" = /elsewhere ]
check "remove: removes our entry, keeps others, the foreign link's entry and one outside the folder" jq_ok "$ME/extensions.json" 'len(d) == 3 and [e["version"] for e in d] == ["2.0.0", "9.9.9", "0.5.0"]'
check "remove: names the entry it leaves outside the folder" grep -qF "left alone (an entry of notitial.callboard-panels that is not ours): /outside/x" "$T/out"
check "remove: clears our .obsolete key, keeps the foreign link's and others" [ "$(cat "$ME/.obsolete")" = '{"notitial.callboard-panels-9.9.9":true,"other.ext-1.0.0":true}' ]
check "remove: keeps a backup of extensions.json" [ -f "$ME/extensions.json.callboard.bak" ]
before="$(snap "$ME")"
RUNNING=yes run "$M" --ext-dir "$ME" --remove --apply
check "remove: with nothing left to remove exits 0 even with VS Code running" [ $? -eq 0 ]
check "remove: with nothing left to remove changes nothing" [ "$(snap "$ME")" = "$before" ]
# a malformed registry stops --remove before it removes the link
/bin/rm "$ME/notitial.callboard-panels-9.9.9"
printf '[]' > "$ME/extensions.json"
run "$M" --ext-dir "$ME" --apply
check "remove: the link is back for the next case" [ -L "$ME/notitial.callboard-panels-1.2.3" ]
printf '[{' > "$ME/extensions.json"
run "$M" --ext-dir "$ME" --remove --apply
check "remove: a malformed extensions.json refuses" [ $? -ne 0 ]
check "remove: a malformed extensions.json keeps the link" [ -L "$ME/notitial.callboard-panels-1.2.3" ]

# An entry in another letter case, an entry that is not <id>-x.y.z, and a stale link in another letter case.
CE="$T/case"
/bin/mkdir -p "$CE"
printf '[{"identifier":{"id":"Notitial.Callboard-Panels"},"version":"1.0.0","location":{"$mid":1,"path":"%s/Notitial.Callboard-Panels-1.0.0","scheme":"file"}}]' "$CE" > "$CE/extensions.json"
/bin/ln -s "$R/extension" "$CE/Notitial.Callboard-Panels-1.0.0"
run "$R" --ext-dir "$CE" --apply
check "case: a stale link and entry in another letter case are replaced" [ "$(cat "$CE/extensions.json")" = "[$(entry_of x 1.3.0 "$CE")]" ]
check "case: the stale link in another letter case is gone" sh -c '[ ! -L "$1" ] && [ -L "$2" ]' _ "$CE/Notitial.Callboard-Panels-1.0.0" "$CE/notitial.callboard-panels-1.3.0"
refuses odd-name extensions.json '[{"identifier":{"id":"notitial.callboard-panels"},"version":"1.0.0","location":{"$mid":1,"path":"/elsewhere/ext/some-copy","scheme":"file"}}]' "x.y.z"
OD="$T/odd"
/bin/mkdir -p "$OD"
printf '[{"identifier":{"id":"notitial.callboard-panels"},"version":"1.0.0","location":{"$mid":1,"path":"%s/some-copy","scheme":"file"}}]' "$OD" > "$OD/extensions.json"
before="$(snap "$OD")"
run "$R" --ext-dir "$OD" --apply
check "odd name: an in-folder entry that is not <id>-x.y.z refuses" [ $? -ne 0 ]
check "odd name: it changes nothing" [ "$(snap "$OD")" = "$before" ]
run "$R" --ext-dir "$OD" --remove --apply
check "odd name: --remove leaves it and names it" grep -qF "left alone (an entry of notitial.callboard-panels that is not ours): $OD/some-copy" "$T/out"
check "odd name: --remove keeps the entry" jq_ok "$OD/extensions.json" 'len(d) == 1'

# Remove with only the registry to change, VS Code running: refuses; nothing changes.
RG="$T/regonly"
/bin/mkdir -p "$RG"
printf '[%s]' "$(entry_of x 1.3.0 "$RG")" > "$RG/extensions.json"
before="$(snap "$RG")"
RUNNING=yes run "$R" --ext-dir "$RG" --remove --apply
check "remove: a registry-only change with VS Code running refuses" [ $? -ne 0 ]
check "remove: that refusal changes nothing" [ "$(snap "$RG")" = "$before" ]

# The first backup is kept; a backup that is a folder or a link refuses; a lone entry shape that can't be written refuses.
BK="$T/bak"
/bin/mkdir -p "$BK"
printf '[%s]' "$OTHER" > "$BK/extensions.json"
run "$R" --ext-dir "$BK" --apply
first="$(cat "$BK/extensions.json.callboard.bak")"
fixture "$R" 1.4.0
run "$R" --ext-dir "$BK" --apply
check "backup: the first backup is the original file" [ "$first" = "[$OTHER]" ]
check "backup: the first backup is kept through a second change" [ "$(cat "$BK/extensions.json.callboard.bak")" = "$first" ]
/bin/mkdir -p "$T/bakdir"
printf '[]' > "$T/bakdir/extensions.json"
/bin/mkdir "$T/bakdir/extensions.json.callboard.bak"
before="$(snap "$T/bakdir")"
run "$R" --ext-dir "$T/bakdir" --apply
check "backup: a folder in the backup's place refuses" [ $? -ne 0 ]
check "backup: that refusal changes nothing, no link made" [ "$(snap "$T/bakdir")" = "$before" ]
/bin/mkdir -p "$T/nanext"
printf '[{"identifier":{"id":"x"},"n":NaN}]' > "$T/nanext/extensions.json"
run "$R" --ext-dir "$T/nanext" --apply
check "NaN in extensions.json refuses" [ $? -ne 0 ]
/bin/mkdir -p "$T/sur"
printf '%s' '[{"identifier":{"id":"x"},"n":"\ud800"}]' > "$T/sur/extensions.json"
before="$(snap "$T/sur")"
run "$R" --ext-dir "$T/sur" --apply
check "a string that can't be written back refuses before the link is made" [ $? -ne 0 ]
check "that refusal is the serialization one, not a parse error" grep -qF "can't be written as JSON" "$T/out"
check "a string that can't be written back changes nothing" [ "$(snap "$T/sur")" = "$before" ]

# A path from a file is printed escaped when it holds control characters.
/bin/mkdir -p "$T/esc"
printf '%s' '[{"identifier":{"id":"notitial.callboard-panels"},"version":"1.0.0","location":{"$mid":1,"path":"/a\u001b[31mb","scheme":"file"}}]' > "$T/esc/extensions.json"
run "$R" --ext-dir "$T/esc" --apply
check "the fixture really holds the JSON escape text" grep -qF '\u001b' "$T/esc/extensions.json"
check "the escaped path is printed as escape text" grep -qF '\u001b[31mb' "$T/out"
check "an escape character in a path is not printed raw" sh -c '! grep -q "$(printf "\033")" "$1"' _ "$T/out"

# A trailing slash does not get past the link check.
run "$C" --ext-dir "$T/ext-link/" --apply
check "an extensions folder that is a link with a trailing slash refuses" [ $? -ne 0 ]

# The real ps: the dry run says VS Code is running exactly when ps lists its main binary for this user.
bash "$SCRIPT" --ext-dir "$T/psext" > "$T/out" 2>&1
procs="$(/bin/ps -U "$(/usr/bin/id -u)" -xo comm= 2>/dev/null)"
if grep -qE '/Contents/MacOS/Code$' <<< "$procs"; then
  check "the real ps agrees: VS Code running is reported" grep -qF "VS Code is running" "$T/out"
else
  check "the real ps agrees: VS Code not running is not reported" sh -c '! grep -q "VS Code is running" "$1"' _ "$T/out"
fi

# Usage of the test-only flag.
bash "$M/link-extension.sh" --vscode-running no > "$T/out" 2>&1
check "--vscode-running without --ext-dir is a usage error" [ $? -eq 2 ]
run "$M" --ext-dir "$ME" --vscode-running maybe
check "--vscode-running takes yes or no" [ $? -eq 2 ]
HOME="$T/home" bash "$M/link-extension.sh" --vscode-running no --ext-dir "$T/home/.vscode/extensions" > "$T/out" 2>&1
check "--vscode-running is refused for the real extensions folder" [ $? -eq 2 ]

echo "1..$n"
[ "$fails" = 0 ] || { echo "$fails failed" >&2; exit 1; }
