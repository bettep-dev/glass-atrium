"""Behavioral tests for the per-channel weekly done_with_concerns share alarm.

The emitter-criterion incident doubled both writer channels' weekly DWC share on
an unchanged workload and stayed invisible for weeks, because the existing watch
is keyed per applied proposal / per agent while the cause was one contract-text
change affecting every writer at once. The properties pinned here are the ones
that decide whether the watch would have caught it:

* **A week-over-week doubling fires.** The relative term is the one that catches
  a step on an otherwise normal-looking rate — before it reaches any absolute
  floor.
* **A flat rate fires nothing.** A watch that alarms on a steady channel is a
  watch operators stop reading.
* **Thin weeks are not rates.** A denominator below the floor is excluded from
  both the current test and the trailing mean.
* **The verdict token is its own.** Reusing the post-apply token would route a
  detection-only channel observation into the proposal-application gate.

Every test here is DATABASE-FREE: the pure trigger takes row dicts, and no PG
surface is touched.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_dwc_share_alarm.py -v
    python3 -m unittest autoagent.test.test_dwc_share_alarm -v

CID: 2026-08-09T1755_dwc-fix-impl_c9d1
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

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

_CHANNEL = "structuredoutput-completion"
# Thursday — mid-week, so the current bucket is partial exactly as it is live.
_NOW = datetime(2026, 8, 6, 12, 0, 0, tzinfo=timezone.utc)
_WEEK_TOTAL = 20


def _week_rows(weeks_back: int, dwc: int, total: int = _WEEK_TOTAL) -> list[dict]:
    """`total` outcome rows in the bucket `weeks_back` weeks before now, `dwc` of
    them done_with_concerns."""
    stamp = _NOW - timedelta(weeks=weeks_back, hours=1)
    return [
        {
            "attribution_source": _CHANNEL,
            "record_ts": stamp,
            "result": "done_with_concerns" if index < dwc else "done",
        }
        for index in range(total)
    ]


def _trailing(dwc_per_week: int) -> list[dict]:
    """Four trailing weeks at a constant share."""
    rows: list[dict] = []
    for weeks_back in range(1, 5):
        rows.extend(_week_rows(weeks_back, dwc_per_week))
    return rows


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class DwcShareAlarmTest(unittest.TestCase):
    def test_week_over_week_doubling_raises_the_alarm(self):
        # 10% trailing → 20% current: doubling, still under the absolute floor.
        rows = _trailing(2) + _week_rows(0, 4)

        alarms = dc.find_dwc_share_alarms(rows, now=_NOW)

        self.assertEqual(len(alarms), 1, alarms)
        alarm = alarms[0]
        self.assertEqual(alarm.channel, _CHANNEL)
        self.assertEqual(alarm.trigger, "relative")
        self.assertAlmostEqual(alarm.share, 0.20)
        self.assertAlmostEqual(alarm.baseline, 0.10)
        self.assertEqual((alarm.dwc, alarm.total), (4, _WEEK_TOTAL))

    def test_flat_rate_raises_nothing(self):
        rows = _trailing(2) + _week_rows(0, 2)

        self.assertEqual(dc.find_dwc_share_alarms(rows, now=_NOW), ())

    def test_thin_current_week_is_not_a_rate(self):
        # 2 of 3 rows = 67%, over both thresholds — and below the denominator floor.
        rows = _trailing(2) + _week_rows(0, 2, total=3)

        self.assertEqual(dc.find_dwc_share_alarms(rows, now=_NOW), ())

    def test_absolute_floor_fires_without_a_trailing_baseline(self):
        rows = _week_rows(0, 8)  # 40%, no trailing history at all

        alarms = dc.find_dwc_share_alarms(rows, now=_NOW)

        self.assertEqual([alarm.trigger for alarm in alarms], ["absolute"])

    def test_verdict_token_is_distinct_from_the_regression_gate_token(self):
        self.assertNotEqual(
            dc.DWC_SHARE_ALARM_EVAL_RESULT, dc.POST_APPLY_REGRESSION_EVAL_RESULT
        )
        self.assertLessEqual(len(dc.DWC_SHARE_ALARM_EVAL_RESULT), dc.EVAL_RESULT_MAX_LEN)


if __name__ == "__main__":
    unittest.main()
