#!/usr/bin/python3
"""Runaway-session usage watcher.

Run every ~5 min by launchd. Reads only usage metadata appended to Claude Code session
logs since the last run and atomically writes one bounded usage-summary.json. It never
reads message text, never messages a session, and never writes outside its output dir.
Built from a design spec and its review (see README.md).

Python 3.9 stdlib only (the pinned /usr/bin/python3 on macOS).
"""
import argparse
import glob
import hashlib
import json
import math
import os
import re
import socket
import stat
import sys
import tempfile
import time
from datetime import datetime, timezone

VERSION = 5
STALE_AFTER_S = 900
BUCKET_S = 600
KEEP_S = 24 * 3600
KEY_KEEP_S = 24 * 3600
KEYS_MAX = 60000
CTX_RING = 20
WINDOW_S = 5 * 3600
METER_MAX_AGE_S = 30 * 60
LOCK_STALE_S = 10 * 60
STATE_MAX_BYTES = 4 * 1024 * 1024
SUMMARY_MAX_BYTES = 4096
ERR_LOG_MAX_BYTES = 64 * 1024
HEARTBEAT_MAX_BYTES = 16 * 1024
METER_LOG_MAX_BYTES = 256 * 1024  # about 2000 lines; past this the oldest half is dropped
METER_LOG_TAIL = 1024
METER_LOG_REFRESH_S = 3600  # an unchanged reading is logged again once the last line is this old
WEEK_S = 7 * 86400
WEEK_FRESH_S = 6 * 3600  # a weekly figure moves slowly: fresh while seen within this, dim after
PACE_WARN = {"five": 100, "week": 90}  # statusline.sh FIVE_HOUR_WARN_AT / WEEKLY_WARN_AT
PACE_DAMP_BELOW = 25  # statusline.sh RATE_DAMP_BELOW
METERS_ACCOUNTS_MAX = 8
LABEL_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,15}$")  # an account label: AIT_ACCOUNT, as the hook and statusline.sh check it
LABEL_FILES_MAX = 500
LABEL_FILE_MAX_BYTES = 1024
LABEL_FILE_KEEP_S = 30 * 86400  # a session's label file older than this belongs to a session long gone
READING_MAX_BYTES = 65536
READING_SRCS = ("statusline", "mod", "probe")
TOP_N = 8
EXTRA_LEVELED_MAX = 4
ALERTS_MAX = 5
NAME_MAX = 24
MIN_CALLS = 10
CALLS_SPAN_S = 3600
ACTIVE_S = 1800
DEGRADED_RUNS = 3
CORRUPT_LOG_MAX = 5
USAGE_FIELD_MAX = 10 ** 8
FUTURE_SLACK_S = 300
# cacheExpiring: a big session idle long enough that its 1h prompt cache is about to lapse.
# Floor: 30-min MANAGER tick - 5-min watcher period - the in-tick delay before a ping, so a
# pinged session shows at the next tick. Ceiling: the same margin before the 1h TTL.
CACHE_IDLE_MIN, CACHE_IDLE_MAX = 20, 50
CACHE_CTX_MIN = 200_000  # default of --cache-ctx-min: the keep-warm break-even sits near 200k
CACHE_WORK_MAX_MIN = 180
WORK_OUTPUT_MIN = 200  # a main call with more output than this is real work, not a keepalive reply
CACHE_MAX = 5
# compactSoon: a session past the context where compacting at its next task boundary pays off.
COMPACT_SOON_CTX = 250_000
COMPACT_SOON_MAX = 5
# Trial (ran 2026-11-01, ended there: the 5h share stays, 1h was noisy, 2h and 3h tracked it within 0.03-0.08):
# when set, each top row also carries `shareH`, its share of the machine's tokens over the last N hours for each
# N here, and the summary carries `shareHours`. For comparison only: no alert reads them. Empty means off.
TRIAL_HOURS = ()

# Thresholds (raw tokens, per session). Spec section 3, ctxAvg warn paired with burn/share
# and a MIN_CALLS floor per the review.
WIN_GATE_TOTAL = 100_000_000
WIN_GATE_SESSION = 30_000_000
SHARE_WARN, SHARE_RUN = 0.50, 0.65
BURN_WARN, BURN_RUN = 55_000_000, 100_000_000
CTXAVG_WARN, CTXAVG_RUN = 250_000, 400_000
CTXNOW_RUN = 500_000
COMP_WARN, COMP_RUN = 6, 12
METER_WARN, METER_RUN = 70, 90

FAMILIES = ("opus", "sonnet", "haiku", "fable")
USAGE_FIELDS = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
# Cheap byte prefilter: only lines containing one of these are parsed at all.
PREFILTER = (b'"type":"assistant"', b'compact_boundary', b'"type":"custom-title"', b'"type":"agent-name"')
# Loose drift probe: a usage-bearing line the prefilter may no longer recognise.
PROBE = b'"usage"'
SAFE_RE = re.compile(r"[^A-Za-z0-9 _.\-]")
SID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")


def safe(s, limit=NAME_MAX):
    """Allowlist a session-controlled string to [A-Za-z0-9 _.-], then bound its length."""
    if not isinstance(s, str):
        return None
    out = SAFE_RE.sub("_", s).strip()[:limit]
    return out or None


ERR_FD = None


def err(msg):
    line = "%s %s\n" % (datetime.now().isoformat(timespec="seconds"), msg)
    if ERR_FD is not None:
        os.write(ERR_FD, line.encode())
    else:
        sys.stderr.write(line)


def parse_ts(v):
    if not isinstance(v, str):
        return None
    try:
        t = datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    except (ValueError, OverflowError, OSError):
        return None
    return t if math.isfinite(t) else None


def iso(epoch):
    try:
        return datetime.fromtimestamp(epoch, timezone.utc).astimezone().isoformat(timespec="seconds")
    except (ValueError, OverflowError, OSError, TypeError):
        return None


def family(model):
    m = (model or "").lower()
    for f in FAMILIES:
        if f in m:
            return f
    return "other"


def open_regular(path, flags=os.O_RDONLY):
    """Open without following a symlink, and only a regular file. O_NONBLOCK so a FIFO planted at the path
    fails the check below instead of blocking the open until a writer appears; it changes nothing for a file."""
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise OSError("not a regular file")
    return fd


def read_json(path):
    with os.fdopen(open_regular(path), "r") as f:
        return json.load(f)


