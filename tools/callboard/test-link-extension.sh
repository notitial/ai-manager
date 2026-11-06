#!/bin/bash
# Tests for link-extension.sh. Each case runs a copy of the script inside a fixture checkout under a temporary
# folder, against a temporary extensions folder, so nothing in your home folder is touched.
set -uo pipefail
cd "$(dirname "$0")"
SCRIPT="$(pwd -P)/link-extension.sh"
T="$(/usr/bin/mktemp -d)"
T="$(cd "$T" && pwd -P)"
trap '/bin/rm -rf "$T"' EXIT
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
run() { local dir="$1"; shift; bash "$dir/link-extension.sh" "$@" > "$T/out" 2>&1; }
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

echo "1..$n"
[ "$fails" = 0 ] || { echo "$fails failed" >&2; exit 1; }
