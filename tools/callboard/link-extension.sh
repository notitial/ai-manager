#!/bin/bash
# Links the callboard panels extension into VS Code from this checkout and registers it. Dry run unless --apply.
#   link-extension.sh [--apply]            make ~/.vscode/extensions/notitial.callboard-panels-<version> a link to
#                                          this checkout's extension/ folder, and give it an entry in VS Code's
#                                          extensions.json (no metadata)
#   link-extension.sh --remove [--apply]   remove every notitial.callboard-panels-* link into this checkout, this id's
#                                          entries inside the extensions folder and its .obsolete keys
# The version comes from extension/package.json. A link into this checkout under another version's name (left by a
# version bump) is removed. A real folder, or a link to anywhere else, under any notitial.callboard-panels-* name is
# never touched: the script stops and names it, so an old copy can't shadow the link. The same goes for anything under
# the earlier id local.callboard-panels-*, which would answer lane_open as well.
# VS Code deletes, at each start, every extension folder that extensions.json doesn't list, so the link alone does not
# survive a restart. The entry carries no metadata, which keeps VS Code from deleting through the link. The files are
# VS Code's own: the script refuses a linked or malformed one and keeps the first old copy as <name>.callboard.bak. It
# also clears this id's keys in .obsolete. A change needs VS Code quit (Cmd+Q): with it running, --apply refuses and
# changes nothing. Nothing to change is fine with VS Code open. Run it as your user: it refuses root, never uses sudo
# and changes no setting. Start VS Code afterwards.
# --ext-dir and --vscode-running yes|no are for the tests. Tests: bash tools/callboard/test-link-extension.sh
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
ID=notitial.callboard-panels
APPLY=0 REMOVE=0 EXT_DIR="" EXT_SET=0 RUN_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --remove) REMOVE=1 ;;
    --ext-dir) [ $# -ge 2 ] || { echo "--ext-dir needs a folder" >&2; exit 2; }; EXT_DIR="$2"; EXT_SET=1; shift ;;
    --vscode-running)
      [ $# -ge 2 ] || { echo "--vscode-running needs yes or no" >&2; exit 2; }
      case "$2" in yes|no) RUN_OVERRIDE="$2" ;; *) echo "--vscode-running needs yes or no" >&2; exit 2 ;; esac
      shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -n "$RUN_OVERRIDE" ] && [ "$EXT_SET" = 0 ]; then echo "--vscode-running is only for the tests, with --ext-dir" >&2; exit 2; fi