def atomic_write(out_dir, name, data):
    fd, tmp = tempfile.mkstemp(dir=out_dir, prefix=".tmp.")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(data)
        os.replace(tmp, os.path.join(out_dir, name))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ensure_out_dir(path):
    """The output dir must be a real directory owned by us; tighten its mode to 0700."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        raise SystemExit("output dir %s is not a directory owned by this user; refusing" % path)
    if stat.S_IMODE(st.st_mode) & 0o077:
        os.chmod(path, 0o700)


# ---------------------------------------------------------------- extraction

def extract(raw):
    """Parse one prefiltered line into a whitelisted dict, or None.

    The parsed object is dropped before returning: only the fields named in the spec survive,
    session-controlled strings are allowlisted here, and message content is never kept,
    logged or compared against.
    """
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        return None
    t = obj.get("type")
    out = None
    if t == "assistant":
        msg = obj.get("message")
        if isinstance(msg, dict) and msg.get("model") == "<synthetic>":
            out = None
        elif isinstance(msg, dict) and isinstance(msg.get("usage"), dict):
            u = msg["usage"]
            vals = [u.get(k) for k in USAGE_FIELDS]
            vals = [v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else 0 for v in vals]
            if any(v > USAGE_FIELD_MAX for v in vals):
                out = {"k": "bad"}
            else:
                model = msg.get("model") if isinstance(msg.get("model"), str) else ""
                out = {
                    "k": "use",
                    "ts": parse_ts(obj.get("timestamp")),
                    "id": ("%s|%s" % (msg.get("id"), obj.get("requestId"))
                           if msg.get("id") is not None or obj.get("requestId") is not None else None),
                    "fam": family(model),
                    "side": obj.get("isSidechain") is True,
                    "u": vals,
                    "ep": safe(obj.get("entrypoint"), 24),
                }
        else:
            out = {"k": "asst"}
    elif t == "system" and obj.get("subtype") == "compact_boundary":
        out = {"k": "comp", "ts": parse_ts(obj.get("timestamp"))}
    elif t == "custom-title" and isinstance(obj.get("customTitle"), str):
        out = {"k": "name", "v": safe(obj["customTitle"])}
    elif t == "agent-name" and isinstance(obj.get("agentName"), str):
        out = {"k": "name", "v": safe(obj["agentName"])}
    del obj
    return out


# ---------------------------------------------------------------- state

def new_file_state(state, st, sid, sub):
    state["nextFid"] = state.get("nextFid", 0) + 1
    return {"fid": state["nextFid"], "ino": st.st_ino, "size": 0, "off": 0, "sid": sid, "sub": sub,
            "lastSeen": st.st_mtime, "b": {}, "ctx": [], "comp": [], "last": 0, "lastMain": 0, "lastWork": 0,
            "name": None, "ep": None}


def key_hash(k):
    return hashlib.sha1(k.encode("utf-8", "replace")).hexdigest()[:16]


def apply_usage(keys, fs, rec, now):
    """Fold one usage record into the file's buckets. Returns True when it was applied.

    Dedupe keys are shared across every file: a resumed or forked session's log repeats the
    old records with the same ids and timestamps, so only the file that first supplied a key
    (its owner, fid) counts it; a copy adds only a later increase.
    """
    ts = rec["ts"]
    if ts is None or ts < now - KEEP_S or ts > now + FUTURE_SLACK_S:
        return False
    # A record with no ids can only be deduped within its own file.
    kh = key_hash(rec["id"] if rec["id"] is not None else "noid|%d|%r" % (fs["fid"], ts))
    prev = keys.get(kh)
    if prev is None:
        merged = [ts] + rec["u"] + [fs["fid"]]
        delta = rec["u"]
        new_call = True
    else:
        merged = [prev[0]] + [max(a, b) for a, b in zip(prev[1:5], rec["u"])] + [prev[5]]
        delta = [m - p for m, p in zip(merged[1:5], prev[1:5])]
        new_call = False
    keys[kh] = merged
    owned = merged[5] == fs["fid"]
    fs["last"] = max(fs["last"], merged[0])
    tok = sum(delta)
    bstart = str(int(merged[0] // BUCKET_S * BUCKET_S))
    b = fs["b"].setdefault(bstart, {})
    fam = rec["fam"] + (".s" if (rec["side"] or fs["sub"]) else ".m")
    if tok:
        b[fam] = b.get(fam, 0) + tok
    if new_call:
        b["n"] = b.get("n", 0) + 1
    if rec["ep"]:
        fs["ep"] = rec["ep"]
    if owned and not fs["sub"] and not rec["side"]:
        fs["lastMain"] = max(fs["lastMain"], merged[0])
        if merged[2] > WORK_OUTPUT_MIN:
            fs["lastWork"] = max(fs["lastWork"], merged[0])
        ctx = merged[1] + merged[3] + merged[4]
        ring = fs["ctx"]
        for item in ring:
            if item[2] == kh:
                item[1] = ctx
                break
        else:
            ring.append([merged[0], ctx, kh])
            ring.sort(key=lambda x: x[0])
            del ring[:-CTX_RING]
    return True


def read_file(path, fs, keys, now, health):
    """Read appended complete lines from fs['off']; hold back a partial trailing line."""
    with os.fdopen(open_regular(path), "rb") as f:
        f.seek(fs["off"])
        while True:
            line = f.readline()
            if not line or not line.endswith(b"\n"):
                break
            fs["off"] += len(line)
            if PROBE in line and b"<synthetic>" not in line:
                health["probe"] += 1
            if not any(p in line for p in PREFILTER):
                continue
            try:
                rec = extract(line)
            except (ValueError, RecursionError):
                rec = {"k": "bad"}
            if rec is None:
                continue
            if rec["k"] == "bad":
                health["corrupt"] += 1
                if health["corrupt"] <= CORRUPT_LOG_MAX:
                    err("corrupt line in %s at byte %d" % (path, fs["off"] - len(line)))
                continue
            if rec["k"] in ("asst", "use"):
                health["candidates"] += 1
            if rec["k"] == "use":
                if rec["ts"] is not None:
                    health["parsed"] += 1
                if apply_usage(keys, fs, rec, now):
                    health["applied"] += 1
            elif rec["k"] == "comp":
                if rec["ts"] is not None and now - KEEP_S <= rec["ts"] <= now + FUTURE_SLACK_S:
                    # A resumed log copies old compactions too; only the first file counts one.
                    kh = key_hash("comp|%r" % rec["ts"])
                    if kh not in keys:
                        keys[kh] = [rec["ts"], 0, 0, 0, 0, fs["fid"]]
                        fs["comp"].append(rec["ts"])
            elif rec["k"] == "name" and not fs["sub"] and rec["v"]:
                fs["name"] = rec["v"]


def prune_keys(state, now, key_keep=KEY_KEEP_S, keys_max=KEYS_MAX):
    kcut = now - key_keep
    keys = {k: v for k, v in state["keys"].items() if v[0] >= kcut}
    if len(keys) > keys_max:
        keys = dict(sorted(keys.items(), key=lambda kv: kv[1][0])[-keys_max:])
    state["keys"] = keys


def prune_file(fs, now):
    bcut = now - KEEP_S
    fs["b"] = {k: v for k, v in fs["b"].items() if int(k) >= bcut - BUCKET_S}
    fs["comp"] = [t for t in fs["comp"] if t >= bcut]
    fs["ctx"] = [c for c in fs["ctx"] if c[0] >= bcut]


def scan(config_dir, state, now, health):
    files = state["files"]
    keys = state["keys"]
    base = os.path.join(config_dir, "projects")
    paths = glob.glob(os.path.join(base, "*", "*.jsonl"))
    paths += glob.glob(os.path.join(base, "*", "*", "subagents", "**", "*.jsonl"), recursive=True)
    stats = []
    for path in paths:
        try:
            stats.append((path, os.lstat(path)))
        except OSError:
            continue
    # Oldest-created first, so on a rebuild an original log owns the keys its copies repeat.
    stats.sort(key=lambda ps: getattr(ps[1], "st_birthtime", ps[1].st_mtime))
    seen = set()
    for path, st in stats:
        if not stat.S_ISREG(st.st_mode) or st.st_mtime < now - KEEP_S:
            continue
        rel = os.path.relpath(path, base).split(os.sep)
        sub = len(rel) > 2
        sid = rel[1] if sub else rel[1][:-len(".jsonl")]
        if not SID_RE.match(sid):
            continue
        seen.add(path)
        fs = files.get(path)
        if fs is None or fs.get("ino") != st.st_ino or st.st_size < fs.get("off", 0):
            if fs is not None:
                old = fs["fid"]
                for k in [k for k, v in keys.items() if v[5] == old]:
                    del keys[k]
            fs = new_file_state(state, st, sid, sub)
            files[path] = fs
        fs["proj"] = safe(rel[0][-NAME_MAX:])
        if st.st_size > fs["off"]:
            try:
                read_file(path, fs, keys, now, health)
            except Exception as e:  # one bad file must not blind the whole run
                err("read failed for %s: %s" % (path, e.__class__.__name__))
        fs["size"] = st.st_size
        fs["lastSeen"] = st.st_mtime
        prune_file(fs, now)
    for path in list(files):
        if path not in seen and files[path].get("lastSeen", 0) < now - KEEP_S:
            del files[path]
    prune_keys(state, now)


# ---------------------------------------------------------------- inputs: meter + registry

def valid_label(v):
    # fullmatch, not match: `$` also matches before a trailing newline, which the hook's and the status line's
    # bash test rejects, so "second\n" would otherwise be a second account beside "second".
    return v if isinstance(v, str) and LABEL_RE.fullmatch(v) else None


def labelled_file(path):
    """True when a readings file belongs to a labelled account (AIT_ACCOUNT), which is never the summary's meter.
    Read with the size cap read_accounts uses: the optional spool may be writable by other processes, and this
    runs on every personal-windows file before the one-file check, so a huge planted file must not be parsed."""
    try:
        with os.fdopen(open_regular(path), "r") as f:
            raw = f.read(READING_MAX_BYTES + 1)
        if len(raw) > READING_MAX_BYTES:
            return False
        d = json.loads(raw)
    except (OSError, ValueError, RecursionError):
        return False
    return isinstance(d, dict) and valid_label(d.get("label")) is not None


def read_labels(out_dir, now):
    """sid -> account label for the sessions that have one: <out-dir>/accounts/<sid>.json, written by
    account-stamp.sh at session start. A session without a file is the main account. Regular files only,
    small, and a file older than LABEL_FILE_KEEP_S is ignored. Bounded in number AFTER those filters, newest
    first: nothing deletes a label file, so a cap taken on the raw listing would one day be filled by old files
    and temp files, and a live labelled session would silently count as the main account."""
    base = os.path.join(out_dir, "accounts")
    try:
        names = os.listdir(base)
    except OSError:
        return {}
    cands = []
    for fn in names:
        sid = fn[:-len(".json")] if fn.endswith(".json") else ""
        if not SID_RE.fullmatch(sid):
            continue
        try:
            mtime = os.lstat(os.path.join(base, fn)).st_mtime
        except OSError:
            continue
        if now - LABEL_FILE_KEEP_S <= mtime <= now + 60:
            cands.append((mtime, fn))
    labels = {}
    for _, fn in sorted(cands, reverse=True)[:LABEL_FILES_MAX]:
        sid = fn[:-len(".json")]
        try:
            fd = open_regular(os.path.join(base, fn))
            with os.fdopen(fd, "r") as f:
                mtime = os.fstat(f.fileno()).st_mtime
                raw = f.read(LABEL_FILE_MAX_BYTES + 1)
            if len(raw) > LABEL_FILE_MAX_BYTES or not (now - LABEL_FILE_KEEP_S <= mtime <= now + 60):
                continue
            d = json.loads(raw)
        except (OSError, ValueError, RecursionError):
            continue
        lab = valid_label(d.get("label")) if isinstance(d, dict) else None
        if lab:
            labels[sid] = lab
    return labels


def oversized(path):
    """True when the file at path is over READING_MAX_BYTES (by its size; nothing is read). False when it
    cannot be stat'ed: the read that follows fails on it as before."""
    try:
        return os.lstat(path).st_size > READING_MAX_BYTES
    except OSError:
        return False


