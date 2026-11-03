"""Tests for watch.py. Run: /usr/bin/python3 -I tools/usage-watcher/test_watch.py"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import watch  # noqa: E402

SID = "11111111-2222-3333-4444-555555555555"
SECRET = "CONTENT-MUST-NOT-LEAK-7f3a"


def ts(offset_s=0):
    return datetime.fromtimestamp(time.time() + offset_s, timezone.utc).isoformat().replace("+00:00", "Z")


def prev_bucket():
    """An offset that lands in the middle of the last complete 10-minute bucket."""
    now = time.time()
    return -(now % watch.BUCKET_S) - watch.BUCKET_S / 2


def asst(mid, req, inp=0, out=0, cw=0, cr=0, model="claude-opus-5-5", when=0, side=False, content=None, sid=SID):
    return {"type": "assistant", "timestamp": ts(when), "requestId": req, "isSidechain": side,
            "entrypoint": "cli", "sessionId": sid,
            "message": {"id": mid, "model": model, "role": "assistant",
                        "content": content if content is not None else [{"type": "text", "text": SECRET}],
                        "usage": {"input_tokens": inp, "output_tokens": out,
                                  "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr}}}


def read(path):
    with open(path) as f:
        return f.read()


def line(rec):
    return json.dumps(rec, separators=(",", ":")) + "\n"


class WatchTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.cfg = os.path.join(self.root, "claude")
        self.spool = os.path.join(self.root, "spool")
        self.out = os.path.join(self.root, "state", "usage-watcher")
        self.proj = os.path.join(self.cfg, "projects", "-Users-x-Code-demo")
        os.makedirs(self.proj)
        os.makedirs(os.path.join(self.cfg, "sessions"))
        os.makedirs(os.path.join(self.spool, "limits"))
        self.log = os.path.join(self.proj, SID + ".jsonl")
        self.meter = os.path.join(self.spool, "limits", "personal-windows-abc123.json")
        self.write_meter(40)

    def tearDown(self):
        shutil.rmtree(self.root)

    def write_meter(self, pct, resets_in=3600, path=None, age=60, week_resets_in=86400, observed_ago=None, week_pct=10, week_observed_ago=None):
        path = path or self.meter
        five = {"used_percentage": pct, "resets_at": time.time() + resets_in}
        if observed_ago is not None:
            five["observed_at"] = -1 if observed_ago < 0 else time.time() - observed_ago
        week = {"used_percentage": week_pct, "resets_at": time.time() + week_resets_in}
        if week_observed_ago is not None:
            week["observed_at"] = time.time() - week_observed_ago
        with open(path, "w") as f:
            json.dump({"account": "a", "five_hour": five, "seven_day": week}, f)
        os.utime(path, (time.time() - age, time.time() - age))

    def register(self, name, sid=SID, kind="interactive", pid=None):
        pid = pid or os.getpid()
        with open(os.path.join(self.cfg, "sessions", "%d.json" % pid), "w") as f:
            json.dump({"sessionId": sid, "pid": pid, "name": name, "kind": kind,
                       "entrypoint": "claude-vscode", "cwd": "/Users/x/Code/repo-a"}, f)

    def append(self, *recs, raw=None, path=None):
        with open(path or self.log, "a") as f:
            for r in recs:
                f.write(line(r))
            if raw:
                f.write(raw)

    def burst(self, n, **kw):
        when = prev_bucket()
        return [asst("m%d" % i, "r%d" % i, when=when, **kw) for i in range(n)]

    def run_watch(self, *extra):
        rc = watch.main(["--config-dir", self.cfg, "--spool", self.spool, "--out-dir", self.out] + list(extra))
        self.assertEqual(rc, 0)
        with open(os.path.join(self.out, "usage-summary.json")) as f:
            return json.load(f)

    def row(self, summary, sid=SID):
        for r in summary["top"]:
            if r["sid"] == sid:
                return r
        return None

    # ---- incremental reading and dedupe

    def test_dedupe_takes_max_per_field(self):
        self.append(asst("m1", "r1", inp=10, out=5), asst("m1", "r1", inp=10, out=50), asst("m1", "r1", inp=10, out=20))
        r = self.row(self.run_watch())
        self.assertEqual(r["tok"], 60)
        self.assertEqual(r["calls"], 1)

    def test_dedupe_across_runs_adds_only_delta(self):
        self.append(asst("m1", "r1", inp=10, out=5))
        self.run_watch()
        self.append(asst("m1", "r1", inp=10, out=40))
        self.assertEqual(self.row(self.run_watch())["tok"], 50)

    def test_partial_trailing_line_is_held_back(self):
        full = line(asst("m1", "r1", inp=100))
        self.append(raw=full[:40])
        s = self.run_watch()
        self.assertIsNone(self.row(s))
        self.assertEqual(s["corrupt"], 0)
        self.append(raw=full[40:])
        self.assertEqual(self.row(self.run_watch())["tok"], 100)

    def test_truncation_rereads_from_zero(self):
        self.append(asst("m1", "r1", inp=100), asst("m2", "r2", inp=100))
        self.run_watch()
        with open(self.log, "w") as f:
            f.write(line(asst("m3", "r3", inp=7)))
        self.assertEqual(self.row(self.run_watch())["tok"], 7)

    def test_synthetic_old_and_future_records_skipped(self):
        self.append(asst("m1", "r1", inp=100, model="<synthetic>"), asst("m2", "r2", inp=100, when=-2 * 86400),
                    asst("m4", "r4", inp=100, when=86400), asst("m3", "r3", inp=1))
        self.assertEqual(self.row(self.run_watch())["tok"], 1)

    def test_oversized_usage_is_corrupt_not_counted(self):
        self.append(asst("m1", "r1", inp=10 ** 400), asst("m2", "r2", inp=3))
        s = self.run_watch()
        self.assertEqual((self.row(s)["tok"], s["corrupt"]), (3, 1))

    def test_copied_history_counts_once_for_the_original(self):
        copy_sid = "77777777-0000-0000-0000-000000000000"
        self.append(asst("m1", "r1", inp=100, cr=400_000))
        copy = os.path.join(self.proj, copy_sid + ".jsonl")
        self.append(asst("m1", "r1", inp=100, cr=400_000, sid=copy_sid), asst("m2", "r2", inp=5, sid=copy_sid), path=copy)
        s = self.run_watch()
        self.assertEqual(self.row(s)["tok"], 400_100)
        self.assertEqual((self.row(s, copy_sid)["tok"], self.row(s, copy_sid)["ctxNow"]), (5, 5))
        self.assertEqual(s["window"]["tokens"], 400_105)
        os.remove(os.path.join(self.out, "state.json"))
        self.assertEqual(self.row(self.run_watch())["tok"], 400_100)

    def test_copied_compactions_count_once(self):
        copy_sid = "77777777-0000-0000-0000-000000000000"
        comp = {"type": "system", "subtype": "compact_boundary", "timestamp": ts(-5)}
        self.append(comp, asst("m1", "r1", inp=1))
        copy = os.path.join(self.proj, copy_sid + ".jsonl")
        self.append(comp, asst("m2", "r2", inp=1, sid=copy_sid), path=copy)
        s = self.run_watch()
        self.assertEqual((self.row(s)["compToday"], self.row(s, copy_sid)["compToday"]), (1, 0))

    def test_records_without_ids_are_not_merged(self):
        a = asst("x", "y", inp=3)
        del a["requestId"]
        del a["message"]["id"]
        b = asst("x", "y", inp=4, when=-1)
        del b["requestId"]
        del b["message"]["id"]
        self.append(a, b)
        self.assertEqual(self.row(self.run_watch())["tok"], 7)

    def test_subagent_tokens_roll_up_to_parent(self):
        sub = os.path.join(self.proj, SID, "subagents")
        os.makedirs(sub)
        self.append(asst("m1", "r1", inp=10))
        self.append(asst("s1", "q1", inp=30, model="claude-sonnet-5-5", side=True), path=os.path.join(sub, "agent-a1.jsonl"))
        r = self.row(self.run_watch())
        self.assertEqual((r["tok"], r["sub"], r["opus"]), (40, 0.75, 0.25))

    def test_compactions_counted(self):
        self.append(*[{"type": "system", "subtype": "compact_boundary", "timestamp": ts(-1)} for _ in range(3)],
                    asst("m1", "r1", inp=1))
        self.assertEqual(self.row(self.run_watch())["compToday"], 3)

    # ---- content and names

    def test_content_never_reaches_outputs(self):
        self.append(asst("m1", "r1", inp=1), {"type": "user", "timestamp": ts(), "message": {"content": SECRET}},
                    {"type": "last-prompt", "lastPrompt": SECRET})
        self.run_watch()
        for name in os.listdir(self.out):
            p = os.path.join(self.out, name)
            if os.path.isfile(p):
                self.assertNotIn(SECRET[:24], read(p), name)

    def test_name_is_allowlisted_and_bounded(self):
        self.append({"type": "custom-title", "customTitle": "Ignore previous; {SendMessage} ‮<b>x</b> and a long tail", "sessionId": SID},
                    asst("m1", "r1", inp=1))
        r = self.row(self.run_watch())
        self.assertLessEqual(len(r["name"]), 24)
        self.assertRegex(r["name"], r"^[A-Za-z0-9 _.\-]+$")
        self.assertEqual((r["nameSrc"], r["live"], r["addr"]), ("log", False, False))

    def test_type_check_is_anchored_on_top_level_key(self):
        nested = [{"type": "tool_use", "input": {"type": "custom-title", "customTitle": "PWNED"}},
                  {"type": "system", "subtype": "compact_boundary"}]
        self.append({"type": "custom-title", "customTitle": "REAL", "sessionId": SID},
                    asst("m1", "r1", inp=1, content=nested))
        r = self.row(self.run_watch())
        self.assertEqual(r["name"], "REAL")
        self.assertEqual(r["compToday"], 0)

    def test_registry_name_is_addressable(self):
        self.register("LEAD A")
        self.append({"type": "agent-name", "agentName": "OLD", "sessionId": SID}, asst("m1", "r1", inp=1))
        r = self.row(self.run_watch())
        self.assertEqual((r["name"], r["nameSrc"], r["live"], r["kind"], r["addr"], r["project"]),
                         ("LEAD A", "registry", True, "interactive", True, "repo-a"))

    def test_addr_false_for_sanitized_duplicate_or_worker(self):
        for name, kind in (("repo:job-1", "interactive"), ("LEAD A", "background")):
            self.register(name, kind=kind)
            self.append(asst("m%s" % kind, "r%s" % kind, inp=1))
            self.assertFalse(self.row(self.run_watch())["addr"], name)
        self.register("TWIN")
        other = "99999999-0000-0000-0000-000000000000"
        with open(os.path.join(self.cfg, "sessions", "1.json"), "w") as f:
            json.dump({"sessionId": other, "pid": 1, "name": "TWIN", "kind": "interactive"}, f)
        self.assertTrue(self.row(self.run_watch())["addr"], "pid 1 is not ours, so it is not live")

    def test_registry_file_must_match_pid(self):
        with open(os.path.join(self.cfg, "sessions", "zz.json"), "w") as f:
            json.dump({"sessionId": SID, "pid": os.getpid(), "name": "DEVELOPER", "kind": "interactive"}, f)
        self.append(asst("m1", "r1", inp=1))
        self.assertFalse(self.row(self.run_watch())["live"])

    # ---- thresholds and alerts

    def test_burn_runaway_needs_min_calls(self):
        self.register("BURNER")
        self.append(*self.burst(9, out=10_000_000))
        r = self.row(self.run_watch())
        self.assertGreaterEqual(r["burnH"], watch.BURN_RUN)
        self.assertIsInstance(r["burnH"], int)
        self.assertIsNone(r["level"])
        self.append(asst("m9", "r9", out=10_000_000, when=prev_bucket()))
        s = self.run_watch()
        self.assertEqual(self.row(s)["level"], "runaway")
        a = s["alerts"][0]
        self.assertEqual((a["sid"], a["name"], a["live"], a["kind"], a["addr"]), (SID, "BURNER", True, "interactive", True))
        self.assertTrue(any(w.startswith("burnH") for w in a["why"]))

    def test_non_live_sessions_never_alert(self):
        self.append(*self.burst(12, out=10_000_000))
        s = self.run_watch()
        self.assertEqual(self.row(s)["level"], "runaway")
        self.assertEqual(s["alerts"], [])

    def test_warn_needs_two_consecutive_runs(self):
        self.register("WARNER")
        self.append(*self.burst(12, out=37_500_000 // 12))
        first = self.row(self.run_watch())
        self.assertIsNone(first["level"])
        self.assertEqual(self.row(self.run_watch())["level"], "warn")

    def test_ctxavg_warn_alone_does_not_alert(self):
        self.register("CTX")
        self.append(*self.burst(12, cr=300_000))
        self.run_watch()
        self.assertIsNone(self.row(self.run_watch())["level"])

    def test_idle_session_context_does_not_alert(self):
        self.register("IDLE")
        self.append(*[asst("m%d" % i, "r%d" % i, cr=600_000, when=-50 * 60) for i in range(12)])
        self.assertIsNone(self.row(self.run_watch())["level"])

    def test_meter_alert_without_burner_names_no_session(self):
        self.write_meter(95)
        self.register("QUIET")
        self.append(asst("m1", "r1", inp=1, when=-3 * 3600))
        a = self.run_watch()["alerts"][0]
        self.assertEqual((a["src"], a["level"], a["sid"], a["addr"]), ("meter", "runaway", None, False))

    def test_cache_expiring_lists_idle_big_sessions(self):
        self.register("BIG")
        self.append(asst("w1", "q1", cr=300_000, out=5_000, when=-120 * 60),
                    asst("k1", "q2", cr=300_000, out=3, when=-45 * 60))
        c = self.run_watch()["cacheExpiring"]
        self.assertEqual(len(c), 1)
        self.assertEqual((c[0]["sid"], c[0]["name"], c[0]["addr"], c[0]["due"], c[0]["idleMin"], c[0]["workIdleMin"]),
                         (SID, "BIG", True, "ping", 45, 120))

    def test_cache_expiring_window_bounds(self):
        self.register("EDGE")
        # Oldest first: each call becomes the session's last main call.
        for idle, listed in ((51, False), (50, True), (20, True), (19, False)):
            self.append(asst("w%d" % idle, "q%d" % idle, cr=300_000, out=5_000, when=-idle * 60 - 30))
            self.assertEqual(len(self.run_watch()["cacheExpiring"]), int(listed), "idle %d min" % idle)

    def test_cache_expiring_due_checkpoint_after_three_hours_without_work(self):
        self.register("PINGED")
        self.append(asst("w1", "q1", cr=300_000, out=5_000, when=-200 * 60),
                    asst("k1", "q2", cr=300_000, out=3, when=-50 * 60))
        self.assertEqual(self.run_watch()["cacheExpiring"][0]["due"], "checkpoint")

    def test_cache_expiring_skips_small_busy_and_ended(self):
        self.register("SMALL")
        self.append(asst("w1", "q1", cr=50_000, out=5_000, when=-45 * 60))
        self.assertEqual(self.run_watch()["cacheExpiring"], [])
        os.remove(os.path.join(self.cfg, "sessions", "%d.json" % os.getpid()))
        self.append(asst("w2", "q2", cr=300_000, out=5_000, when=-44 * 60))
        self.assertEqual(self.run_watch()["cacheExpiring"], [])

    def test_cache_expiring_floor_comes_from_the_flag(self):
        self.register("MID")
        self.append(asst("w1", "q1", cr=150_000, out=5_000, when=-45 * 60))
        self.assertEqual(self.run_watch()["cacheExpiring"], [])
        self.assertEqual(self.run_watch("--cache-ctx-min", "100000")["cacheExpiring"][0]["ctxNow"], 150_000)
        self.assertEqual(self.run_watch("--cache-ctx-min", str(10 ** 8))["cacheExpiring"], [])

    def test_cache_ctx_min_rejects_out_of_range(self):
        for bad in ("0", "-5", str(10 ** 9)):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                watch.main(["--config-dir", self.cfg, "--spool", self.spool, "--out-dir", self.out, "--cache-ctx-min", bad])

    # ---- meter and window

    def test_compact_soon_holds_one_crossing_until_compaction(self):
        self.register("BIG")
        self.append(asst("a1", "q1", cr=260_000, out=500, when=-120))
        first = self.run_watch()["compactSoon"]
        self.assertEqual([(c["sid"], c["name"], c["addr"], c["ctxNow"]) for c in first], [(SID, "BIG", True, 260_000)])
        self.append(asst("a2", "q2", cr=270_000, out=500, when=-60))
        self.assertEqual(self.run_watch()["compactSoon"][0]["crossedAt"], first[0]["crossedAt"])
        self.append(asst("a3", "q3", cr=20_000, out=500, when=-30))
        self.assertEqual(self.run_watch()["compactSoon"], [])
        self.append(asst("a4", "q4", cr=255_000, out=500, when=-10))
        again = self.run_watch("--now", str(time.time() + 120))["compactSoon"]
        self.assertEqual(len(again), 1)
        self.assertNotEqual(again[0]["crossedAt"], first[0]["crossedAt"])

    def test_compact_soon_line_is_250k_inclusive(self):
        self.register("EDGE")
        self.append(asst("a1", "q1", cr=249_999, out=500, when=-60))
        self.assertEqual(self.run_watch()["compactSoon"], [])
        self.append(asst("a2", "q2", cr=250_000, out=500, when=-30))
        self.assertEqual([c["ctxNow"] for c in self.run_watch()["compactSoon"]], [250_000])

    def test_compact_soon_skips_ended_and_idle(self):
        self.append(asst("a1", "q1", cr=260_000, out=500, when=-45 * 60))
        self.assertEqual(self.run_watch()["compactSoon"], [])
        self.register("IDLE")
        self.assertEqual(self.run_watch()["compactSoon"], [])

    def test_meter_read_only_and_writes_confined(self):
        self.append(asst("m1", "r1", inp=1))
        before = (os.stat(self.meter).st_mtime, read(self.meter))
        cfg_before = sorted(os.path.join(d, f) for d, _, fs in os.walk(self.cfg) for f in fs)
        s = self.run_watch()
        self.assertEqual(before, (os.stat(self.meter).st_mtime, read(self.meter)))
        self.assertEqual(cfg_before, sorted(os.path.join(d, f) for d, _, fs in os.walk(self.cfg) for f in fs))
        self.assertEqual(sorted(os.listdir(self.spool)), ["limits"])
        self.assertEqual(sorted(os.listdir(self.out)), ["heartbeat.log", "meters.json", "state.json", "usage-summary.json", "watch.err"])
        self.assertEqual(oct(os.stat(self.out).st_mode & 0o777), "0o700")
        self.assertTrue(s["meter"]["fresh"])
        self.assertEqual(s["window"]["source"], "meter")

    # ---- meter history

    def history(self):
        return read(os.path.join(self.out, "meter-history.log")).splitlines()

    def test_meter_history_logs_one_line_per_harvest(self):
        self.write_meter(40, observed_ago=120)
        self.run_watch()
        self.run_watch()
        lines = self.history()
        self.assertEqual(len(lines), 1, "same harvest, same line")
        self.assertRegex(lines[0], r"^harvest=\S+ 5h=40% reset5h=\S+ 7d=10% reset7d=\S+$")
        self.write_meter(55, observed_ago=60)
        self.run_watch()
        self.run_watch()
        lines = self.history()
        self.assertEqual(len(lines), 2)
        self.assertIn("5h=55%", lines[1])
        self.assertEqual(oct(os.stat(os.path.join(self.out, "meter-history.log")).st_mode & 0o777), "0o600")

    def test_meter_history_marks_absent_windows_and_skips_no_meter(self):
        self.write_meter(40, resets_in=-60, week_resets_in=-3600, observed_ago=120)
        self.run_watch()
        self.assertRegex(self.history()[0], r" 5h=- reset5h=- 7d=- reset7d=-$")
        os.remove(self.meter)
        self.run_watch()
        self.assertEqual(len(self.history()), 1, "no meter, no line")

    def test_meter_history_dedupes_against_the_file_after_a_state_loss(self):
        self.write_meter(40, observed_ago=120)
        self.run_watch()
        os.remove(os.path.join(self.out, "state.json"))
        self.run_watch()
        self.assertEqual(len(self.history()), 1)

    def test_meter_history_keeps_seeded_lines_and_dedupes_after_them(self):
        self.write_meter(40, observed_ago=120)
        os.makedirs(self.out, mode=0o700)
        seeded = "harvest=2026-10-23T00:07:00+02:00 5h=83% reset5h=2026-10-23T03:40:00+02:00 7d=35% reset7d=- src=tracker"
        with open(os.path.join(self.out, "meter-history.log"), "w") as f:
            f.write(seeded + "\n")
        self.run_watch()
        self.run_watch()
        lines = self.history()
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], seeded)

    def test_meter_history_is_capped_at_a_line_boundary(self):
        self.write_meter(40, observed_ago=120)
        os.makedirs(self.out, mode=0o700)
        path = os.path.join(self.out, "meter-history.log")
        filler = "harvest=2026-01-01T00:00:00+00:00 5h=1% reset5h=- 7d=1% reset7d=-\n"
        with open(path, "w") as f:
            f.write(filler * (watch.METER_LOG_MAX_BYTES // len(filler) + 1))
        self.run_watch()
        lines = self.history()
        self.assertLess(os.path.getsize(path), watch.METER_LOG_MAX_BYTES)
        self.assertGreater(len(lines), 100)
        self.assertEqual(lines[0], filler.strip())
        self.assertIn("5h=40%", lines[-1])

    def test_meter_history_does_not_follow_a_symlink_or_fail_the_run(self):
        self.write_meter(40, observed_ago=120)
        target = os.path.join(self.root, "victim")
        open(target, "w").close()
        os.makedirs(self.out, mode=0o700)
        os.symlink(target, os.path.join(self.out, "meter-history.log"))
        self.run_watch()
        self.assertEqual(read(target), "")

    def test_meter_history_skips_a_meter_without_a_known_observed_at(self):
        self.run_watch()
        self.write_meter(40, observed_ago=-1)
        self.run_watch()
        self.write_meter(41, age=30)
        self.run_watch()
        self.assertFalse(os.path.exists(os.path.join(self.out, "meter-history.log")),
                         "harvestedAt would be the mtime, which moves on every render")

    def bump_observed(self, five_ago, week_ago):
        """Re-stamp both windows' observed_at as a statusline render would, leaving the readings alone."""
        with open(self.meter) as f:
            doc = json.load(f)
        doc["five_hour"]["observed_at"] = time.time() - five_ago
        doc["seven_day"]["observed_at"] = time.time() - week_ago
        with open(self.meter, "w") as f:
            json.dump(doc, f)

    def test_summary_meter_reports_the_weekly_window_on_its_own_freshness(self):
        # No five-hour reading for hours, but the weekly figure was seen 30 s ago.
        self.write_meter(40, observed_ago=3 * 3600, week_observed_ago=30)
        m = self.run_watch()["meter"]
        self.assertFalse(m["fresh"])
        self.assertTrue(m["weekFresh"])
        self.assertAlmostEqual(watch.parse_ts(m["weekSeenAt"]), time.time() - 30, delta=5)
        self.assertAlmostEqual(watch.parse_ts(m["harvestedAt"]), time.time() - 3 * 3600, delta=5)
        self.write_meter(40, observed_ago=30, week_observed_ago=watch.WEEK_FRESH_S + 600)
        m = self.run_watch()["meter"]
        self.assertTrue(m["fresh"])
        self.assertFalse(m["weekFresh"])

    def test_meter_history_records_a_week_only_meter(self):
        # The five-hour value is borrowed: seen 3 hours ago, while the weekly figure is live.
        self.write_meter(40, observed_ago=3 * 3600, week_observed_ago=30)
        self.run_watch()
        lines = self.history()
        self.assertEqual(len(lines), 1)
        self.assertAlmostEqual(watch.parse_ts(lines[0].split(" ")[0].split("=", 1)[1]), time.time() - 30, delta=5)
        self.assertIn("7d=10%", lines[0])
        self.assertIn("5h=- reset5h=-", lines[0], "an old five-hour value is not stamped with the weekly time")

    def test_meter_history_drops_a_five_hour_value_of_unknown_age(self):
        # observed_at -1: the statusline carried the five-hour value over without a time.
        self.write_meter(40, observed_ago=-1, week_observed_ago=30)
        self.run_watch()
        lines = self.history()
        self.assertEqual(len(lines), 1)
        self.assertIn("7d=10%", lines[0])
        self.assertIn("5h=- reset5h=-", lines[0], "a five-hour value of unknown age is not stamped with the weekly time")

    def test_meter_history_keeps_a_five_hour_value_seen_shortly_before_the_weekly_one(self):
        self.write_meter(40, observed_ago=600, week_observed_ago=30)
        self.run_watch()
        self.assertIn("5h=40%", self.history()[0])

    def test_meter_history_is_not_muted_by_a_clock_that_stepped_back(self):
        self.write_meter(40, observed_ago=60, week_observed_ago=60)
        self.run_watch()
        self.bump_observed(7200, 7200)
        self.run_watch()
        self.assertEqual(len(self.history()), 2, "logged once at the older time")
        self.run_watch()
        self.assertEqual(len(self.history()), 2, "and then quiet again")

    def test_meter_history_ignores_moving_observation_times_until_an_hour_has_passed(self):
        self.write_meter(40, observed_ago=7200, week_observed_ago=7200)
        self.run_watch()
        self.assertEqual(len(self.history()), 1)
        self.bump_observed(6000, 6000)
        self.run_watch()
        self.assertEqual(len(self.history()), 1, "same readings seen 20 min later: no new line")
        self.bump_observed(60, 60)
        self.run_watch()
        lines = self.history()
        self.assertEqual(len(lines), 2, "the last line is over an hour old: logged again")
        self.assertEqual(lines[0].split(" ", 1)[1], lines[1].split(" ", 1)[1])
        self.write_meter(41, observed_ago=30, week_observed_ago=30)
        self.run_watch()
        self.assertEqual(len(self.history()), 3, "a changed reading is logged at once")

    def test_heartbeat_logs_start_and_end_and_is_bounded(self):
        self.append(asst("m1", "r1", inp=1))
        self.run_watch()
        self.run_watch()
        hb = os.path.join(self.out, "heartbeat.log")
        lines = read(hb).splitlines()
        self.assertEqual([l.split(" ", 1)[1].split(" ")[0] for l in lines], ["start", "end", "start", "end"])
        with open(hb, "a") as f:
            f.write("x" * (watch.HEARTBEAT_MAX_BYTES + 1) + "\n")
        self.run_watch()
        self.assertLess(os.path.getsize(hb), 200)

    def test_heartbeat_does_not_follow_a_symlink(self):
        target = os.path.join(self.root, "victim")
        open(target, "w").close()
        os.makedirs(self.out, mode=0o700, exist_ok=True)
        os.symlink(target, os.path.join(self.out, "heartbeat.log"))
        self.append(asst("m1", "r1", inp=1))
        self.run_watch()
        self.assertEqual(read(target), "")

    def test_stale_meter_falls_back_to_rolling(self):
        self.write_meter(99, resets_in=-60)
        self.append(asst("m1", "r1", inp=1))
        s = self.run_watch()
        self.assertFalse(s["meter"]["fresh"])
        self.assertEqual(s["window"]["source"], "rolling")
        self.assertEqual(s["alerts"], [])

    def test_meter_rejects_future_mtime_bad_values_and_ambiguity(self):
        self.append(asst("m1", "r1", inp=1))
        os.utime(self.meter, (time.time() + 3600, time.time() + 3600))
        self.assertIsNone(self.run_watch()["meter"])
        with open(self.meter, "w") as f:
            f.write('{"five_hour":{"used_percentage":Infinity,"resets_at":1e300}}')
        self.assertIsNone(self.run_watch()["meter"]["five_hour"])
        self.write_meter(40)
        self.write_meter(50, path=os.path.join(self.spool, "limits", "personal-windows-def456.json"))
        self.assertIsNone(self.run_watch()["meter"])
        self.assertEqual(self.run_watch("--meter-fp", "def456")["meter"]["five_hour"]["pct"], 50)

    def test_meter_skips_an_oversized_spool_file_before_the_one_file_count(self):
        self.append(asst("m1", "r1", inp=1))
        with open(self.meter, "w") as f:
            f.write('{"five_hour":{"used_percentage":40,"resets_at":%d}}' % (time.time() + 3600) + " " * 70000)
        self.assertIsNone(self.run_watch()["meter"], "an oversized file alone is no meter")
        self.write_meter(50, path=os.path.join(self.spool, "limits", "personal-windows-def456.json"))
        self.assertEqual(self.run_watch()["meter"]["five_hour"]["pct"], 50, "the oversized file does not make it ambiguous")

    def test_meter_survives_a_deeply_nested_spool_file(self):
        self.append(asst("m1", "r1", inp=1))
        with open(self.meter, "w") as f:
            f.write("[" * 30000)
        s = self.run_watch()
        self.assertIsNone(s["meter"])
        self.assertEqual(self.row(s)["tok"], 1)

    def test_meter_drops_an_expired_weekly_window(self):
        self.write_meter(40, week_resets_in=-3600)
        self.append(asst("m1", "r1", inp=1))
        m = self.run_watch()["meter"]
        self.assertIsNone(m["seven_day"], "a weekly reset in the past is last week's number")
        self.assertEqual(m["five_hour"]["pct"], 40)

    def test_meter_five_hour_freshness_follows_observed_at_not_mtime(self):
        self.append(asst("m1", "r1", inp=1))
        self.write_meter(95, observed_ago=45 * 60)
        s = self.run_watch()
        self.assertFalse(s["meter"]["fresh"], "rewritten a minute ago, but last seen live 45 min ago")
        self.assertEqual(s["alerts"], [])
        self.write_meter(95, observed_ago=-1)
        self.assertFalse(self.run_watch()["meter"]["fresh"], "observed_at -1 is an unknown age")
        self.write_meter(95, observed_ago=120)
        self.assertTrue(self.run_watch()["meter"]["fresh"])

    # ---- rolling window and the share trial (TRIAL_HOURS is () by default; these tests turn it on)

    def trial_on(self):
        self.addCleanup(setattr, watch, "TRIAL_HOURS", watch.TRIAL_HOURS)
        watch.TRIAL_HOURS = (1, 2, 3)

    def iso_epoch(self, v):
        return datetime.fromisoformat(v).timestamp()

    def test_rolling_window_is_the_last_five_hours_in_whole_buckets(self):
        self.write_meter(40, resets_in=-60)
        self.append(asst("m1", "r1", inp=1))
        t = time.time()
        w = self.run_watch()["window"]
        self.assertEqual(w["source"], "rolling")
        start, end = self.iso_epoch(w["start"]), self.iso_epoch(w["end"])
        self.assertEqual(end - start, watch.WINDOW_S)
        self.assertEqual(start % watch.BUCKET_S, 0)
        self.assertTrue(t < end <= t + watch.BUCKET_S + 5, "ends with the bucket holding now, so the call in progress counts")

    def test_rolling_window_drops_a_call_older_than_five_hours(self):
        self.write_meter(40, resets_in=-60)
        self.append(asst("m1", "r1", inp=1000, when=-5.5 * 3600), asst("m2", "r2", inp=7, when=-4.5 * 3600))
        s = self.run_watch()
        self.assertEqual(s["window"]["source"], "rolling")
        self.assertEqual(s["window"]["tokens"], 7, "the fixed block the estimate started at the first call held both")
        self.assertEqual(self.row(s)["tok"], 7)

    def test_rolling_window_moves_with_time(self):
        self.write_meter(40, resets_in=-60)
        self.append(asst("m1", "r1", inp=1))
        n = time.time()
        first = self.run_watch("--now", str(n))["window"]
        self.assertEqual(watch.main(["--config-dir", self.cfg, "--spool", self.spool, "--out-dir", self.out,
                                     "--now", str(n + 3600)]), 0)
        with open(os.path.join(self.out, "usage-summary.json")) as f:
            later = json.load(f)["window"]
        self.assertEqual(self.iso_epoch(later["start"]) - self.iso_epoch(first["start"]), 3600)

    def test_rolling_window_keeps_no_state_of_its_own(self):
        self.write_meter(40, resets_in=-60)
        self.append(asst("m1", "r1", inp=1))
        self.run_watch()
        self.assertNotIn("win", json.loads(read(os.path.join(self.out, "state.json"))))

    def test_a_live_meter_window_beats_the_rolling_one(self):
        self.write_meter(40, resets_in=7200)
        self.append(asst("m1", "r1", inp=1))
        w = self.run_watch()["window"]
        self.assertEqual(w["source"], "meter")
        self.assertEqual(self.iso_epoch(w["end"]) - self.iso_epoch(w["start"]), watch.WINDOW_S)

    def two_sessions(self, sid2="77777777-0000-0000-0000-000000000000"):
        other = os.path.join(self.proj, sid2 + ".jsonl")
        return sid2, other

    def test_share_is_measured_over_the_rolling_window(self):
        self.write_meter(40, resets_in=-60)
        sid2, other = self.two_sessions()
        self.append(asst("a0", "q0", inp=10_000, when=-5.5 * 3600), asst("a1", "q1", inp=300, when=-4.5 * 3600))
        self.append(asst("b1", "p1", inp=100, when=-4.5 * 3600, sid=sid2), path=other)
        s = self.run_watch()
        self.assertEqual(s["window"]["source"], "rolling")
        self.assertEqual((self.row(s)["share"], self.row(s, sid2)["share"]), (0.75, 0.25))

    def test_trial_shares_cover_one_two_and_three_hours(self):
        self.trial_on()
        self.write_meter(40, resets_in=-60)
        sid2, other = self.two_sessions()
        self.append(asst("a1", "q1", inp=100, when=-5400))
        self.append(asst("b1", "p1", inp=100, when=-60, sid=sid2), path=other)
        s = self.run_watch()
        self.assertEqual(s["shareHours"], [1, 2, 3])
        self.assertEqual(self.row(s)["shareH"], [0, 0.5, 0.5])
        self.assertEqual(self.row(s, sid2)["shareH"], [1.0, 0.5, 0.5])

    def test_trial_shares_raise_no_alert(self):
        self.trial_on()
        self.write_meter(40, resets_in=-60)
        self.register("TRIAL")
        sid2, other = self.two_sessions()
        # SID is gated (12 calls in the hour, 36M, total over 100M) and holds all of the last hour, but only
        # 15% of the 5h window, whose bulk is the other session's older burn: an alert reading shareH would fire.
        self.append(*[asst("a%d" % i, "q%d" % i, inp=3_000_000, when=-2400) for i in range(12)])
        self.append(*[asst("b%d" % i, "p%d" % i, inp=20_000_000, when=-4.5 * 3600, sid=sid2) for i in range(10)], path=other)
        s = self.run_watch()
        r = self.row(s)
        self.assertLess(r["share"], watch.SHARE_WARN)
        self.assertEqual(r["shareH"][0], 1.0)
        self.assertGreaterEqual(r["calls"], watch.MIN_CALLS)
        self.assertGreaterEqual(s["window"]["tokens"], watch.WIN_GATE_TOTAL)
        self.assertIsNone(r["level"])
        self.assertEqual(s["alerts"], [])

    def test_trial_is_off_by_default_and_leaves_no_trial_fields(self):
        self.assertEqual(watch.TRIAL_HOURS, ())
        self.append(asst("m1", "r1", inp=5))
        s = self.run_watch()
        self.assertNotIn("shareHours", s)
        self.assertNotIn("shareH", self.row(s))

    def test_trial_fields_are_dropped_before_any_real_row(self):
        def build(pad):
            return {"top": [{"sid": "x" * 36, "pad": "p" * pad, "shareH": [0.12, 0.34, 0.56]} for _ in range(10)],
                    "compactSoon": [], "cacheExpiring": [], "alerts": [], "shareHours": [1, 2, 3]}
        pad = 0
        while len(json.dumps(build(pad), separators=(",", ":")).encode()) <= watch.SUMMARY_MAX_BYTES:
            pad += 1
        out = json.loads(watch.dump_bounded(build(pad)))
        self.assertEqual(len(out["top"]), 10)
        self.assertTrue(out["trialDropped"])
        self.assertNotIn("shareHours", out)
        self.assertNotIn("shareH", out["top"][0])
        self.assertNotIn("truncated", out)

    def gated_share(self, mine, theirs):
        # SID holds 12 calls 40 min ago (past the 30 min burn line); the other session holds an older burn.
        self.write_meter(40, resets_in=-60)
        self.register("SHARER")
        sid2, other = self.two_sessions()
        self.append(*[asst("a%d" % i, "q%d" % i, inp=mine // 12, when=-2400) for i in range(12)])
        self.append(*[asst("b%d" % i, "p%d" % i, inp=theirs // 10, when=-4.5 * 3600, sid=sid2) for i in range(10)], path=other)

    def test_share_limits_are_fifty_and_sixty_five_percent(self):
        self.assertEqual((watch.SHARE_WARN, watch.SHARE_RUN), (0.50, 0.65))

    def test_a_session_below_the_share_warn_line_raises_nothing(self):
        self.gated_share(60_000_000, 70_000_000)
        self.run_watch()
        s = self.run_watch()
        r = self.row(s)
        self.assertAlmostEqual(r["share"], 0.46, places=2)
        self.assertGreaterEqual(r["tok"], watch.WIN_GATE_SESSION)
        self.assertGreaterEqual(s["window"]["tokens"], watch.WIN_GATE_TOTAL)
        self.assertIsNone(r["level"])
        self.assertEqual(s["alerts"], [])

    def test_share_warns_from_fifty_percent_on_the_second_run(self):
        self.gated_share(72_000_000, 66_000_000)
        self.assertIsNone(self.row(self.run_watch())["level"])
        s = self.run_watch()
        self.assertEqual(self.row(s)["level"], "warn")
        self.assertEqual(s["alerts"][0]["why"], ["share 52% >= 50%"])

    def test_share_runs_away_from_sixty_five_percent_on_one_run(self):
        self.gated_share(120_000_000, 60_000_000)
        s = self.run_watch()
        self.assertEqual(self.row(s)["level"], "runaway")
        self.assertEqual(s["alerts"][0]["why"], ["share 67% >= 65%"])

    def test_share_lines_are_inclusive(self):
        self.gated_share(60_000_000, 60_000_000)
        self.run_watch()
        s = self.run_watch()
        self.assertEqual(self.row(s)["share"], 0.50)
        self.assertEqual(s["alerts"][0]["why"], ["share 50% >= 50%"])
        self.assertEqual(self.row(s)["level"], "warn")

    def test_share_runaway_line_is_inclusive(self):
        self.gated_share(78_000_000, 42_000_000)
        s = self.run_watch()
        self.assertEqual(self.row(s)["share"], 0.65)
        self.assertEqual(self.row(s)["level"], "runaway")

    def test_share_just_under_the_warn_line_raises_nothing(self):
        self.gated_share(58_800_000, 61_200_000)
        self.run_watch()
        s = self.run_watch()
        self.assertEqual(self.row(s)["share"], 0.49)
        self.assertIsNone(self.row(s)["level"])

    def test_share_text_is_built_from_the_constants(self):
        saved = watch.SHARE_WARN
        self.addCleanup(setattr, watch, "SHARE_WARN", saved)
        watch.SHARE_WARN = 0.40
        self.gated_share(60_000_000, 70_000_000)
        self.run_watch()
        self.assertEqual(self.run_watch()["alerts"][0]["why"], ["share 46% >= 40%"])

    def test_meter_alert_why_fits_the_doctrine_form(self):
        self.write_meter(95)
        self.append(asst("m1", "r1", inp=1))
        self.assertRegex(self.run_watch()["alerts"][0]["why"][0], r"^[a-zA-Z]+ [0-9]+[a-z%]* >= [0-9]+[a-z%]*$")

    # ---- pace: projected end of the 5h and weekly windows

    def pace_alerts(self, s):
        return [a for a in s["alerts"] if a["src"] == "pace"]

    def test_weekly_pace_past_its_line_raises_a_warn_alert_naming_no_session(self):
        self.write_meter(10, week_pct=70, week_resets_in=int(3.5 * 86400))  # 70% used at 50% gone: projects 140%
        self.append(asst("m1", "r1", inp=1))
        s = self.run_watch()
        a = self.pace_alerts(s)
        self.assertEqual(len(a), 1)
        self.assertEqual((a[0]["level"], a[0]["sid"], a[0]["addr"], a[0]["why"]), ("warn", None, False, ["weekpace 140% >= 90%"]))
        self.assertRegex(a[0]["why"][0], r"^[a-zA-Z]+ [0-9]+[a-z%]* >= [0-9]+[a-z%]*$")
        self.assertEqual(s["meter"]["seven_day"]["projectedEndPct"], 140)

    def test_five_hour_pace_past_its_line_raises_a_warn_alert(self):
        self.write_meter(50, resets_in=int(0.75 * 5 * 3600))  # 50% used at 25% gone: projects 200%
        self.append(asst("m1", "r1", inp=1))
        a = self.pace_alerts(self.run_watch())
        self.assertEqual([x["why"] for x in a], [["fivepace 200% >= 100%"]])

    def test_pace_inside_the_line_raises_nothing_but_is_reported(self):
        self.write_meter(10, week_pct=57, week_resets_in=int(0.26 * 7 * 86400))  # 57% at 74% gone: projects 77%
        self.append(asst("m1", "r1", inp=1))
        s = self.run_watch()
        self.assertEqual(self.pace_alerts(s), [])
        self.assertEqual((s["meter"]["seven_day"]["projectedEndPct"], s["meter"]["seven_day"]["paceState"]), (77, "ok"))

    def test_a_bad_pace_under_the_damper_raises_nothing(self):
        self.write_meter(10, week_pct=20, week_resets_in=int(0.85 * 7 * 86400))  # 20% at 15% gone: 133%, but under 25% used
        self.append(asst("m1", "r1", inp=1))
        s = self.run_watch()
        self.assertEqual(self.pace_alerts(s), [])
        self.assertEqual(s["meter"]["seven_day"]["paceState"], "watch")

    def test_a_stale_five_hour_reading_has_no_projection_and_raises_nothing(self):
        self.write_meter(50, resets_in=int(0.75 * 5 * 3600), observed_ago=3600)
        self.append(asst("m1", "r1", inp=1))
        s = self.run_watch()
        self.assertEqual(self.pace_alerts(s), [])
        self.assertEqual((s["meter"]["five_hour"]["projectedEndPct"], s["meter"]["five_hour"]["paceState"]), (None, "stale"))

    def test_the_week_is_gated_on_its_own_freshness(self):
        # five-hour fresh, weekly reading 7h old (past WEEK_FRESH_S): no weekly alert, state stale
        self.write_meter(10, week_pct=70, week_resets_in=int(3.5 * 86400), week_observed_ago=7 * 3600)
        self.append(asst("m1", "r1", inp=1))
        s = self.run_watch()
        self.assertEqual(self.pace_alerts(s), [])
        self.assertEqual((s["meter"]["seven_day"]["projectedEndPct"], s["meter"]["seven_day"]["paceState"]), (None, "stale"))

    def test_a_fresh_week_alerts_while_the_five_hour_reading_is_stale(self):
        self.write_meter(50, resets_in=int(0.75 * 5 * 3600), observed_ago=3600, week_pct=70,
                         week_resets_in=int(3.5 * 86400), week_observed_ago=60)
        self.append(asst("m1", "r1", inp=1))
        s = self.run_watch()
        self.assertEqual([a["why"] for a in self.pace_alerts(s)], [["weekpace 140% >= 90%"]])

    # ---- health, bounds, safety

    def test_quiet_runs_reset_drift_counter(self):
        drifted = {"type": "assistant", "timestamp": ts(), "message": {"id": "x", "model": "claude-opus-5-5", "tokens": {"in": 1}}}
        for i in range(2):
            self.append(dict(drifted, requestId="r%d" % i))
            self.run_watch()
        self.run_watch()
        self.append(dict(drifted, requestId="r9"))
        self.assertEqual(self.run_watch()["parseHealth"], "ok")
        self.append(asst("old", "o1", inp=1, when=-3 * 86400))
        self.assertEqual(self.run_watch()["parseHealth"], "ok")

    def test_errors_go_to_own_log(self):
        self.append(raw='{"type":"assistant","message":{broken\n')
        self.run_watch()
        self.assertIn("corrupt line", read(os.path.join(self.out, "watch.err")))

    def test_run_failure_is_logged_to_own_log(self):
        real = watch.atomic_write

        def fail(*a):
            raise OSError(28, "No space left on device")
        watch.atomic_write = fail
        try:
            rc = watch.main(["--config-dir", self.cfg, "--spool", self.spool, "--out-dir", self.out])
        finally:
            watch.atomic_write = real
        self.assertEqual(rc, 1)
        log = read(os.path.join(self.out, "watch.err"))
        self.assertIn("run failed: OSError", log)
        self.assertNotIn("No space", log)
        self.assertFalse(os.path.exists(os.path.join(self.out, "run.lock")))

    def test_schema_drift_degrades_after_three_runs(self):
        drifted = {"type": "assistant", "timestamp": ts(), "message": {"id": "x", "model": "claude-opus-5-5", "tokens": {"in": 1}}}
        for i in range(3):
            d = dict(drifted, requestId="r%d" % i)
            self.append(d)
            s = self.run_watch()
        self.assertEqual(s["parseHealth"], "degraded")

    def test_synthetic_only_runs_are_not_drift(self):
        for i in range(3):
            self.append(asst("m%d" % i, "r%d" % i, inp=0, model="<synthetic>"))
            s = self.run_watch()
        self.assertEqual(s["parseHealth"], "ok")

    def test_summary_bounded(self):
        for i in range(40):
            sid = "%08d-0000-0000-0000-000000000000" % i
            p = os.path.join(self.proj, sid + ".jsonl")
            self.append({"type": "custom-title", "customTitle": "N" * 80}, *self.burst(12, out=20_000_000, sid=sid), path=p)
        self.run_watch()
        self.run_watch()
        with open(os.path.join(self.out, "usage-summary.json"), "rb") as f:
            data = f.read()
        self.assertLessEqual(len(data), watch.SUMMARY_MAX_BYTES)
        s = json.loads(data)
        self.assertLessEqual(len(s["alerts"]), watch.ALERTS_MAX)
        self.assertLessEqual(len(s["top"]), watch.TOP_N + watch.EXTRA_LEVELED_MAX)

    def test_symlinks_are_not_followed(self):
        target = os.path.join(self.root, "victim.txt")
        with open(target, "w") as f:
            f.write("x" * 100_000)
        os.makedirs(self.out, mode=0o700)
        os.symlink(target, os.path.join(self.out, "watch.err"))
        os.symlink(target, os.path.join(self.proj, "22222222-0000-0000-0000-000000000000.jsonl"))
        self.append(asst("m1", "r1", inp=1))
        s = self.run_watch()
        self.assertEqual(os.path.getsize(target), 100_000)
        self.assertIsNone(self.row(s, "22222222-0000-0000-0000-000000000000"))

    def test_symlinked_out_dir_refused(self):
        real = os.path.join(self.root, "elsewhere")
        os.makedirs(real)
        os.makedirs(os.path.dirname(self.out))
        os.symlink(real, self.out)
        with self.assertRaises(SystemExit):
            watch.main(["--config-dir", self.cfg, "--spool", self.spool, "--out-dir", self.out])
        self.assertEqual(os.listdir(real), [])

    def test_lock_skips_fresh_and_clears_stale(self):
        lock = os.path.join(self.out, "run.lock")
        os.makedirs(lock)
        self.append(asst("m1", "r1", inp=1))
        watch.main(["--config-dir", self.cfg, "--spool", self.spool, "--out-dir", self.out])
        self.assertFalse(os.path.exists(os.path.join(self.out, "usage-summary.json")))
        os.utime(lock, (time.time() - 3600, time.time() - 3600))
        self.run_watch()
        self.assertFalse(os.path.exists(lock))

    def test_corrupt_state_rebuilds(self):
        self.append(asst("m1", "r1", inp=5))
        self.run_watch()
        with open(os.path.join(self.out, "state.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(self.row(self.run_watch())["tok"], 5)

    # ---- pace and meters.json

    def meters(self, *extra):
        self.run_watch(*extra)
        return json.loads(read(os.path.join(self.out, "meters.json")))

    def write_reading(self, fp, five=None, week=None, src=None):
        d = os.path.join(self.out, "limits")
        os.makedirs(d, exist_ok=True)
        doc = {"v": 1, "account": fp}
        now = time.time()
        if five is not None:
            doc["five_hour"] = {"used_percentage": five[0], "resets_at": now + five[1], "observed_at": now - five[2]}
            if src:
                doc["five_hour"]["src"] = src
        if week is not None:
            doc["seven_day"] = {"used_percentage": week[0], "resets_at": now + week[1], "observed_at": now - week[2]}
        with open(os.path.join(d, "readings-%s.json" % fp), "w") as f:
            json.dump(doc, f)

    def test_pace_matches_the_bash_vectors(self):
        here = os.path.dirname(os.path.abspath(__file__))
        paths = [os.path.join(here, "pace-vectors.tsv"), os.path.join(here, "..", "pace-vectors.tsv")]
        path = next((p for p in paths if os.path.exists(p)), None)
        self.assertIsNotNone(path, "tools/usage-watcher/pace-vectors.tsv (the pinned copy beside watch.py) is missing")
        colour = {"idle": 245, "ok": 245, "watch": 144, "warn": 131, "hot": 168}
        rows = 0
        for ln in read(path).splitlines():
            if ln.startswith("#") or not ln:
                continue
            used, el, warn, damp, col, over = ln.split("\t")
            proj, state = watch.pace(int(used), int(el), int(warn), int(damp))
            self.assertEqual((colour[state], "-" if proj is None else str(proj)), (int(col), over), ln)
            rows += 1
        self.assertGreater(rows, 6000)

    def test_pace_edges(self):
        self.assertEqual(watch.pace(0, 50, 100), (None, "idle"))
        self.assertEqual(watch.pace(30, 5, 100), (None, "idle"))
        self.assertEqual(watch.pace(30, 6, 100), (500, "hot"))
        self.assertEqual(watch.pace(24, 12, 100), (200, "watch"), "below the damper it never escalates")
        self.assertEqual(watch.pace(25, 12, 100), (208, "hot"))
        self.assertEqual(watch.pace(50, 50, 100), (100, "ok"))
        self.assertEqual(watch.pace(51, 50, 100), (102, "watch"))
        self.assertEqual(watch.pace(63, 50, 100), (126, "warn"))
        self.assertEqual(watch.pace(81, 50, 100), (162, "hot"))
        self.assertEqual(watch.pace(46, 50, 90), (92, "watch"))
        self.assertEqual(watch.elapsed_pct(18000, 1000 + 18000, 1000 + 4500), 25)
        self.assertEqual(watch.elapsed_pct(18000, 18000, 17999.9), 99)
        self.assertEqual(watch.elapsed_pct(18000, 18000, -5), 0)

    def test_meters_json_from_the_spool_fallback(self):
        self.write_meter(40, observed_ago=60)
        m = self.meters()
        self.assertEqual((m["v"], sorted(m["accounts"])), (1, ["abc123"]))
        five = m["accounts"]["abc123"]["fiveHour"]
        self.assertEqual((five["used"], five["fresh"], five["src"]), (40, True, "statusline"))
        self.assertEqual(five["windowEnd"] - five["windowStart"], watch.WINDOW_S)
        self.assertEqual(m["accounts"]["abc123"]["sevenDay"]["used"], 10)
        self.assertEqual(oct(os.stat(os.path.join(self.out, "meters.json")).st_mode & 0o777), "0o600")

    def test_meters_json_prefers_the_new_directory_for_an_account(self):
        self.write_meter(40, observed_ago=60)
        self.write_reading("abc123", five=(65, 7200, 30), src="mod")
        self.write_meter(20, path=os.path.join(self.spool, "limits", "personal-windows-def456.json"), observed_ago=60)
        a = self.meters()["accounts"]
        self.assertEqual((a["abc123"]["fiveHour"]["used"], a["abc123"]["fiveHour"]["src"]), (65, "mod"))
        self.assertEqual(a["def456"]["fiveHour"]["used"], 20)

    def test_meters_json_drops_past_windows_and_flags_stale_ones(self):
        self.write_reading("abc123", five=(40, 3600, 3600), week=(30, -60, 0))
        a = self.meters()["accounts"]["abc123"]
        self.assertFalse(a["fiveHour"]["fresh"])
        self.assertGreaterEqual(a["fiveHour"]["ageS"], 3600)
        self.assertIsNone(a["sevenDay"], "a weekly reset in the past is last week's number")

    def test_meters_json_weekly_freshness_is_hours_not_minutes(self):
        self.write_reading("abc123", week=(30, 86400, 3 * 3600))
        self.assertTrue(self.meters()["accounts"]["abc123"]["sevenDay"]["fresh"])
        self.write_reading("abc123", week=(30, 86400, 7 * 3600))
        self.assertFalse(self.meters()["accounts"]["abc123"]["sevenDay"]["fresh"])

    def test_meters_json_projection_and_hit_time(self):
        self.write_reading("abc123", five=(50, 13500, 0))
        w = self.meters()["accounts"]["abc123"]["fiveHour"]
        self.assertEqual((w["elapsedPct"], w["projectedEndPct"], w["state"]), (25, 200, "hot"))
        gen = json.loads(read(os.path.join(self.out, "meters.json")))["generatedAt"]
        self.assertEqual(w["hitsAt"], w["windowStart"] + (gen - w["windowStart"]) * 100 // 50)
        self.assertLess(w["hitsAt"], w["windowEnd"])
        self.write_reading("abc123", five=(10, 9000, 0))
        w = self.meters()["accounts"]["abc123"]["fiveHour"]
        self.assertEqual((w["projectedEndPct"], w["state"], w["hitsAt"]), (20, "ok", None))

    def test_meters_json_ignores_bad_files_and_unknown_sources(self):
        os.remove(self.meter)
        d = os.path.join(self.out, "limits")
        os.makedirs(d)
        with open(os.path.join(d, "readings-abc123.json"), "w") as f:
            f.write('{"five_hour":{"used_percentage":Infinity,"resets_at":1e300}}')
        with open(os.path.join(d, "readings-nothex.json"), "w") as f:
            f.write("{}")
        real = os.path.join(self.root, "elsewhere.json")
        with open(real, "w") as f:
            f.write('{"five_hour":{"used_percentage":5,"resets_at":%d}}' % (time.time() + 3600))
        os.symlink(real, os.path.join(d, "readings-def456.json"))
        self.assertEqual(self.meters()["accounts"], {})
        self.write_reading("abc123", five=(40, 3600, 0), src="bogus")
        self.assertEqual(self.meters()["accounts"]["abc123"]["fiveHour"]["src"], "statusline")

    def test_meters_json_survives_huge_numbers_and_deep_nesting(self):
        d = os.path.join(self.out, "limits")
        os.makedirs(d)
        with open(os.path.join(d, "readings-abc123.json"), "w") as f:
            f.write('{"five_hour":{"used_percentage":5,"resets_at":1%s}}' % ("0" * 400))
        with open(os.path.join(d, "readings-def456.json"), "w") as f:
            f.write("[" * 30000)
        with open(os.path.join(d, "readings-aaa111.json"), "w") as f:
            f.write(" " * 70000)
        self.write_reading("bbb222", five=(30, 3600, 0))
        self.write_meter(40, observed_ago=60)
        self.run_watch()
        a = json.loads(read(os.path.join(self.out, "meters.json")))["accounts"]
        self.assertEqual(sorted(a), ["bbb222"], "the bad files are skipped; abc123's file parsed, so the spool copy stays unused")
        self.assertTrue(os.path.exists(os.path.join(self.out, "usage-summary.json")))

    def test_meters_json_stale_reading_has_no_projection(self):
        self.write_reading("abc123", five=(80, 3600, 3 * 3600))
        w = self.meters()["accounts"]["abc123"]["fiveHour"]
        self.assertEqual((w["fresh"], w["state"], w["projectedEndPct"], w["hitsAt"]), (False, "stale", None, None))
        self.assertEqual(w["used"], 80)

    def test_meters_json_expired_new_reading_does_not_resurrect_the_spool_copy(self):
        self.write_meter(40, observed_ago=60)
        self.write_reading("abc123", five=(65, -60, 0))
        self.assertEqual(self.meters()["accounts"], {})

    def test_meters_json_unknown_observed_at_is_never_fresh_but_an_absent_one_uses_the_mtime(self):
        d = os.path.join(self.out, "limits")
        os.makedirs(d)
        doc = {"five_hour": {"used_percentage": 40, "resets_at": time.time() + 3600, "observed_at": -1}}
        with open(os.path.join(d, "readings-abc123.json"), "w") as f:
            json.dump(doc, f)
        w = self.meters()["accounts"]["abc123"]["fiveHour"]
        self.assertEqual((w["fresh"], w["state"], w["ageS"], w["projectedEndPct"], w["hitsAt"]),
                         (False, "stale", None, None, None), "a rewritten file's mtime must not make it look new")
        del doc["five_hour"]["observed_at"]
        with open(os.path.join(d, "readings-abc123.json"), "w") as f:
            json.dump(doc, f)
        w = self.meters()["accounts"]["abc123"]["fiveHour"]
        self.assertEqual((w["fresh"], w["state"]), (True, "ok"), "no observed_at at all: the file's mtime")

    def test_meters_json_does_not_block_on_a_fifo(self):
        import signal
        os.makedirs(os.path.join(self.out, "limits"))
        os.mkfifo(os.path.join(self.out, "limits", "readings-aaaaaa.json"))
        os.mkfifo(os.path.join(self.spool, "limits", "personal-windows-bbbbbb.json"))
        os.mkfifo(os.path.join(self.spool, "limits", "personal-windows-cccccc.json"))
        signal.signal(signal.SIGALRM, lambda *a: (_ for _ in ()).throw(AssertionError("blocked on a FIFO")))
        signal.alarm(10)
        try:
            m = self.meters()
        finally:
            signal.alarm(0)
        self.assertEqual(sorted(m["accounts"]), ["abc123"], "only the regular file counts")
        self.assertTrue(os.path.exists(os.path.join(self.out, "usage-summary.json")))

    def test_meters_json_without_any_reading_still_marks_the_watcher_alive(self):
        os.remove(self.meter)
        m = self.meters()
        self.assertEqual(m["accounts"], {})
        self.assertGreater(m["generatedAt"], 0)

    # ---- labelled accounts (AIT_ACCOUNT): per-account meters and sessions

    SID2 = "99999999-aaaa-bbbb-cccc-dddddddddddd"
    LAB_FP = "0123456789ab"

    def write_label(self, sid, label="second", raw=None):
        d = os.path.join(self.out, "accounts")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, sid + ".json"), "w") as f:
            f.write(raw if raw is not None else json.dumps({"v": 1, "label": label}))

    def write_labelled_reading(self, five=(10, 3600, 60), week=(8, 86400, 60), label="second", fp=None):
        fp = fp or self.LAB_FP
        self.write_reading(fp, five=five, week=week)
        path = os.path.join(self.out, "limits", "readings-%s.json" % fp)
        doc = json.loads(read(path))
        doc["label"] = label
        with open(path, "w") as f:
            json.dump(doc, f)

    def write_labelled_spool_file(self, label="second", fp=None):
        path = os.path.join(self.spool, "limits", "personal-windows-%s.json" % (fp or self.LAB_FP))
        self.write_meter(10, path=path, observed_ago=60, week_observed_ago=60)
        doc = json.loads(read(path))
        doc["label"] = label
        with open(path, "w") as f:
            json.dump(doc, f)

    def test_a_labelled_meter_file_is_not_the_main_meter(self):
        self.write_meter(40, observed_ago=60)
        self.write_labelled_spool_file()
        s = self.run_watch()
        self.assertEqual(s["meter"]["five_hour"]["pct"], 40, "two files used to leave the summary without a meter")
        self.assertTrue(s["meter"]["fresh"])
        os.remove(self.meter)
        self.assertIsNone(self.run_watch()["meter"], "a labelled file alone is nobody's main meter")

    def test_two_unlabelled_meter_files_still_leave_no_meter(self):
        self.write_meter(50, path=os.path.join(self.spool, "limits", "personal-windows-def456.json"))
        self.assertIsNone(self.run_watch()["meter"])

    def test_meters_json_names_a_labelled_account(self):
        self.write_labelled_reading()
        m = self.meters()
        self.assertEqual(m["accounts"][self.LAB_FP]["label"], "second")
        self.assertNotIn("label", m["accounts"]["abc123"])
        self.write_labelled_reading(label="Bad Label!")
        self.assertNotIn("label", self.meters()["accounts"][self.LAB_FP], "an invalid label is not carried")

    def test_summary_shows_each_labelled_account_beside_the_main_meter(self):
        self.write_meter(40, observed_ago=60, week_observed_ago=60)
        self.write_labelled_reading(five=(10, 3600, 60), week=(8, 86400, 60))
        s = self.run_watch()
        self.assertEqual(s["meter"]["seven_day"]["pct"], 10)
        (a,) = s["accounts"]
        self.assertEqual((a["label"], a["fresh"], a["weekFresh"]), ("second", True, True))
        self.assertEqual((a["five_hour"]["pct"], a["seven_day"]["pct"]), (10, 8))
        self.assertEqual(sorted(a["five_hour"]), ["paceState", "pct", "projectedEndPct", "resetsAt"])
        self.assertEqual(a["window"]["source"], "meter")

    def test_summary_without_a_labelled_account_is_unchanged(self):
        self.register("MAIN")
        self.append(*self.burst(3, out=1000))
        s = self.run_watch()
        self.assertNotIn("accounts", s)
        self.assertNotIn("acct", self.row(s))

    def test_a_session_label_marks_its_row_and_splits_the_shares(self):
        self.register("MAIN")
        self.append(*self.burst(3, out=1000))
        self.append(*[asst("s%d" % i, "q%d" % i, out=3000, when=prev_bucket(), sid=self.SID2) for i in range(3)],
                    path=os.path.join(self.proj, self.SID2 + ".jsonl"))
        s = self.run_watch()
        self.assertEqual((self.row(s)["share"], self.row(s, self.SID2)["share"]), (0.25, 0.75), "one account: shared quota")
        self.write_label(self.SID2)
        s = self.run_watch()
        main, second = self.row(s), self.row(s, self.SID2)
        self.assertEqual((main["share"], second["share"]), (1.0, 1.0), "each against its own account's window")
        self.assertEqual(second["acct"], "second")
        self.assertNotIn("acct", main)
        self.assertEqual(s["window"]["tokens"], main["tok"], "window.tokens stays the main account's")
        self.assertEqual(s["accounts"][0]["window"]["tokens"], second["tok"])

    def test_labelled_tokens_stay_out_of_the_main_window_and_opus_share(self):
        self.register("MAIN")
        self.append(*self.burst(3, out=1000))
        self.append(*[asst("s%d" % i, "q%d" % i, out=9000, when=prev_bucket(), sid=self.SID2, model="claude-sonnet-5-5")
                      for i in range(3)], path=os.path.join(self.proj, self.SID2 + ".jsonl"))
        self.write_label(self.SID2)
        s = self.run_watch()
        self.assertEqual(s["window"]["tokens"], 3000)
        self.assertEqual(s["window"]["opusShare"], 1.0)

    def test_the_meter_alert_never_names_a_labelled_burner(self):
        self.write_meter(95, observed_ago=60)
        self.append(*[asst("s%d" % i, "q%d" % i, out=10_000_000, when=prev_bucket(), sid=self.SID2) for i in range(12)],
                    path=os.path.join(self.proj, self.SID2 + ".jsonl"))
        self.register("SECOND", sid=self.SID2)
        s = self.run_watch()
        meter_alert = next(a for a in s["alerts"] if a["src"] == "meter")
        self.assertEqual(meter_alert["sid"], self.SID2, "unlabelled, it is the main account's burner")
        self.write_label(self.SID2)
        s = self.run_watch()
        meter_alert = next(a for a in s["alerts"] if a["src"] == "meter")
        self.assertIsNone(meter_alert["sid"], "the meter is the main account's, the burner is not")

    def test_label_files_must_be_small_regular_and_valid(self):
        self.write_label(self.SID2, raw=json.dumps({"label": "Bad Label"}))
        self.write_label("33333333-aaaa-bbbb-cccc-dddddddddddd", raw="x" * 5000)
        self.write_label("44444444-aaaa-bbbb-cccc-dddddddddddd", raw="not json")
        self.write_label("not-a-sid", label="second")
        real = os.path.join(self.root, "real.json")
        with open(real, "w") as f:
            f.write(json.dumps({"label": "second"}))
        os.symlink(real, os.path.join(self.out, "accounts", "55555555-aaaa-bbbb-cccc-dddddddddddd.json"))
        old = "66666666-aaaa-bbbb-cccc-dddddddddddd"
        self.write_label(old)
        past = time.time() - watch.LABEL_FILE_KEEP_S - 3600
        os.utime(os.path.join(self.out, "accounts", old + ".json"), (past, past))
        self.write_label("77777777-aaaa-bbbb-cccc-dddddddddddd")
        self.assertEqual(watch.read_labels(self.out, time.time()), {"77777777-aaaa-bbbb-cccc-dddddddddddd": "second"})
        self.assertEqual(watch.read_labels(os.path.join(self.root, "nowhere"), time.time()), {})

    def over_cap_summary(self, **extra):
        s = {"v": 5, "meter": {"fresh": True}, "window": {"tokens": 1}, "accounts": [{"label": "second"}],
             "alerts": [{"sid": "a%d" % i, "pad": "x" * 100} for i in range(3)],
             "cacheExpiring": [{"sid": "c%d" % i, "pad": "x" * 100} for i in range(3)],
             "compactSoon": [{"sid": "s%d" % i, "pad": "x" * 100} for i in range(3)],
             "top": [{"sid": "t%d" % i, "pad": "x" * 300} for i in range(12)]}
        s.update(extra)
        return s

    def test_top_rows_go_before_the_accounts_display(self):
        s = self.over_cap_summary()
        out = json.loads(watch.dump_bounded(s))
        self.assertEqual(out["accounts"], [{"label": "second"}], "the second account's meter outranks a low top row")
        self.assertLess(len(out["top"]), 12)
        self.assertEqual(len(out["alerts"]), 3)
        self.assertEqual(len(out["cacheExpiring"]), 3)
        self.assertEqual(len(out["compactSoon"]), 3)
        self.assertEqual(out["dropped"], ["top"])
        self.assertTrue(out["truncated"])
        self.assertNotIn("accountsDropped", out)

    def test_drop_order_is_top_compact_cache_accounts_then_alerts(self):
        base = len(json.dumps(self.over_cap_summary(), separators=(",", ":")).encode())
        seen = []
        for cap in range(base, 200, -40):
            real = watch.SUMMARY_MAX_BYTES
            watch.SUMMARY_MAX_BYTES = cap
            try:
                out = json.loads(watch.dump_bounded(self.over_cap_summary()))
            finally:
                watch.SUMMARY_MAX_BYTES = real
            seen.append(out.get("dropped", []))
            if cap >= 600:
                self.assertLessEqual(len(json.dumps(out, separators=(",", ":")).encode()), cap)
        order = ["top", "compactSoon", "cacheExpiring", "accounts", "alerts"]
        for names in seen:
            self.assertEqual(names, order[:len(names)], "a section is cut only after every earlier one is cut")
        self.assertEqual(seen[-1], order)

    def test_every_dropped_section_is_named(self):
        real = watch.SUMMARY_MAX_BYTES
        watch.SUMMARY_MAX_BYTES = 480
        try:
            out = json.loads(watch.dump_bounded(self.over_cap_summary()))
        finally:
            watch.SUMMARY_MAX_BYTES = real
        self.assertNotIn("accounts", out)
        self.assertTrue(out["accountsDropped"])
        self.assertIn("accounts", out["dropped"])
        self.assertEqual(out["top"], [])
        self.assertEqual(out["compactSoon"], [])
        self.assertEqual(out["cacheExpiring"], [])
        self.assertEqual(out["meter"], {"fresh": True})
        self.assertEqual(out["window"], {"tokens": 1})
        for name in ("top", "compactSoon", "cacheExpiring"):
            self.assertIn(name, out["dropped"])

    def test_alerts_survive_until_everything_else_is_gone(self):
        real = watch.SUMMARY_MAX_BYTES
        watch.SUMMARY_MAX_BYTES = 480
        try:
            out = json.loads(watch.dump_bounded(self.over_cap_summary()))
        finally:
            watch.SUMMARY_MAX_BYTES = real
        self.assertTrue(out["alerts"])
        self.assertLess(len(out["alerts"]), 3)
        self.assertEqual(out["dropped"][-1], "alerts")
        self.assertNotIn("accounts", out)
        self.assertEqual(out["top"], [])

    def test_nothing_is_marked_when_the_summary_fits(self):
        out = json.loads(watch.dump_bounded({"v": 5, "accounts": [{"label": "second"}], "alerts": [],
                                             "cacheExpiring": [], "compactSoon": [], "top": [{"sid": "a"}]}))
        self.assertNotIn("dropped", out)
        self.assertNotIn("truncated", out)
        self.assertIn("accounts", out)

    def test_label_cap_counts_only_usable_files_and_keeps_the_newest(self):
        d = os.path.join(self.out, "accounts")
        os.makedirs(d)
        now = time.time()
        past = now - watch.LABEL_FILE_KEEP_S - 3600
        for i in range(watch.LABEL_FILES_MAX + 5):  # old files and temp files that sort before every live sid
            sid = "00000000-0000-0000-0000-%012d" % i
            self.write_label(sid)
            os.utime(os.path.join(d, sid + ".json"), (past, past))
            open(os.path.join(d, ".stamp.%06d" % i), "w").close()
        live = "ffffffff-0000-0000-0000-000000000001"
        self.write_label(live)
        self.assertEqual(watch.read_labels(self.out, now), {live: "second"}, "stale files must not fill the cap")
        for i in range(watch.LABEL_FILES_MAX + 3):  # now more usable files than the cap: the newest win
            sid = "11111111-0000-0000-0000-%012d" % i
            self.write_label(sid)
            os.utime(os.path.join(d, sid + ".json"), (now - 3000 + i, now - 3000 + i))
        got = watch.read_labels(self.out, now)
        self.assertEqual(len(got), watch.LABEL_FILES_MAX)
        self.assertIn(live, got)
        self.assertIn("11111111-0000-0000-0000-%012d" % (watch.LABEL_FILES_MAX + 2), got)

    def test_a_label_with_a_trailing_newline_is_not_a_label(self):
        self.assertIsNone(watch.valid_label("second\n"))
        self.assertEqual(watch.valid_label("second"), "second")
        self.write_label(self.SID2, raw=json.dumps({"label": "second\n"}))
        self.assertEqual(watch.read_labels(self.out, time.time()), {})
        self.write_labelled_reading(label="second\n")
        self.assertNotIn("label", self.meters()["accounts"][self.LAB_FP])

    def test_a_huge_meter_file_is_not_parsed_for_a_label(self):
        path = os.path.join(self.spool, "limits", "personal-windows-def456.json")
        with open(path, "w") as f:
            f.write('{"label":"second","pad":"' + "x" * (watch.READING_MAX_BYTES + 10) + '"}')
        self.assertFalse(watch.labelled_file(path), "an oversize file is not read, so it is not a labelled account")
        small = os.path.join(self.spool, "limits", "personal-windows-abcdef.json")
        with open(small, "w") as f:
            f.write('{"label":"second"}')
        self.assertTrue(watch.labelled_file(small))

    def test_alerts_cache_and_compact_soon_name_the_account_of_a_labelled_session(self):
        self.register("MAIN")
        self.append(asst("a1", "q1", cr=300_000, out=500, when=-120))
        self.register("SECOND", sid=self.SID2, pid=os.getppid())
        self.append(*[asst("s%d" % i, "q%d" % i, out=10_000_000, when=prev_bucket(), sid=self.SID2) for i in range(12)],
                    asst("c1", "r1", cr=300_000, out=5_000, when=-120 * 60, sid=self.SID2),
                    asst("c2", "r2", cr=300_000, out=3, when=-45 * 60, sid=self.SID2),
                    asst("c3", "r3", cr=300_000, out=500, when=-30, sid=self.SID2),
                    path=os.path.join(self.proj, self.SID2 + ".jsonl"))
        s = self.run_watch()
        self.assertTrue(all("acct" not in a for a in s["alerts"] + s["compactSoon"] + s["cacheExpiring"]))
        self.write_label(self.SID2)
        s = self.run_watch()
        second = [a for a in s["alerts"] if a["sid"] == self.SID2]
        self.assertTrue(second and all(a["acct"] == "second" for a in second))
        self.assertEqual([c["acct"] for c in s["compactSoon"] if c["sid"] == self.SID2], ["second"])
        self.assertTrue(all("acct" not in c for c in s["compactSoon"] if c["sid"] == SID), "the main account's entry is unchanged")
        self.assertTrue(all("acct" not in a for a in s["alerts"] if a["sid"] != self.SID2))

    def test_a_label_file_that_is_a_directory_does_not_fail_the_run(self):
        self.write_labelled_reading()
        self.write_label(SID)
        os.makedirs(os.path.join(self.out, "accounts", "11111111-0000-0000-0000-000000000000.json"))
        self.assertEqual(self.run_watch()["v"], 5)


if __name__ == "__main__":
    unittest.main()
