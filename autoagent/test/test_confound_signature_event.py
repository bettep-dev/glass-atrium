"""Behavioral tests for the attribution-confound signature event (R6).

"Patches applied, budget-overage rate unchanged" is the observable consequence of
a signal that cannot name its actor, and today it is undetectable from inside the
loop. R6 computes it per agent and emits it as a loop event.

Three properties carry the risk and each is pinned here rather than asserted in a
comment:

* **The row shape is the sibling detector's, verified not assumed.** The event
  table has no text payload and one decimal column, so the verdict rides the row
  (distinct, inside the 32-character column) while both rates ride the daemon log
  line — exactly what the post-apply regression detector already does.
* **Ambiguity emits NOTHING.** An unreadable input is an outage, never "the rate
  did not move"; a detector that fabricates on a failed read manufactures the
  very evidence it exists to collect.
* **Detection-only, so no lockout is reachable.** The only write is the loop
  event: no pattern transition, no proposal-status mutation, no gate.

Every test here is DATABASE-FREE: the CI python leg provisions no database, and a
skip-only class reports as a pass. Fixtures are frozen in-repo tuples.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_confound_signature_event.py -v
    python3 -m unittest autoagent.test.test_confound_signature_event -v

CID: 2026-07-31T1530_loopexec_a4f6
"""

from __future__ import annotations

import contextlib
import importlib
import io
import os
import re
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — import failure → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


# ---------------------------------------------------------------------------
# FROZEN FIXTURES
# ---------------------------------------------------------------------------

_SHELL = "glass-atrium-dev-shell"
_REACT = "glass-atrium-dev-react"

_NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)
# One apply, 7 days back: the post window spans 7 full days of observation.
_APPLIED_TS = _NOW - timedelta(days=7)
_POST_SPAN_DAYS = 7.0


def _applied(agent: str, applied_ts: datetime = _APPLIED_TS) -> tuple:
    """One core.autoagent_proposals row in the confound read's projection order."""
    return (agent, applied_ts)


def _overages(agent: str, pre: int, post: int) -> list[tuple]:
    """(agent_type, ts) rows: `pre` in the 14 days before the apply, `post` after."""
    rows = [(agent, _APPLIED_TS - timedelta(days=k)) for k in range(1, pre + 1)]
    rows += [
        (agent, _APPLIED_TS + timedelta(days=k, hours=-1)) for k in range(1, post + 1)
    ]
    return rows