def read_meter(spool, now, fp):
    """The 5h/7d meter from personal-windows-<fp>.json. With no fp, only an unambiguous single file; a file of
    a labelled account (AIT_ACCOUNT) is not the main account's meter and does not count."""
    pattern = "personal-windows-%s.json" % fp if fp else "personal-windows-*.json"
    # An oversized file is skipped before the one-file count (the read_accounts cap): the optional spool may be
    # writable by other processes, so a planted huge file must neither be parsed nor make the meter ambiguous.
    paths = [p for p in glob.glob(os.path.join(spool, "limits", pattern)) if not oversized(p)]
    if not fp:
        paths = [p for p in paths if not labelled_file(p)]
    if len(paths) != 1:
        return None
    path = paths[0]
    try:
        mtime = os.lstat(path).st_mtime
        if mtime > now + 60:
            return None
        with os.fdopen(open_regular(path), "r") as f:
            raw = f.read(READING_MAX_BYTES + 1)
        if len(raw) > READING_MAX_BYTES:
            return None
        d = json.loads(raw)
    except (OSError, ValueError, RecursionError):
        return None
    if not isinstance(d, dict):
        return None

    def win(key, horizon):
        w = d.get(key)
        if not isinstance(w, dict):
            return None
        pct, ra = w.get("used_percentage"), w.get("resets_at")
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (pct, ra)):
            return None
        # A window whose reset has passed describes the last window, not this one (q5, 2026-10-27).
        if not (0 <= pct <= 100) or not (now < ra <= now + horizon + 60):
            return None
        return {"pct": int(round(pct)), "resetsAt": ra}

    five, week = win("five_hour", WINDOW_S), win("seven_day", 7 * 86400)
    # The statusline rewrites a borrowed value on every render, so the mtime says nothing about when
    # the five-hour value was last seen live. Its own observed_at does; -1 means unknown, never fresh.
    # A file without the field (a statusline from before q5) keeps the mtime rule.
    seen = mtime
    live = False  # harvestedAt is a real observation time, not the file's mtime
    w5 = d.get("five_hour")
    if isinstance(w5, dict) and "observed_at" in w5:
        obs = w5.get("observed_at")
        ok = isinstance(obs, (int, float)) and not isinstance(obs, bool) and math.isfinite(obs) and 0 <= obs <= now + 60
        seen = obs if ok else None
        live = ok
    fresh = bool(five) and seen is not None and (now - seen) <= METER_MAX_AGE_S
    # The weekly figure has its own observed_at and a slower freshness (the rule meters.json uses).
    wseen = mtime
    wlive = False  # weekSeenAt is a real observation time, not the file's mtime
    w7 = d.get("seven_day")
    if isinstance(w7, dict) and "observed_at" in w7:
        obs = w7.get("observed_at")
        ok = isinstance(obs, (int, float)) and not isinstance(obs, bool) and math.isfinite(obs) and 0 <= obs <= now + 60
        wseen = obs if ok else None
        wlive = ok
    week_fresh = bool(week) and wseen is not None and (now - wseen) <= WEEK_FRESH_S
    return {"fresh": fresh, "weekFresh": week_fresh, "five": five, "week": week,
            "harvestedAt": seen if seen is not None else mtime, "harvestLive": live,
            "weekSeenAt": wseen if wseen is not None else mtime, "weekLive": wlive}