die() { echo "link-extension: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
act() { if [ "$APPLY" = 1 ]; then "$@"; else say "DRY: $*"; fi; }

[ "$(/usr/bin/id -u)" != 0 ] || die "run it as your user, not as root"
if [ "$EXT_SET" = 0 ]; then
  case "${HOME:-}" in /*) ;; *) die "HOME must be an absolute path" ;; esac
  EXT_DIR="$HOME/.vscode/extensions"
fi
case "$EXT_DIR" in /*) ;; *) echo "--ext-dir must be absolute" >&2; exit 2 ;; esac
while [ "${#EXT_DIR}" -gt 1 ] && [ "${EXT_DIR%/}" != "$EXT_DIR" ]; do EXT_DIR="${EXT_DIR%/}"; done
if [ -n "$RUN_OVERRIDE" ] && [ "$EXT_DIR" = "${HOME:-/nonexistent}/.vscode/extensions" ]; then
  echo "--vscode-running is only for the tests, not for VS Code's own extensions folder" >&2; exit 2
fi
[ ! -L "$EXT_DIR" ] || die "$EXT_DIR is a link; refusing to work through it"

HERE="$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")" && pwd -P)"
SRC="$HERE/extension"
MANIFEST="$SRC/package.json"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die "$MANIFEST is missing or not a regular file"
field() { /usr/bin/plutil -extract "$1" raw -o - "$MANIFEST" 2>/dev/null || true; }
[ "$(field publisher)" = notitial ] || die "extension/package.json publisher must be notitial"
[ "$(field name)" = callboard-panels ] || die "extension/package.json name must be callboard-panels"
VER="$(field version)"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "extension/package.json version must look like 1.2.3 (got '$VER')"
TARGET="$EXT_DIR/$ID-$VER"

# ours <path>: a symlink whose target is exactly this checkout's extension folder (the form this script writes).
ours() { [ -L "$1" ] && [ "$(/usr/bin/readlink "$1")" = "$SRC" ]; }

# vscode_running: true when VS Code's main process is up (this user's processes). A ps that fails or prints nothing
# counts as running.
vscode_running() {
  if [ -n "$RUN_OVERRIDE" ]; then [ "$RUN_OVERRIDE" = yes ]; return; fi
  local procs
  procs="$(/bin/ps -U "$(/usr/bin/id -u)" -xo comm= 2>/dev/null)" || return 0
  [ -n "$procs" ] || return 0
  /usr/bin/grep -qE '/Contents/MacOS/Code$' <<< "$procs"
}
# guard: called only when something would change.
guard() {
  if vscode_running; then
    if [ "$APPLY" = 1 ]; then
      die "VS Code is running and would undo or lose the change: quit it with Cmd+Q, then run this from Terminal (not from VS Code's terminal)"
    fi
    say "VS Code is running: --apply will refuse until you quit it with Cmd+Q"
  fi
}

# The registry half: VS Code's extensions.json and .obsolete, in the extensions folder. The helper validates and plans
# first (check: exit 3 when something would change, exit 1 on a refusal) and only then writes (write). It reads the
# old files, writes a temp file in the same folder, keeps the old one as <name>.callboard.bak and renames over it.
PYSRC=""
read -r -d '' PYSRC <<'PY' || true
import json, os, re, stat, sys, tempfile

mode, action, prefix, ext_dir, ident, ver, target = sys.argv[1:8]
foreign = sys.argv[8:]
removing = action == "remove"
ext_dir = os.path.normpath(ext_dir)
idl = ident.lower()
reg_path = os.path.join(ext_dir, "extensions.json")
obs_path = os.path.join(ext_dir, ".obsolete")


def refuse(msg):
    print("link-extension: " + msg, file=sys.stderr)
    sys.exit(1)


def norm(p):
    return os.path.normpath(p).lower()


def show(p):
    # A path from a file is printed escaped when it holds control characters, so it can't drive the terminal.
    return p if p.isprintable() else json.dumps(p)


foreign_l = {norm(p) for p in foreign}


ENTRY_NAME = re.compile(r"^" + re.escape(ident) + r"-[0-9]+\.[0-9]+\.[0-9]+$", re.IGNORECASE)


def ours_by_name(p):
    # An entry this script may replace: directly in the extensions folder, named <id>-x.y.z (the folder the glob in the
    # shell half has already checked, or one that is gone).
    n = os.path.normpath(p)
    return os.path.dirname(n).lower() == ext_dir.lower() and ENTRY_NAME.match(os.path.basename(n)) is not None


def refuse_const(c):
    raise ValueError("constant " + c)


def load(path, kind, what):
    # Returns (data, raw bytes, mode), or (None, None, None) when the file is missing. O_NOFOLLOW: never through a link.
    if os.path.islink(path):
        refuse("%s is a link; refusing to work through it" % path)
    if not os.path.lexists(path):
        return None, None, None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as e:
        refuse("cannot open %s without following a link (%s)" % (path, e.strerror))
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            refuse("%s is not a regular file" % path)
        raw = f.read()
    try:
        data = json.loads(raw.decode("utf-8"), parse_constant=refuse_const)
    except (ValueError, RecursionError) as e:
        refuse("%s is not valid JSON (%s); fix or remove it yourself, then run this again" % (path, type(e).__name__))
    if not isinstance(data, kind):
        refuse("%s is not a JSON %s; fix or remove it yourself, then run this again" % (path, what))
    return data, raw, st.st_mode & 0o777


def entry_id(e):
    i = e.get("identifier")
    v = i.get("id") if isinstance(i, dict) else None
    return v.lower() if isinstance(v, str) else None


def entry_path(e):
    loc = e.get("location")
    p = loc.get("path") if isinstance(loc, dict) else None
    return p if isinstance(p, str) else None


def plural(n, one, many):
    return one if n == 1 else many


reg, reg_raw, reg_mode = load(reg_path, list, "list")
obs, obs_raw, obs_mode = load(obs_path, dict, "object")
for f in (reg_path, obs_path):
    b = f + ".callboard.bak"
    if os.path.islink(b) or (os.path.lexists(b) and not os.path.isfile(b)):
        refuse("%s is not a regular file; remove it yourself, then run this again" % b)
lines = []

if reg is not None and any(not isinstance(e, dict) for e in reg):
    refuse("%s holds an item that is not an object; fix or remove it yourself, then run this again" % reg_path)
new_reg = None
keep, drop = [], []
for e in reg or []:
    if entry_id(e) != idl:
        keep.append(e)
        continue
    p = entry_path(e)
    shown = show(p) if p is not None else "(no location)"
    if p is None or not ours_by_name(p) or norm(p) in foreign_l:
        if removing:
            lines.append("left alone (an entry of %s that is not ours): %s" % (ident, shown))
            keep.append(e)
        else:
            refuse("%s has an entry for %s at %s, which is not %s/%s-x.y.z; remove it yourself, then run this again"
                   % (reg_path, ident, shown, ext_dir, ident))
    else:
        drop.append(e)
if removing:
    if drop:
        new_reg = keep
        lines.append("%sunregister %d %s of %s in %s"
                     % (prefix, len(drop), plural(len(drop), "entry", "entries"), ident, reg_path))
else:
    wanted = {
        "identifier": {"id": ident},
        "version": ver,
        "location": {"$mid": 1, "path": os.path.normpath(target), "scheme": "file"},
        "relativeLocation": "%s-%s" % (ident, ver),
    }
    if not (len(drop) == 1 and drop[0] == wanted):
        new_reg = keep + [wanted]
        extra = " (replacing %d other %s)" % (len(drop), plural(len(drop), "entry", "entries")) if drop else ""
        lines.append("%sregister %s-%s in %s%s" % (prefix, ident, ver, reg_path, extra))

new_obs = None
if obs is not None:
    pre = idl + "-"
    gone = [k for k in obs if k.lower().startswith(pre)
            and not (removing and norm(os.path.join(ext_dir, k)) in foreign_l)]
    if gone:
        new_obs = {k: v for k, v in obs.items() if k not in gone}
        lines.append("%sclear %d %s in %s" % (prefix, len(gone), plural(len(gone), "key", "keys"), obs_path))

changed = new_reg is not None or new_obs is not None


def serialize(data):
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


out_reg = out_obs = None
try:
    if new_reg is not None:
        out_reg = serialize(new_reg)
    if new_obs is not None:
        out_obs = serialize(new_obs)
except (ValueError, RecursionError) as e:
    refuse("the new content for %s can't be written as JSON (%s)" % (ext_dir, type(e).__name__))
if changed and os.path.isdir(ext_dir) and not os.access(ext_dir, os.W_OK | os.X_OK):
    refuse("%s is not writable" % ext_dir)
for l in lines:
    print(l)
if mode == "check":
    sys.exit(3 if changed else 0)


def put(path, content, perm):
    # Temp file in the same folder (mkstemp: new, 0600), then a rename over the target. Never writes through a link.
    d, base = os.path.split(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + base + ".callboard-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, perm)
        os.replace(tmp, path)
    except BaseException:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise


def write(path, content, old_raw, old_mode):
    if old_raw is not None and not os.path.lexists(path + ".callboard.bak"):
        # The first backup is kept: it is the file as VS Code left it, before this script ever touched it.
        put(path + ".callboard.bak", old_raw, old_mode)
    put(path, content, old_mode if old_mode is not None else 0o644)


try:
    if new_reg is not None:
        write(reg_path, out_reg, reg_raw, reg_mode)
    if new_obs is not None:
        write(obs_path, out_obs, obs_raw, obs_mode)
except OSError as e:
    refuse("could not write under %s (%s); check the folder, then run this again" % (ext_dir, e))
PY
py() { /usr/bin/python3 -I -c "$PYSRC" "$@"; }

# Case-insensitive, as APFS and VS Code's extension ids are: an old copy in another letter case could shadow the link.
shopt -s nullglob nocaseglob
entries=("$EXT_DIR/$ID"-*)
# The extension's earlier id (before 1.0.0). A copy left under it would answer lane_open too and open a lane twice.
legacy=("$EXT_DIR/local.callboard-panels"-*)
shopt -u nullglob nocaseglob

if [ "$REMOVE" = 1 ]; then
  n=0
  ours_list=() foreign=()
  for e in ${entries[@]+"${entries[@]}"}; do
    if ours "$e"; then ours_list+=("$e"); n=$((n + 1)); else foreign+=("$e"); say "left alone (not a link into this checkout): $e"; fi
  done
  for e in ${legacy[@]+"${legacy[@]}"}; do say "left alone (the extension's earlier id): $e"; done
  # Validate the registry files before anything is removed.
  rc=0
  if [ "$APPLY" = 1 ]; then
    py check remove "" "$EXT_DIR" "$ID" "$VER" "$TARGET" ${foreign[@]+"${foreign[@]}"} > /dev/null || rc=$?
  else
    py check remove "DRY: " "$EXT_DIR" "$ID" "$VER" "$TARGET" ${foreign[@]+"${foreign[@]}"} || rc=$?
  fi
  [ "$rc" = 0 ] || [ "$rc" = 3 ] || exit 1
  if [ "$n" -gt 0 ] || [ "$rc" = 3 ]; then guard; fi
  for e in ${ours_list[@]+"${ours_list[@]}"}; do act /bin/rm -- "$e"; done
  if [ "$APPLY" = 1 ]; then
    py write remove "" "$EXT_DIR" "$ID" "$VER" "$TARGET" ${foreign[@]+"${foreign[@]}"}
    say "removed $n link(s) into $SRC"
  else
    say "would remove $n link(s) into $SRC"
    if [ "$n" -gt 0 ] || [ "$rc" = 3 ]; then say "dry run only; add --apply to remove"; fi
  fi
  exit 0
fi

# Check everything before changing anything, so a refusal leaves the folder and VS Code's files as they were.
stale=()
already=0
for e in ${legacy[@]+"${legacy[@]}"}; do
  die "$e is a copy under the extension's earlier id and would open every lane twice; remove it yourself, then run this again"
done
for e in ${entries[@]+"${entries[@]}"}; do
  if ours "$e"; then
    if [ "$e" = "$TARGET" ]; then already=1; else stale+=("$e"); fi
  else
    die "$e is not a link into this checkout (an old copy, or a link elsewhere); remove it yourself, then run this again"
  fi
done
rc=0
if [ "$APPLY" = 1 ]; then
  py check apply "" "$EXT_DIR" "$ID" "$VER" "$TARGET" > /dev/null || rc=$?
else
  py check apply "DRY: " "$EXT_DIR" "$ID" "$VER" "$TARGET" || rc=$?
fi
[ "$rc" = 0 ] || [ "$rc" = 3 ] || exit 1
need=0
if [ "$already" = 0 ] || [ "${#stale[@]}" -gt 0 ] || [ "$rc" = 3 ]; then need=1; fi
if [ "$need" = 1 ]; then guard; fi

[ -d "$EXT_DIR" ] || act /bin/mkdir -p -- "$EXT_DIR"
# The registry first: a failed write then leaves no link yet, and a dangling entry is replaced by the next run. The
# other order could leave a bare link, the state this script exists to prevent.
if [ "$APPLY" = 1 ] && [ "$rc" = 3 ]; then
  py write apply "" "$EXT_DIR" "$ID" "$VER" "$TARGET"
fi
for e in ${stale[@]+"${stale[@]}"}; do act /bin/rm -- "$e"; done
if [ "$already" = 1 ]; then
  say "already linked: $TARGET -> $SRC"
else
  act /bin/ln -s -n -- "$SRC" "$TARGET"
  if [ "$APPLY" = 1 ]; then
    ours "$TARGET" || die "the link at $TARGET did not come out as expected"
    say "linked: $TARGET -> $SRC"
  fi
fi
if [ "$APPLY" = 1 ] && [ "$rc" = 3 ]; then
  rc=0
  py check apply "" "$EXT_DIR" "$ID" "$VER" "$TARGET" > /dev/null || rc=$?
  [ "$rc" = 0 ] || die "the registry entry in $EXT_DIR/extensions.json did not come out as expected"
fi
if [ "$need" = 0 ]; then
  :
elif [ "$APPLY" = 1 ]; then
  say "start VS Code to load version $VER"
else
  say "dry run only; add --apply to link"
fi