@contextlib.contextmanager
def _capture_stderr():
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        yield buf


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class SignatureDetectionTest(unittest.TestCase):
    """The signature fires on "applied, unchanged" and stays silent on success."""

    def test_when_patches_applied_and_rate_flat_then_signature_fires(self):
        # 14 pre rows over the 14-day pre window and 7 post rows over 7 days:
        # 1.000/day on both sides — the confound, exactly.
        found = dc.find_confound_signatures(
            [_applied(_SHELL)], _overages(_SHELL, 14, 7), now=_NOW
        )
        self.assertEqual(len(found), 1)
        signature = found[0]
        self.assertEqual(signature.agent, _SHELL)
        self.assertEqual(signature.event_ts, _APPLIED_TS)
        self.assertEqual(signature.applied_count, 1)
        self.assertAlmostEqual(signature.pre_rate, 1.0)
        self.assertAlmostEqual(signature.post_rate, 7 / _POST_SPAN_DAYS)

    def test_when_rate_fell_materially_then_no_signature(self):
        # 1.000/day → 0.429/day: a real reduction, so the signature must not fire.
        found = dc.find_confound_signatures(
            [_applied(_SHELL)], _overages(_SHELL, 14, 3), now=_NOW
        )
        self.assertEqual(found, ())

    def test_when_drop_below_material_threshold_then_signature_fires(self):
        # 1.000/day → 0.857/day is a 14% drop, under the 20% materiality bar.
        found = dc.find_confound_signatures(
            [_applied(_SHELL)], _overages(_SHELL, 14, 6), now=_NOW
        )
        self.assertEqual(len(found), 1)

    def test_when_no_patch_applied_then_no_signature(self):
        found = dc.find_confound_signatures([], _overages(_SHELL, 14, 7), now=_NOW)
        self.assertEqual(found, ())

    def test_when_agent_had_no_prior_overage_then_no_signature(self):
        # Nothing to reduce → the signature would be meaningless, not merely noisy.
        found = dc.find_confound_signatures(
            [_applied(_SHELL)], _overages(_SHELL, 0, 7), now=_NOW
        )
        self.assertEqual(found, ())

    def test_when_post_window_too_short_then_no_signature(self):
        fresh = _NOW - timedelta(hours=6)
        rows = [(_SHELL, fresh - timedelta(days=k)) for k in range(1, 15)]
        found = dc.find_confound_signatures([(_SHELL, fresh)], rows, now=_NOW)
        self.assertEqual(found, ())

    def test_when_one_agent_confounded_then_other_agents_untouched(self):
        rows = _overages(_SHELL, 14, 7) + _overages(_REACT, 14, 1)
        found = dc.find_confound_signatures(
            [_applied(_SHELL), _applied(_REACT)], rows, now=_NOW
        )
        self.assertEqual([s.agent for s in found], [_SHELL])

    def test_when_agent_key_forms_differ_then_still_matched(self):
        # The overage row carries the bare form the roster resolves to the same
        # agent; exact-string narrowing would silently report a zero pre-rate.
        bare = _SHELL.removeprefix("glass-atrium-")
        found = dc.find_confound_signatures(
            [_applied(_SHELL)], _overages(bare, 14, 7), now=_NOW
        )
        self.assertEqual(len(found), 1)


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class EventRowShapeTest(unittest.TestCase):
    """The verdict rides the row; the rates ride the log line (Decision 6)."""

    def setUp(self) -> None:
        self.emitted: list[dict] = []
        patcher = mock.patch.object(
            dc, "_invoke_pg_helper", side_effect=self.emitted.append
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        for name, value in (
            ("_fetch_applied_for_confound", [_applied(_SHELL)]),
            ("_fetch_overage_rows", _overages(_SHELL, 14, 7)),
        ):
            p = mock.patch.object(dc, name, lambda v=value: v)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True)
        p.start()
        self.addCleanup(p.stop)
        # create=True: _pg_connect is a CONDITIONAL import (daemon_cycle try-block
        # alias, unbound when psycopg is absent — the CI condition). This probe
        # asserts the detector never opens a cursor, so patching the name into
        # existence keeps the assertion RUNNING PG-less rather than skipping it.
        self.pg_connect = mock.patch.object(dc, "_pg_connect", create=True).start()
        self.addCleanup(mock.patch.stopall)

    def _run(self) -> str:
        with _capture_stderr() as err:
            dc.alert_attribution_confound(now=_NOW)
        return err.getvalue()

    def test_when_signature_fires_then_verdict_is_distinct_and_fits_column(self):
        self._run()
        self.assertEqual(len(self.emitted), 1)
        args = self.emitted[0]["args"]
        self.assertEqual(args["eval_result"], dc.CONFOUND_SIGNATURE_EVAL_RESULT)
        self.assertNotEqual(
            dc.CONFOUND_SIGNATURE_EVAL_RESULT, dc.POST_APPLY_REGRESSION_EVAL_RESULT
        )
        # eval_result is VARCHAR(32); a longer verdict is a write-time failure.
        self.assertLessEqual(len(dc.CONFOUND_SIGNATURE_EVAL_RESULT), 32)

    def test_when_signature_fires_then_row_matches_sibling_shape(self):
        self._run()
        args = self.emitted[0]["args"]
        self.assertEqual(args["agent"], _SHELL)
        self.assertEqual(args["changes_added"], 0)
        self.assertEqual(args["changes_removed"], 0)
        self.assertIsNone(args["rice"])

    def test_when_rerun_then_dedup_key_is_identical(self):
        # event_ts is the apply timestamp, so the (event_ts, agent, eval_result)
        # UPSERT key lands a re-run on the SAME row.
        self._run()
        self._run()
        keys = [
            (env["args"]["event_ts"], env["args"]["agent"], env["args"]["eval_result"])
            for env in self.emitted
        ]
        self.assertEqual(len(keys), 2)
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(keys[0][0], _APPLIED_TS.isoformat())

    def test_when_signature_fires_then_both_rates_parseable_on_log_line(self):
        err = self._run()
        rates = re.search(r"pre=([0-9.]+) → post=([0-9.]+)", err)
        self.assertIsNotNone(rates, err)
        self.assertAlmostEqual(float(rates.group(1)), 1.0, places=3)
        self.assertAlmostEqual(float(rates.group(2)), 1.0, places=3)
        self.assertIn(f"agent={_SHELL}", err)

    def test_when_signature_fires_then_only_write_is_the_loop_event(self):
        self._run()
        self.assertEqual(
            {env.get("op") for env in self.emitted}, {"write_autoagent_loop_event"}
        )
        self.pg_connect.assert_not_called()


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class AmbiguityEmitsNothingTest(unittest.TestCase):
    """An outage is never "the rate did not move" — and never a lockout."""

    def test_when_read_unavailable_then_no_signature(self):
        self.assertEqual(dc.find_confound_signatures(None, [], now=_NOW), ())
        self.assertEqual(dc.find_confound_signatures([], None, now=_NOW), ())

    def test_when_timestamp_unparseable_then_that_agent_is_skipped(self):
        found = dc.find_confound_signatures(
            [(_SHELL, "not-a-timestamp")], _overages(_SHELL, 14, 7), now=_NOW
        )
        self.assertEqual(found, ())

    def test_when_read_outage_then_no_event_and_loud_skip(self):
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), mock.patch.object(
            dc, "_fetch_applied_for_confound", lambda: None
        ), mock.patch.object(
            dc, "_fetch_overage_rows", lambda: []
        ), mock.patch.object(
            dc, "_invoke_pg_helper"
        ) as emit:
            with _capture_stderr() as err:
                dc.alert_attribution_confound(now=_NOW)
        emit.assert_not_called()
        self.assertIn("SKIPPED", err.getvalue())

    def test_when_signature_fires_then_nothing_is_excluded_or_terminalized(self):
        # The lockout pin: this detector owns no gate and no transition. It is
        # pinned by call, not by comment.
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), mock.patch.object(
            dc, "_fetch_applied_for_confound", lambda: [_applied(_SHELL)]
        ), mock.patch.object(
            dc, "_fetch_overage_rows", lambda: _overages(_SHELL, 14, 7)
        ), mock.patch.object(
            dc, "_invoke_pg_helper"
        ), mock.patch.object(
            dc, "_pg_discharge_learning_pattern"
        ) as discharge, mock.patch.object(
            # create=True: conditional import, unbound when psycopg is absent.
            dc,
            "_pg_reject_learning_pattern",
            create=True,
        ) as reject:
            with _capture_stderr():
                dc.alert_attribution_confound(now=_NOW)
        discharge.assert_not_called()
        reject.assert_not_called()


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class WindowConstantTest(unittest.TestCase):
    """The observation window is its own constant, on the file's env convention."""

    def test_when_constant_read_by_name_then_defaults_to_14_days(self):
        self.assertEqual(dc.CONFOUND_WINDOW_ENV, "AUTOAGENT_CONFOUND_WINDOW_DAYS")
        self.assertEqual(dc.CONFOUND_WINDOW_DAYS, 14)

    def test_when_env_override_set_then_window_constant_honours_it(self):
        try:
            with mock.patch.dict(os.environ, {dc.CONFOUND_WINDOW_ENV: "3"}):
                importlib.reload(dc)
                self.assertEqual(dc.CONFOUND_WINDOW_DAYS, 3)
        finally:
            importlib.reload(dc)
        self.assertEqual(dc.CONFOUND_WINDOW_DAYS, 14)


if __name__ == "__main__":
    unittest.main()