def elapsed_pct(window_s, resets_at, now):
    """Whole percent of the window gone, floored; the status line's time_pct (integer seconds)."""
    elapsed = min(max(int(now) - (int(resets_at) - window_s), 0), window_s)
    return elapsed * 100 // window_s


def pace(used, elapsed, warn_at, damp_below=PACE_DAMP_BELOW):
    """(projected end %, state) for whole-percent inputs; the Python port of statusline.sh rate_color_for.

    The projection is used*100//elapsed, the overshoot the status line colours on. States, with the
    colour code the status line prints: idle/ok 245, watch 144, warn 131, hot 168. pace-vectors.tsv (a pinned
    copy beside this file) holds the bash function's own answers for a grid of inputs and test_watch.py checks
    every row.
    """
    if used <= 0 or elapsed <= 5:
        return None, "idle"
    over = used * 100 // elapsed
    if over <= warn_at:
        return over, "ok"
    if used < damp_below:
        return over, "watch"
    if over > warn_at + 60:
        return over, "hot"
    if over > warn_at + 25:
        return over, "warn"
    return over, "watch"


def _num(v):
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return False
    try:
        return math.isfinite(v)
    except OverflowError:  # an int too large for a float
        return False


def meter_window(w, key, now, mtime):
    """One window of a readings file as the meters.json entry, or None when it is not this window's."""
    if not isinstance(w, dict):
        return None
    window_s = WINDOW_S if key == "five" else WEEK_S
    pct, ra = w.get("used_percentage"), w.get("resets_at")
    if not (_num(pct) and _num(ra)) or not (0 <= pct <= 100) or not (now < ra <= now + window_s + 60):
        return None  # a window past its reset describes the last window
    # Absent observed_at (a file from before q5): the mtime. Present but invalid, such as the status line's -1
    # for a borrowed value of unknown age: the age is unknown, never fresh (the same rule as read_meter). The
    # status line rewrites the file on every render, so the mtime would make such a value look new.
    if "observed_at" in w:
        obs = w["observed_at"]
        obs = int(obs) if _num(obs) and 0 <= obs <= now + 60 else None
    else:
        obs = int(mtime)
    src = w.get("src") if w.get("src") in READING_SRCS else "statusline"
    used, ra = int(round(pct)), int(ra)
    el = elapsed_pct(window_s, ra, now)
    start = ra - window_s
    age = max(int(now) - obs, 0) if obs is not None else None
    fresh = age is not None and age <= (METER_MAX_AGE_S if key == "five" else WEEK_FRESH_S)
    # The pace divides a reading by the time elapsed NOW, so on an old reading it would drift down as the
    # reading ages. A stale one gets no projection; the reader shows it dim with its age.
    proj, state, hits = None, "stale", None
    if fresh:
        proj, state = pace(used, el, PACE_WARN[key])
        if 0 < used < 100 and int(now) > start:
            h = start + (int(now) - start) * 100 // used
            hits = h if h < ra else None
    return {"used": used, "windowStart": start, "windowEnd": ra, "elapsedPct": el, "projectedEndPct": proj,
            "state": state, "hitsAt": hits, "observedAt": obs, "ageS": age, "src": src, "fresh": fresh}


def read_accounts(out_dir, spool, now):
    """Windows per account: limits/readings-<fp>.json in out_dir first, the spool's personal-windows-<fp>.json
    for an account the new directory does not have."""
    found, seen, examined = {}, set(), 0
    for base, prefix, fallback in ((os.path.join(out_dir, "limits"), "readings-", False),
                                   (os.path.join(spool, "limits"), "personal-windows-", True)):
        for path in sorted(glob.glob(os.path.join(base, prefix + "*.json"))):
            fp = os.path.basename(path)[len(prefix):-len(".json")]
            if not re.fullmatch(r"[0-9a-f]{6,64}", fp) or (fallback and fp in seen):
                continue
            examined += 1
            if examined > METERS_ACCOUNTS_MAX * 2:
                return found
            try:
                fd = open_regular(path)
                with os.fdopen(fd, "r") as f:
                    mtime = os.fstat(f.fileno()).st_mtime
                    raw = f.read(READING_MAX_BYTES + 1)
                if mtime > now + 60 or len(raw) > READING_MAX_BYTES:
                    continue
                d = json.loads(raw)
                if not isinstance(d, dict):
                    continue
                seen.add(fp)  # this directory has the account, even if both windows are past
                five = meter_window(d.get("five_hour"), "five", now, mtime)
                week = meter_window(d.get("seven_day"), "week", now, mtime)
            except (OSError, ValueError, ArithmeticError, RecursionError):
                continue
            if (five or week) and len(found) < METERS_ACCOUNTS_MAX:
                found[fp] = {"fiveHour": five, "sevenDay": week}
                lab = valid_label(d.get("label"))
                if lab:  # additive: only a labelled account (AIT_ACCOUNT) names itself
                    found[fp]["label"] = lab
    return found


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, OverflowError, ValueError):
        return False


def read_registry(config_dir):
    """Live sessions from ~/.claude/sessions/<pid>.json (never the .key files)."""
    entries = []
    for path in glob.glob(os.path.join(config_dir, "sessions", "*.json")):
        try:
            d = read_json(path)
        except (OSError, ValueError):
            continue
        if not isinstance(d, dict):
            continue
        sid, pid = d.get("sessionId"), d.get("pid")
        if not isinstance(sid, str) or not isinstance(pid, int) or isinstance(pid, bool):
            continue
        if not (0 < pid < 2 ** 31) or os.path.basename(path) != "%d.json" % pid or not pid_alive(pid):
            continue
        raw = d.get("name") if isinstance(d.get("name"), str) else None
        cwd = d.get("cwd")
        entries.append({
            "sid": sid,
            "raw": raw,
            "name": safe(raw),
            "kind": safe(d.get("kind"), 16),
            "entrypoint": safe(d.get("entrypoint"), 24),
            "project": safe(os.path.basename(cwd.rstrip("/"))) if isinstance(cwd, str) else None,
        })
    by_sid, names = {}, {}
    for e in entries:
        by_sid.setdefault(e["sid"], []).append(e)
        if e["name"]:
            names[e["name"]] = names.get(e["name"], 0) + 1
    reg = {}
    for sid, es in by_sid.items():
        e = dict(es[0])
        # Addressable only when this sid has one live entry whose name is unique, and the
        # allowlist left it unchanged, so ListAgents shows exactly this string.
        e["exact"] = (len(es) == 1 and e["raw"] is not None and e["raw"] == e["name"]
                      and names.get(e["name"]) == 1)
        reg[sid] = e
    return reg


# ---------------------------------------------------------------- aggregation

def rolling_bounds(now, hours):
    """The last `hours` hours as whole 10-minute buckets: [start, end) with end the close of the bucket holding
    `now`, so the call in progress counts. Covers `hours` hours minus up to 10 min of real time."""
    end = (int(now) // BUCKET_S + 1) * BUCKET_S
    return end - hours * 3600, end


def rolling_default_window(now):
    ws, we = rolling_bounds(now, WINDOW_S // 3600)
    return ws, we, "rolling"


def current_window(meter, now):
    """The window share and the session alerts are measured over: the meter's 5h window when it has a future
    reset (source "meter"), else the last 5 hours (source "rolling"). With no live meter window there is no
    real window, so a guessed fixed block would only misplace the share; the rolling one always holds the
    recent burn."""
    if meter and meter["five"] and now < meter["five"]["resetsAt"] <= now + WINDOW_S + 60:
        end = meter["five"]["resetsAt"]
        return end - WINDOW_S, end, "meter"
    ws, we = rolling_bounds(now, WINDOW_S // 3600)
    return ws, we, "rolling"


def account_windows(accounts, now):
    """label -> (start, end, source) for each labelled account: its own 5h window when the readings have one with
    a future reset (source "meter"), else the last 5 hours ("rolling"), the rule current_window applies to the main
    account. Each account's quota is its own, so a session's share is measured against its own account's window."""
    out = {}
    for ent in (accounts or {}).values():
        lab = ent.get("label")
        if not lab:
            continue
        five = ent.get("fiveHour")
        if five and now < five["windowEnd"] <= now + WINDOW_S + 60:
            out[lab] = (five["windowStart"], five["windowEnd"], "meter")
        else:
            ws, we = rolling_bounds(now, WINDOW_S // 3600)
            out[lab] = (ws, we, "rolling")
    return out


def summarize(state, meter, reg, now, labels=None, accounts=None):
    labels = labels or {}
    sessions = {}
    midnight = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    for fs in state["files"].values():
        s = sessions.setdefault(fs["sid"], {"b": {}, "ctx": [], "comp": 0, "name": None, "ep": None,
                                            "proj": fs.get("proj"), "last": 0, "lastMain": 0, "lastWork": 0})
        for bk, fams in fs["b"].items():
            bt = int(bk)
            dst = s["b"].setdefault(bt, {})
            for k, v in fams.items():
                dst[k] = dst.get(k, 0) + v
        if not fs["sub"]:
            s["comp"] += sum(1 for t in fs["comp"] if t >= midnight)
            s["ctx"].extend(fs["ctx"])
            s["name"] = fs["name"] or s["name"]
            s["ep"] = fs["ep"] or s["ep"]
        s["last"] = max(s["last"], fs.get("last", 0))
        s["lastMain"] = max(s["lastMain"], fs.get("lastMain", 0))
        s["lastWork"] = max(s["lastWork"], fs.get("lastWork", 0))

    state.pop("win", None)  # the persisted estimate of earlier versions; unused now
    main_win = current_window(meter, now)
    windows = {None: main_win}
    windows.update(account_windows(accounts, now))
    ws, we, wsrc = main_win
    trial = [rolling_bounds(now, h) for h in TRIAL_HOURS]
    # burnH: the last three complete buckets, exactly 30 min, as the thresholds were calibrated.
    burn_to = int(now // BUCKET_S * BUCKET_S)
    burn_from = burn_to - 3 * BUCKET_S

    rows = []
    totals = {}  # account label (None: the main account) -> tokens in that account's window
    trial_total = [0] * len(trial)
    for sid, s in sessions.items():
        grp = labels.get(sid)
        gws, gwe, _ = windows.get(grp) or rolling_default_window(now)
        tok = opus = sub = calls = burn = 0
        tok_h = [0] * len(trial)
        for bt, fams in s["b"].items():
            if bt >= now - CALLS_SPAN_S - BUCKET_S:
                calls += fams.get("n", 0)
            spend = sum(v for k, v in fams.items() if k != "n")
            if burn_from <= bt < burn_to:
                burn += spend
            for i, (t0, t1) in enumerate(trial):
                if t0 <= bt < t1:
                    tok_h[i] += spend
            if gws is None or not (gws <= bt < gwe):
                continue
            tok += spend
            opus += sum(v for k, v in fams.items() if k.startswith("opus."))
            sub += sum(v for k, v in fams.items() if k.endswith(".s"))
        ring = sorted(s["ctx"], key=lambda x: x[0])[-CTX_RING:]
        r = reg.get(sid)
        if r and r["name"]:
            name, name_src = r["name"], "registry"
        elif s["name"]:
            name, name_src = s["name"], "log"
        else:
            name, name_src = sid[:8], "sid"
        rows.append({
            "sid": sid,
            "name": name,
            "nameSrc": name_src,
            "live": r is not None,
            "kind": (r or {}).get("kind"),
            "addr": bool(r and r["exact"] and r["kind"] == "interactive"),
            "entrypoint": (r or {}).get("entrypoint") or s["ep"],
            "project": (r or {}).get("project") or s["proj"],
            "tok": tok,
            "opus": round(opus / tok, 2) if tok else 0,
            "sub": round(sub / tok, 2) if tok else 0,
            "burnH": burn * 3600 // (burn_to - burn_from),
            "ctxNow": ring[-1][1] if ring else 0,
            "ctxAvg": sum(x[1] for x in ring) // len(ring) if ring else 0,
            "compToday": s["comp"],
            "calls": calls,
            "active": s["last"] >= now - ACTIVE_S,
            "last": iso(s["last"]) if s["last"] else None,
            "_lastMain": s["lastMain"],
            "_lastWork": s["lastWork"],
            "_tokH": tok_h,
        })
        if grp:
            rows[-1]["acct"] = grp  # additive: only a session of a labelled account carries the field
        totals[grp] = totals.get(grp, 0) + tok
        for i, v in enumerate(tok_h):
            trial_total[i] += v
    for row in rows:
        gt = totals.get(row.get("acct"), 0)
        row["share"] = round(row["tok"] / gt, 2) if gt else 0
        tok_h = row.pop("_tokH")
        if trial:
            row["shareH"] = [round(v / t, 2) if t else 0 for v, t in zip(tok_h, trial_total)]
    return rows, totals, ws, we, wsrc, windows


def classify(row, total, prev_warn):
    """Return (level, why, warn_line). Warn needs its line on two consecutive runs (prev_warn).

    Context and compaction lines count only for a session active in the last 30 min, so an
    idle or ended session does not keep alerting on its last big turn.
    """
    run, warn = [], []
    if row["calls"] < MIN_CALLS:
        return None, [], False
    gated = total >= WIN_GATE_TOTAL and row["tok"] >= WIN_GATE_SESSION
    share, burn = row["share"], row["burnH"]
    if gated and share >= SHARE_RUN:
        run.append("share %d%% >= %d%%" % (round(share * 100), round(SHARE_RUN * 100)))
    elif gated and share >= SHARE_WARN:
        warn.append("share %d%% >= %d%%" % (round(share * 100), round(SHARE_WARN * 100)))
    if burn >= BURN_RUN:
        run.append("burnH %dM >= 100M" % (burn // 1_000_000))
    elif burn >= BURN_WARN:
        warn.append("burnH %dM >= 55M" % (burn // 1_000_000))
    if row["active"]:
        if row["ctxAvg"] >= CTXAVG_RUN:
            run.append("ctxAvg %dk >= 400k" % (row["ctxAvg"] // 1000))
        elif row["ctxAvg"] >= CTXAVG_WARN and (warn or run):
            warn.append("ctxAvg %dk >= 250k" % (row["ctxAvg"] // 1000))
        if row["ctxNow"] >= CTXNOW_RUN:
            run.append("ctxNow %dk >= 500k" % (row["ctxNow"] // 1000))
        if row["compToday"] >= COMP_RUN:
            run.append("compToday %d >= 12" % row["compToday"])
        elif row["compToday"] >= COMP_WARN:
            warn.append("compToday %d >= 6" % row["compToday"])
    if run:
        return "runaway", run + warn, bool(warn)
    if warn:
        return ("warn" if prev_warn else None), warn, True
    return None, [], False


def alert_of(r, src, level, why):
    out = {"sid": r["sid"] if r else None, "sid8": r["sid"][:8] if r else None,
           "name": r["name"] if r else None, "live": bool(r and r["live"]),
           "kind": r["kind"] if r else None, "addr": bool(r and r["addr"]),
           "src": src, "level": level, "why": why}
    if r and r.get("acct"):
        out["acct"] = r["acct"]  # additive: the labelled account the session runs on; absent for the main account
    return out


def meter_pace(meter, key, now):
    """(projected end %, state) for the summary meter's 'five' or 'week' window; (None, "stale") when the meter
    window is not fresh (a projection divides an old reading by the time elapsed now, so it would drift).
    The five-hour window uses the five-hour freshness, the week its own (WEEK_FRESH_S)."""
    w = meter.get(key) if meter else None
    if not w:
        return None, None
    if not meter["fresh" if key == "five" else "weekFresh"]:
        return None, "stale"
    window_s = WINDOW_S if key == "five" else WEEK_S
    return pace(int(w["pct"]), elapsed_pct(window_s, w["resetsAt"], now), PACE_WARN[key])


def pace_alerts(meter, now):
    """One 'warn' alert per window whose pace projects past its warn line (5h 100%, weekly 90%, the lines the
    status line coloured on) once at least PACE_DAMP_BELOW percent is used; never 'runaway', so it cannot start
    the stop-and-handover flow. Only on a fresh meter, like the meter alert. It names no session."""
    out = []
    for key, label in (("five", "fivepace"), ("week", "weekpace")):
        proj, state = meter_pace(meter, key, now)
        if proj is not None and proj > PACE_WARN[key] and meter[key]["pct"] >= PACE_DAMP_BELOW:
            out.append(alert_of(None, "pace", "warn", ["%s %d%% >= %d%%" % (label, proj, PACE_WARN[key])]))
    return out


def build_summary(state, meter, reg, now, health, cache_ctx_min=CACHE_CTX_MIN, labels=None, accounts=None):
    rows, totals, ws, we, wsrc, windows = summarize(state, meter, reg, now, labels, accounts)
    total = totals.get(None, 0)  # the main account's window; a labelled account's total is under `accounts`
    prev = set(state.get("warnSids", []))
    warn_now = []
    for row in rows:
        level, why, warn_line = classify(row, totals.get(row.get("acct"), 0), row["sid"] in prev)
        row["level"] = level
        row["_why"] = why
        if warn_line:
            warn_now.append(row["sid"])
    state["warnSids"] = warn_now

    alerts = []
    if meter and meter["fresh"] and meter["five"]:
        pct = meter["five"]["pct"]
        mlevel = "runaway" if pct >= METER_RUN else ("warn" if pct >= METER_WARN else None)
        if mlevel:
            why = ["meter %d%% >= %d%%" % (pct, METER_RUN if mlevel == "runaway" else METER_WARN)]
            burners = [r for r in rows if r["live"] and r["burnH"] > 0 and r["calls"] >= MIN_CALLS
                       and not r.get("acct")]  # the meter is the main account's
            topb = max(burners, key=lambda r: r["burnH"]) if burners else None
            alerts.append(alert_of(topb, "meter", mlevel, why))
    leveled = sorted((r for r in rows if r["level"]), key=lambda r: (r["level"] != "runaway", -r["burnH"]))
    for r in leveled:
        if r["live"]:
            alerts.append(alert_of(r, "session", r["level"], r["_why"][:3]))
    alerts += pace_alerts(meter, now)
    alerts = alerts[:ALERTS_MAX]

    cache = []
    for r in rows:
        if not r["live"] or r["ctxNow"] < cache_ctx_min or not r["_lastMain"]:
            continue
        idle = int((now - r["_lastMain"]) // 60)
        if not (CACHE_IDLE_MIN <= idle <= CACHE_IDLE_MAX):
            continue
        work_idle = int((now - r["_lastWork"]) // 60) if r["_lastWork"] else None
        due = "ping" if work_idle is not None and work_idle <= CACHE_WORK_MAX_MIN else "checkpoint"
        cache.append({"sid": r["sid"], "sid8": r["sid"][:8], "name": r["name"], "addr": r["addr"],
                      "ctxNow": r["ctxNow"], "idleMin": idle, "workIdleMin": work_idle, "due": due,
                      **({"acct": r["acct"]} if r.get("acct") else {})})
    cache = sorted(cache, key=lambda c: -c["ctxNow"])[:CACHE_MAX]

    # One crossing per session: its crossedAt holds until the context drops back under the line.
    prev_cross = state.get("compactSoon")
    prev_cross = prev_cross if isinstance(prev_cross, dict) else {}
    big = {r["sid"]: r for r in rows if r["ctxNow"] >= COMPACT_SOON_CTX}
    crossed = {}
    for sid in big:
        t = prev_cross.get(sid)
        crossed[sid] = t if isinstance(t, (int, float)) and 0 < t <= now else now
    state["compactSoon"] = crossed
    soon = [{"sid": sid, "sid8": sid[:8], "name": r["name"], "addr": r["addr"], "ctxNow": r["ctxNow"],
             "crossedAt": iso(crossed[sid]), **({"acct": r["acct"]} if r.get("acct") else {})}
            for sid, r in big.items() if r["live"] and r["active"]]
    soon = sorted(soon, key=lambda c: -c["ctxNow"])[:COMPACT_SOON_MAX]

    by_tok = sorted(rows, key=lambda r: -r["tok"])
    top = [r for r in by_tok[:TOP_N] if r["tok"] or r["level"]]
    extra = [r for r in leveled if r not in top][:EXTRA_LEVELED_MAX]
    top = sorted(top + extra, key=lambda r: (r["level"] is None, r["level"] != "runaway", -r["tok"]))
    for r in top:
        r.pop("_why", None)
        r.pop("active", None)
        r.pop("_lastMain", None)
        r.pop("_lastWork", None)

    hdr_meter = None
    if meter:
        # fresh and harvestedAt describe the five-hour window; the weekly figure has its own pair.
        hdr_meter = {"fresh": meter["fresh"], "harvestedAt": iso(meter["harvestedAt"]),
                     "weekFresh": meter["weekFresh"], "weekSeenAt": iso(meter["weekSeenAt"])}
        for k in ("five", "week"):
            w = meter[k]
            proj, pstate = meter_pace(meter, k, now)
            hdr_meter["five_hour" if k == "five" else "seven_day"] = (
                {"pct": w["pct"], "resetsAt": iso(w["resetsAt"]), "projectedEndPct": proj, "paceState": pstate}
                if w else None)
    acct_out = accounts_header(totals, windows, accounts, now)
    opus_total = sum(int(r["tok"] * r["opus"]) for r in rows if not r.get("acct"))
    return {
        "v": VERSION, "generatedAt": iso(now), "staleAfterS": STALE_AFTER_S,
        "host": safe(socket.gethostname().split(".")[0]) or "unknown",
        "parseHealth": health["status"], "corrupt": health["corrupt"],
        "meter": hdr_meter,
        "window": {"start": iso(ws) if ws else None, "end": iso(we) if we else None, "source": wsrc,
                   "tokens": total, "opusShare": round(opus_total / total, 2) if total else 0},
        **({"shareHours": list(TRIAL_HOURS)} if TRIAL_HOURS else {}),
        "alerts": alerts,
        "cacheExpiring": cache,
        "compactSoon": soon,
        "top": top,
        **({"accounts": acct_out} if acct_out else {}),
    }


def accounts_header(totals, windows, accounts, now):
    """The summary's `accounts`: one entry per labelled account (AIT_ACCOUNT) with its own meter and window.
    The main account stays under `meter` and `window`, so a reader of those is unchanged. Empty without any."""
    labs = set(l for l in totals if l) | set(e["label"] for e in (accounts or {}).values() if e.get("label"))
    out = []
    for lab in sorted(labs):
        ent = next((e for e in (accounts or {}).values() if e.get("label") == lab), None) or {}
        five, week = ent.get("fiveHour"), ent.get("sevenDay")

        def win(w):
            if not w:
                return None
            return {"pct": w["used"], "resetsAt": iso(w["windowEnd"]), "projectedEndPct": w["projectedEndPct"],
                    "paceState": w["state"]}
        ws, we, src = windows.get(lab) or rolling_default_window(now)
        out.append({"label": lab, "fresh": bool(five and five["fresh"]), "weekFresh": bool(week and week["fresh"]),
                    "five_hour": win(five), "seven_day": win(week),
                    "window": {"start": iso(ws), "end": iso(we), "source": src, "tokens": totals.get(lab, 0)}})
    return out


def dump_bounded(summary):
    data = json.dumps(summary, separators=(",", ":"))
    if len(data.encode()) > SUMMARY_MAX_BYTES and "shareHours" in summary:
        # The trial figures go first: they are for comparison only and may not push a real row out.
        del summary["shareHours"]
        for r in summary["top"]:
            r.pop("shareH", None)
        data = json.dumps(summary, separators=(",", ":"))
        # The marker costs bytes too: keep it only when it still fits, or when the cap is lost anyway.
        summary["trialDropped"] = True
        marked = json.dumps(summary, separators=(",", ":"))
        if len(marked.encode()) <= SUMMARY_MAX_BYTES or len(data.encode()) > SUMMARY_MAX_BYTES:
            data = marked
        else:
            del summary["trialDropped"]
    # Drop order, least needed first: top rows, compactSoon, cacheExpiring, the per-account display, then alerts
    # (the runaway flow's only input). `meter` and `window` are never dropped. Every section that lost anything is
    # named in `dropped`, so a reader can tell "cut for size" from "nothing due".
    def note(name):
        names = summary.setdefault("dropped", [])
        if name not in names:
            names.append(name)

    for name in ("top", "compactSoon", "cacheExpiring"):
        while len(data.encode()) > SUMMARY_MAX_BYTES and summary[name]:
            summary[name].pop()
            summary["truncated"] = True
            note(name)
            data = json.dumps(summary, separators=(",", ":"))
    if len(data.encode()) > SUMMARY_MAX_BYTES and "accounts" in summary:
        del summary["accounts"]
        summary["accountsDropped"] = True
        note("accounts")
        data = json.dumps(summary, separators=(",", ":"))
    while len(data.encode()) > SUMMARY_MAX_BYTES and summary["alerts"]:
        summary["alerts"].pop()
        summary["truncated"] = True
        note("alerts")
        data = json.dumps(summary, separators=(",", ":"))
    return data


# ---------------------------------------------------------------- run

def fresh_state():
    return {"v": VERSION, "files": {}, "keys": {}, "nextFid": 0, "warnSids": [], "noUsageRuns": 0}


def load_state(path):
    try:
        if os.lstat(path).st_size > STATE_MAX_BYTES:
            raise ValueError("state over cap")
        st = read_json(path)
        if (not isinstance(st, dict) or st.get("v") != VERSION or not isinstance(st.get("files"), dict)
                or not isinstance(st.get("keys"), dict)):
            raise ValueError("bad state")
        return st
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        err("state.json unreadable or over cap; rebuilding from a 24h scan")
    return fresh_state()


def dump_state(state, now):
    """Serialise state under its cap, dropping dedupe keys older than 6h before giving up."""
    data = json.dumps(state, separators=(",", ":"))
    if len(data.encode()) <= STATE_MAX_BYTES:
        return data
    prune_keys(state, now, key_keep=6 * 3600, keys_max=KEYS_MAX // 4)
    data = json.dumps(state, separators=(",", ":"))
    return data if len(data.encode()) <= STATE_MAX_BYTES else None


def acquire_lock(lock):
    try:
        os.mkdir(lock, 0o700)
        return True
    except FileExistsError:
        pass
    try:
        st = os.lstat(lock)
        if stat.S_ISDIR(st.st_mode) and time.time() - st.st_mtime > LOCK_STALE_S:
            os.rmdir(lock)
            os.mkdir(lock, 0o700)
            return True
        if not stat.S_ISDIR(st.st_mode):
            err("run.lock is not a directory; refusing to run")
    except OSError:
        pass
    return False


def heartbeat(out_dir, event):
    """One line per run start/end in heartbeat.log, so a gap shows launchd not starting the job."""
    try:
        fd = os.open(os.path.join(out_dir, "heartbeat.log"), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except OSError:
        return
    try:
        if stat.S_ISREG(os.fstat(fd).st_mode):
            if os.fstat(fd).st_size > HEARTBEAT_MAX_BYTES:
                os.ftruncate(fd, 0)
            os.write(fd, ("%s %s\n" % (datetime.now().isoformat(timespec="seconds"), event)).encode())
    except OSError:
        pass
    finally:
        os.close(fd)


def meter_line(meter, at):
    """One history line: harvest time, then percent and reset time for each window ('-' when absent)."""
    parts = ["harvest=%s" % iso(at)]
    for label, key in (("5h", "five"), ("7d", "week")):
        w = meter[key]
        parts.append("%s=%s reset%s=%s" % (label, "%d%%" % w["pct"] if w else "-", label,
                                           iso(w["resetsAt"]) if w else "-"))
    return " ".join(parts)


def log_meter_history(out_dir, meter):
    """Append a line to meter-history.log when a reading changed or the last line is an hour old.

    The file is overwritten on every refresh by the statusline, so this is the only record of past
    readings. Past METER_LOG_MAX_BYTES the oldest half is dropped at a line boundary. A failure
    here is logged and never fails the run.

    The line's harvest time is the newest live observation of either window, so a week-only meter
    (no five-hour reading since a reset) is still recorded. A window counts only when its
    observed_at is known: without it the time would be the file's mtime, which the statusline
    moves on every render. An observed_at moves on every render too, so the harvest time alone
    cannot decide: a line is written when the readings (everything after the time) differ from the
    last line's, or when that newest observation is METER_LOG_REFRESH_S or more past the last
    line's time. The refresh follows observations, not the wall clock: while nothing is observed
    no line is added.

    A window whose own observation is older than its freshness limit before the line's time is
    written as '-': the statusline can carry a borrowed five-hour value next to a live weekly one,
    and the line must not stamp that old value with the weekly time. A five-hour value whose
    observed_at is unknown (-1, or missing) is written as '-' for the same reason.
    """
    if not meter:
        return
    seen = [t for t, ok in ((meter["harvestedAt"], meter.get("harvestLive")),
                            (meter.get("weekSeenAt"), meter.get("weekLive"))) if ok and iso(t) is not None]
    if not seen:
        return
    at = max(seen)
    view = dict(meter)
    if not meter.get("harvestLive") or at - meter["harvestedAt"] > METER_MAX_AGE_S:
        view["five"] = None
    if meter.get("weekLive") and at - meter["weekSeenAt"] > WEEK_FRESH_S:
        view["week"] = None
    path = os.path.join(out_dir, "meter-history.log")
    try:
        fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except OSError:
        err("meter-history.log not writable")
        return
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return
        size = os.fstat(fd).st_size
        tail = b""
        if size:
            os.lseek(fd, max(0, size - METER_LOG_TAIL), os.SEEK_SET)
            tail = os.read(fd, METER_LOG_TAIL)
        last = tail.decode("utf-8", "replace").splitlines()[-1:] or [""]
        new = meter_line(view, at)
        head, _, rest = last[0].partition(" ")
        last_at = parse_ts(head.partition("=")[2]) if head.startswith("harvest=") else None
        # A negative gap (the clock stepped back, or an older observation) must not mute the log until
        # the clock catches up: it writes once, and the new line's time then makes the gap zero.
        if rest == new.partition(" ")[2] and last_at is not None and 0 <= at - last_at < METER_LOG_REFRESH_S:
            return
        os.write(fd, (new + "\n").encode())
        if size + len(new) + 1 > METER_LOG_MAX_BYTES:
            os.lseek(fd, 0, os.SEEK_SET)
            data = b""
            while True:
                chunk = os.read(fd, 1 << 16)
                if not chunk:
                    break
                data += chunk
            cut = data.find(b"\n", len(data) // 2)
            if cut != -1:
                atomic_write(out_dir, "meter-history.log", data[cut + 1:].decode("utf-8", "replace"))
    except OSError:
        err("meter-history.log write failed")
    finally:
        os.close(fd)


def write_meters(out_dir, accounts, now):
    """meters.json: the per-account windows with their pace, rewritten every run. A failure is logged and
    never fails the run (the summary is the watcher's main output)."""
    try:
        data = {"v": 1, "generatedAt": int(now), "accounts": accounts}
        atomic_write(out_dir, "meters.json", json.dumps(data, separators=(",", ":")))
    except Exception as e:  # class name only
        err("meters.json write failed: %s" % e.__class__.__name__)


def run(args):
    out_dir = args.out_dir
    global ERR_FD
    ensure_out_dir(out_dir)
    heartbeat(out_dir, "start")
    try:
        # Our own log, never a launchd StandardErrorPath, so a planted symlink is never followed.
        fd = os.open(os.path.join(out_dir, "watch.err"), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        if stat.S_ISREG(os.fstat(fd).st_mode):
            if os.fstat(fd).st_size > ERR_LOG_MAX_BYTES:
                os.ftruncate(fd, 0)
            ERR_FD = fd
        else:
            os.close(fd)
    except OSError:
        pass
    lock = os.path.join(out_dir, "run.lock")
    if not acquire_lock(lock):
        err("previous run still holds run.lock; skipping")
        heartbeat(out_dir, "skip")
        return 0
    try:
        now = args.now if args.now is not None else time.time()
        state_path = os.path.join(out_dir, "state.json")
        state = load_state(state_path)
        health = {"applied": 0, "parsed": 0, "candidates": 0, "probe": 0, "corrupt": 0}
        t0 = time.monotonic()
        scan(args.config_dir, state, now, health)
        if (health["candidates"] or health["probe"]) and not health["parsed"]:
            state["noUsageRuns"] = state.get("noUsageRuns", 0) + 1
        else:
            state["noUsageRuns"] = 0
        health["status"] = "degraded" if state.get("noUsageRuns", 0) >= DEGRADED_RUNS else "ok"
        meter = read_meter(args.spool, now, args.meter_fp)
        log_meter_history(out_dir, meter)
        try:
            accounts = read_accounts(out_dir, args.spool, now)
        except Exception as e:  # class name only
            err("reading the account windows failed: %s" % e.__class__.__name__)
            accounts = {}
        write_meters(out_dir, accounts, now)
        try:
            labels = read_labels(out_dir, now)
        except Exception as e:
            err("reading the account labels failed: %s" % e.__class__.__name__)
            labels = {}
        reg = read_registry(args.config_dir)
        summary = build_summary(state, meter, reg, now, health, args.cache_ctx_min, labels, accounts)
        state_data = dump_state(state, now)
        if state_data is None:
            err("state.json would exceed cap; dropping it so the next run rebuilds")
            summary["stateDropped"] = True
            try:
                os.remove(state_path)
            except FileNotFoundError:
                pass
        else:
            atomic_write(out_dir, "state.json", state_data)
        atomic_write(out_dir, "usage-summary.json", dump_bounded(summary))
        if time.monotonic() - t0 > 60:
            err("slow run: %.1fs" % (time.monotonic() - t0))
        heartbeat(out_dir, "end %.1fs" % (time.monotonic() - t0))
        return 0
    except Exception as e:  # logged here, while watch.err is still open; class name only
        err("run failed: %s" % e.__class__.__name__)
        heartbeat(out_dir, "fail")
        return 1
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass
        if ERR_FD is not None:
            os.close(ERR_FD)
            ERR_FD = None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config-dir", default=os.path.expanduser("~/.claude"))
    ap.add_argument("--out-dir", default=os.path.expanduser("~/.local/state/usage-watcher"))
    ap.add_argument("--spool", default=os.environ.get("AGENT_DISPATCH_SPOOL") or os.path.expanduser("~/.agent-dispatch/spool"),
                    help="optional spool, read only when present, for limits/personal-windows-*.json")
    ap.add_argument("--meter-fp", default=None, help="personal-windows fingerprint to use when several exist")
    ap.add_argument("--cache-ctx-min", type=int, default=CACHE_CTX_MIN,
                    help="smallest ctxNow listed in cacheExpiring, in tokens")
    ap.add_argument("--now", type=float, default=None, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    if args.meter_fp is not None and not re.match(r"^[0-9a-f]{6,64}$", args.meter_fp):
        ap.error("--meter-fp must be hex")
    if not 1 <= args.cache_ctx_min <= USAGE_FIELD_MAX:
        ap.error("--cache-ctx-min must be 1..%d" % USAGE_FIELD_MAX)
    try:
        return run(args)
    except SystemExit:
        raise
    except Exception as e:  # class name only: an exception message could echo input
        err("run failed: %s" % e.__class__.__name__)
        return 1


if __name__ == "__main__":
    sys.exit(main())
